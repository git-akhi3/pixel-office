// The briefing: the architect grills me before planning, in rounds of questions.
//
// The architect ends a turn with a question round instead of the plan. The office stores the
// round, shows it on the board and in Slack, and sends my answers back into the same session.
// Pure helpers here; the waiting and delivery live in the pipeline.

import { z } from 'zod';
import type { Question } from './db/schema.js';
import { parseDoc } from './handoffs.js';

/** How long a planning session waits for a round's answers before it parks (and frees its slot). */
export const BRIEFING_WAIT_MS = 15 * 60 * 1000;
/** Malformed rounds sent back for a fix before the message is treated as the plan. */
export const MAX_BAD_ROUNDS = 2;
const MAX_PER_ROUND = 8;

export const ROUND_FORMAT = `---
questions:
  - title: "<short title, under 60 characters>"
    question: "<the question, with the context the owner needs to answer it>"
    options: ["<option>", "<option>"]          # optional, 2 to 5 short choices
    recommended: "<your recommended answer, and why in a few words>"
---
Put every value in double quotes (escape a quote inside as \\"), so colons and # in the text can't break the YAML.`;

const questionSchema = z.object({
  title: z.string().trim().min(1).max(80),
  question: z.string().trim().min(1).max(2000),
  options: z.array(z.coerce.string().trim().min(1).max(200)).max(5).optional().default([]),
  recommended: z.coerce.string().trim().max(600).optional(),
});

export type RoundQuestion = z.infer<typeof questionSchema>;

/**
 * Reads a question round from the architect's final message. null: not a round (it's the plan).
 * A string: a round, but malformed; the string tells the architect what to fix.
 */
export function parseRound(text: string): RoundQuestion[] | string | null {
  let meta: Record<string, unknown>;
  try {
    meta = parseDoc(text).meta;
  } catch (e) {
    // Broken YAML in what is clearly a round (an unquoted colon, a #): say so, rather than letting it
    // fail as a malformed plan.
    if (/^---\s*\n\s*questions\s*:/m.test(text.trim())) {
      return `That question round isn't valid YAML (${(e as Error).message.split('\n')[0]}). Send it again with every value in double quotes:\n\n${ROUND_FORMAT}`;
    }
    return null; // not valid YAML: let the plan's own validation explain it
  }
  if (!('questions' in meta)) return null;
  const list = z.array(questionSchema).min(1).max(MAX_PER_ROUND).safeParse(meta.questions);
  if (!list.success) {
    const issues = list.error.issues.map((i) => `${i.path.join('.') || 'questions'}: ${i.message}`).join('; ');
    return `That question round doesn't match the format (${issues}). Send it again, fixed, at most ${MAX_PER_ROUND} questions per round:\n\n${ROUND_FORMAT}`;
  }
  return list.data;
}

export function answerText(q: Pick<Question, 'answer' | 'delegated' | 'recommended'>): string {
  if (q.delegated) return `you decide${q.recommended ? ` (your recommendation: ${q.recommended})` : ''}`;
  return q.answer ?? '';
}

export type Delivery = 'complete' | 'send' | 'enough';

/** The message the architect gets with my answers to a round. */
export function answersMessage(round: number, questions: Question[], delivery: Delivery, notes: string[] = []): string {
  const lines = [`The owner's answers to round ${round}:`];
  questions.forEach((q, i) => {
    const a = q.answer !== null || q.delegated ? answerText(q) : delivery === 'enough' ? 'not answered: use your recommendation and list it under Risks as an assumption' : 'not answered yet: ask again in a later round if it still matters';
    lines.push(`${i + 1}. ${q.title}: ${a}`);
  });
  for (const n of notes) lines.push('', `The owner also says: ${n}`);
  lines.push(
    '',
    delivery === 'enough'
      ? 'The owner says that is enough questions. Write the plan now. Put anything still open under Risks as an assumption, with the conservative choice.'
      : 'Ask the next round if anything that changes the plan is still unclear. Otherwise write the plan.',
  );
  return lines.join('\n');
}

/** brief.md: every answered question so far, by round. Re-plans read it instead of asking again. */
export function briefDoc(questions: Question[]): string {
  const answered = questions.filter((q) => q.answer !== null || q.delegated);
  const rounds = [...new Set(answered.map((q) => q.round))].sort((a, b) => a - b);
  const out = ['---', `rounds: ${rounds.length}`, `answered: ${answered.length}`, '---', '## Decisions from the briefing'];
  for (const r of rounds) {
    out.push('', `### Round ${r}`);
    for (const q of answered.filter((x) => x.round === r)) {
      out.push(`- **${q.title}:** ${answerText(q)}`);
    }
  }
  return out.join('\n');
}

/** The architect's instructions when the mission is grilled. */
export function briefingRules(hasSkill: boolean): string {
  return [
    '## Asking the owner (briefing)',
    "This task gets a briefing: before you plan, interview the owner until you understand what they want. The owner isn't in a live chat; instead:",
    `- To ask, end your turn with ONLY a question round in this format:\n\n${ROUND_FORMAT}`,
    '- Put every question you can ask now, without waiting on another answer, into one round. Give each a recommended answer. Ask only what would change the plan, never facts you can look up in the code yourself.',
    "- The office shows the round to the owner and sends their answers back to you as the next message. Then ask the next round, or write the plan once nothing that changes it is unclear. There's no question limit.",
    '- Answers are also saved in brief.md. If brief.md is in your handoff documents, those questions are settled: do not ask them again.',
    '- When you write the plan, reply with the plan only, in its own format.',
    hasSkill ? '- Follow the grilling skill for how to interview; these rules decide how to ask in this office.' : '- Work the open decisions like a tree: settle the ones others depend on first.',
  ].join('\n');
}
