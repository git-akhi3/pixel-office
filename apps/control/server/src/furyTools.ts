// The tools Fury has: the same Pipeline calls the board and the old Slack commands used, offered
// as tools. They are built per message, for that message's sender.
//
// Permissions are enforced here, not asked of the model: an assistant's turn is never given the
// owner-only tools, and each of those handlers checks the sender again before it does anything.

import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from './db/index.js';
import { schema } from './db/index.js';
import { isAgentStep, stepRole, type GateDecision } from './domain.js';
import type { DeskTool } from './fury.js';
import { heroByName, heroForRole, heroList } from './heroes.js';
import type { Pipeline } from './pipeline.js';
import { listRepos } from './repos.js';
import { describeTask, listActive, type StatusContext } from './slackStatus.js';

export type Sender = 'owner' | 'assistant';

/** What the Slack bridge does for tools: things that need the thread, the message's files or the rate limit. */
export interface DeskHost {
  startTask(a: { repo?: string; request: string; lane: 'solo' | 'standard' | 'auto'; refRepos: string[]; links: string[] }): Promise<string>;
  reviewPr(url: string): Promise<string>;
  /** The next thing this role's agent says on the task is posted in the thread under the hero's name. */
  expectHeroReply(taskId: number, role: string): void;
}

export interface DeskToolContext {
  sender: Sender;
  db: Db;
  pipeline: Pipeline;
  status: StatusContext;
  host: DeskHost;
}

function def<S extends z.ZodRawShape>(name: string, description: string, shape: S, run: (args: z.infer<z.ZodObject<S>>) => Promise<string> | string): DeskTool {
  return { name, description, shape, run: async (args) => run(z.object(shape).parse(args)) };
}

const taskId = z.number().int().describe('The task number, e.g. 12 for #12.');

/** Names of the tools only the owner is given. */
export const OWNER_ONLY_TOOLS = ['answer_question', 'briefing_action', 'approve', 'reject', 'discard', 'done', 'replan'] as const;

export function buildDeskTools(ctx: DeskToolContext): DeskTool[] {
  const { db, pipeline, status, host } = ctx;
  // Checked again inside every owner-only handler, whatever the tool list says.
  const owner = (what: string) => {
    if (ctx.sender !== 'owner') throw new Error(`Only the owner can ${what}. Tell them it needs the owner.`);
  };
  const task = (id: number) => pipeline.getTask(id);

  const shared: DeskTool[] = [
    def('list_repos', 'The repos the office can work on.', {}, () => {
      const repos = listRepos(db);
      return repos.length ? repos.map((r) => `${r.name} (branch ${r.defaultBranch})`).join('\n') : 'No repos are registered yet. The owner adds them on the board under Repos.';
    }),

    def('list_tasks', 'Every task that is not finished, one line each, with what is waiting on the owner.', {}, () => listActive(status)),

    def('task_status', "One task in detail: step, the hero working on it, time spent, what is waiting on the owner, blockers, the latest events, the PR link and the ETA. Use it for any question about a task or a hero's work. Report the ETA as given.", { task: taskId }, ({ task: id }) =>
      describeTask(task(id), status),
    ),

    def(
      'start_task',
      "Starts a task from the owner's request. Files attached to the Slack message are attached to it. Its updates appear in this thread.",
      {
        repo: z.string().optional().describe('A registered repo name; may be left out only when exactly one repo is registered.'),
        request: z.string().min(1).describe('What to build or fix, with the why, what done looks like and any constraints, all from the message.'),
        lane: z.enum(['solo', 'standard', 'auto']).default('auto').describe('solo: one all-rounder builds it. standard: the full team plans first. auto: the manager decides.'),
        ref_repos: z.array(z.string()).max(3).default([]).describe('Other registered repos the agents may read but never change.'),
        links: z.array(z.string()).default([]).describe('Links from the message the team should read.'),
      },
      (a) => host.startTask({ repo: a.repo, request: a.request, lane: a.lane, refRepos: a.ref_repos, links: a.links }),
    ),

    def('review_pr', 'Starts a review of a pull request from a GitHub link. The draft review is posted here for the owner to approve.', { url: z.string().describe('The https://github.com/<owner>/<repo>/pull/<n> link.') }, ({ url }) => host.reviewPr(url)),

    def(
      'steer',
      "Passes the owner's instruction to a hero. If that hero is working on the task now, it reaches them live. If not, it is kept for their next run. Leave hero out to steer whoever is working.",
      {
        task: taskId,
        hero: z.string().optional().describe(`A hero by name: ${heroList()}.`),
        note: z.string().min(1).describe("The instruction, in the owner's words."),
      },
      ({ task: id, hero: heroName, note }) => {
        const t = task(id);
        const hero = heroName ? heroByName(heroName) : undefined;
        if (heroName && !hero) throw new Error(`No hero called "${heroName}". The team: ${heroList()}.`);
        const running = isAgentStep(t.status) && pipeline.isRunning(id);
        const current = running ? stepRole(t.status, t) : undefined;
        if (!hero || hero.role === current) {
          const name = heroForRole(current ?? '')?.name ?? 'the team';
          const where = pipeline.steer(id, note, ctx.sender === 'owner' ? 'owner' : 'assistant');
          if (where === 'live' && current) host.expectHeroReply(id, current);
          return where === 'live' ? `Sent to ${name} now; their next words will be posted here.` : `Nobody I can reach is working on #${id} right now, so it is saved for the next step.`;
        }
        // Not working: leave the note for their next run, without interrupting whoever is.
        pipeline.leaveNote(id, `Meant for ${hero.name} (${hero.role}): ${note}`, ctx.sender === 'owner' ? 'owner' : 'assistant');
        return `${hero.name} isn't working on #${id} right now${current ? ` (${heroForRole(current)?.name ?? current} is)` : ''}. The note is saved for the next step of the task, whoever does it, marked as meant for ${hero.name}.`;
      },
    ),

    def('pause', 'Pauses a task (it stops; the worktree is kept and it can be resumed).', { task: taskId }, async ({ task: id }) => {
      await pipeline.action(id, 'stop');
      return `Paused #${id}. Resume it any time.`;
    }),
    def('stop', 'Stops a task (the worktree is kept and it can be resumed).', { task: taskId }, async ({ task: id }) => {
      await pipeline.action(id, 'stop');
      return `Stopped #${id}. Resume it any time.`;
    }),
    def('resume', 'Resumes a stopped, paused or blocked task.', { task: taskId }, async ({ task: id }) => {
      await pipeline.action(id, 'resume');
      return `Resumed #${id}.`;
    }),
  ];
  if (ctx.sender !== 'owner') return shared;

  const ownerTools: DeskTool[] = [
    def(
      'answer_question',
      "Answers the architect's open briefing question for the owner.",
      {
        question: z.number().int().describe('The question id from the message header or task_status.'),
        answer: z.string().optional().describe("The owner's own answer, in their words."),
        choice: z.enum(['recommended', 'you_decide']).optional().describe("recommended: lock in the architect's recommendation. you_decide: leave it to the architect."),
      },
      ({ question, answer, choice }) => {
        owner("answer the architect's questions");
        const q = db.select().from(schema.questions).where(eq(schema.questions.id, question)).get();
        if (!q) throw new Error('That question no longer exists.');
        if (q.answer !== null || q.delegated) throw new Error('That question is already answered.');
        if (choice === 'you_decide') pipeline.answerQuestion(q.id, { delegate: true }, 'slack');
        else if (choice === 'recommended') {
          if (!q.recommended) throw new Error('This question has no recommendation.');
          pipeline.answerQuestion(q.id, { text: q.recommended }, 'slack');
        } else if (answer?.trim()) pipeline.answerQuestion(q.id, { text: answer.trim() }, 'slack');
        else throw new Error('Give the owner\'s answer, or choose recommended or you_decide.');
        return `Answered "${q.title}".`;
      },
    ),

    def(
      'briefing_action',
      "During the architect's questions: send what the owner has answered so far, or say that is enough and let the architect go ahead.",
      { task: taskId, action: z.enum(['send', 'enough']) },
      ({ task: id, action }) => {
        owner('end the architect\'s questions');
        pipeline.briefingAction(id, action);
        return action === 'send' ? 'Sent the answers so far.' : 'Told the architect that is enough.';
      },
    ),

    def('approve', 'Approves a gate that is waiting on the owner: the plan, the milestone split, a review post, the merge (it merges now, and deploys to staging when the repo has a staging deploy without the extra tap), "deploy now" (deploys the merged change to staging) or "roll back" (puts staging back after a failed check). Command prompts are answered with their buttons, not here.', { gate: z.number().int().describe('The gate number from task_status.') }, async ({ gate }) => {
      owner('approve');
      const g = openGate(db, gate);
      await pipeline.decideGate(g.id, 'approve' satisfies GateDecision);
      return `Approved the ${g.kind} gate on #${g.taskId}.`;
    }),

    def(
      'reject',
      'Rejects a waiting gate. Plan, split, review post and merge: the task goes back with what to change (a comment is required). "Deploy now": the change stays merged but is not deployed, and the task finishes (the comment is ignored: to change something first, say so and start a new task). "Roll back": staging is kept as it is.',
      { gate: z.number().int().describe('The gate number from task_status.'), comment: z.string().optional().describe("What to change, in the owner's words (required except for deploy and roll back).") },
      async ({ gate, comment }) => {
        owner('reject');
        const g = openGate(db, gate);
        await pipeline.decideGate(g.id, 'reject' satisfies GateDecision, comment);
        if (g.kind === 'deploy') return `#${g.taskId} stays merged and is not deployed to staging.`;
        if (g.kind === 'rollback') return `Kept staging as it is for #${g.taskId}.`;
        return `Sent the ${g.kind} back on #${g.taskId} with the owner's note.`;
      },
    ),

    def('discard', 'Throws a task away, worktree included. Only when the owner clearly asks.', { task: taskId }, async ({ task: id }) => {
      owner('discard a task');
      await pipeline.action(id, 'discard');
      return `Discarded #${id}.`;
    }),
    def('done', 'Marks a task done without merging (for example the PR was merged by hand).', { task: taskId }, async ({ task: id }) => {
      owner('mark a task done');
      await pipeline.action(id, 'done');
      return `Marked #${id} done.`;
    }),
    def('replan', 'Sends a task back to the architect for a new plan.', { task: taskId, reason: z.string().min(1).describe('Why, in the owner\'s words.') }, ({ task: id, reason }) => {
      owner('ask for a new plan');
      pipeline.replanNow(id, reason);
      return `Sent #${id} back to the architect for a new plan.`;
    }),
  ];
  return [...shared, ...ownerTools];
}

/** A gate that is still waiting for a decision from the owner, which the tools may decide. */
function openGate(db: Db, id: number) {
  const g = db.select().from(schema.gates).where(eq(schema.gates.id, id)).get();
  if (!g) throw new Error(`There is no gate ${id}.`);
  if (g.status !== 'pending') throw new Error(`Gate ${id} is already decided.`);
  if (g.kind === 'command') throw new Error('A command prompt is answered with its Allow or Deny buttons, not by me.');
  if (g.kind === 'question') throw new Error('That is a question from the architect: answer it with answer_question.');
  return g;
}
