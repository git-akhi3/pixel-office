import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, schema, type Db } from '../server/src/db/index.js';
import type { Gate, Task } from '../server/src/db/schema.js';
import type { GateDecision } from '../server/src/domain.js';
import { EventBus } from '../server/src/events.js';
import type { Pipeline } from '../server/src/pipeline.js';
import { Uploads } from '../server/src/attachments.js';
import { esc, isSlackFileUrl, SlackBridge, type SlackApi } from '../server/src/slack.js';

const OWNER = 'U0OWNER0001';
const DM = 'D0DM';
const CH = 'C0SHARED1';
const INSTINCT = 'U0INSTINCT1';

interface Posted {
  channel: string;
  text: string;
  thread_ts?: string;
  blocks?: unknown[];
  ts: string;
}

function setup(repoNames: string[] = ['alpha'], assistant = false) {
  const db: Db = openDb(join(mkdtempSync(join(tmpdir(), 'slack-')), 'office.db'));
  const bus = new EventBus(db);
  for (const name of repoNames) db.insert(schema.repos).values({ name, path: `/tmp/${name}`, defaultBranch: 'main' }).run();
  const repo = db.select().from(schema.repos).all()[0]!;

  const posted: Posted[] = [];
  const updated: Array<{ channel: string; ts: string; text: string }> = [];
  let n = 0;
  const api: SlackApi = {
    postMessage: async (a) => {
      const ts = `100.${++n}`;
      posted.push({ ...a, ts });
      return { ts };
    },
    updateMessage: async (a) => void updated.push(a),
    openDm: async () => DM,
    downloadFile: async (url: string) => {
      if (url.includes('fail')) throw new Error('download failed (500)');
      return Buffer.from(`# file from ${url}`);
    },
  };

  const calls: string[] = [];
  const pipeline = {
    getTask: (id: number) => db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).get()!,
    tokensUsed: () => 1500,
    pendingGates: (taskId?: number): Gate[] => db.select().from(schema.gates).where(eq(schema.gates.status, 'pending')).all().filter((g) => taskId === undefined || g.taskId === taskId),
    createTask: (input: { repoId: number; input: string; attachments?: string[] }) => {
      calls.push(`create:${input.repoId}:${input.input}${input.attachments ? `:files=${input.attachments.length}` : ''}`);
      const task = db.insert(schema.tasks).values({ repoId: input.repoId, title: input.input.slice(0, 80), input: input.input }).returning().get();
      bus.emit(task.id, 'created', { title: task.title });
      return task;
    },
    createReviewTask: async (url: string) => {
      calls.push(`review:${url}`);
      await Promise.resolve();
      const task = db.insert(schema.tasks).values({ repoId: repo.id, kind: 'review', title: 'Review #7', input: url }).returning().get();
      bus.emit(task.id, 'created', { title: task.title, review: true });
      return task;
    },
    decideGate: async (id: number, decision: GateDecision, comment?: string) => void calls.push(`gate:${id}:${decision}:${comment ?? ''}`),
    action: async (id: number, a: string) => void calls.push(`action:${id}:${a}`),
    steer: (id: number, text: string) => (calls.push(`steer:${id}:${text}`), 'live' as const),
    replanNow: (id: number, reason: string) => void calls.push(`replan:${id}:${reason}`),
  } as unknown as Pipeline;

  const docs = { latest: () => '---\nx: 1\n---\n## Goal\nAdd greet().' } as never;
  const uploads = new Uploads(join(mkdtempSync(join(tmpdir(), 'slack-up-')), 'uploads'));
  const bridge = new SlackBridge({ db, bus, pipeline, docs, uploads, ownerId: OWNER, botUserId: 'U0BOT0001', ...(assistant ? { channelId: CH, assistantIds: [INSTINCT] } : {}), publicUrl: 'http://127.0.0.1:4100', api });
  const settle = () => new Promise((r) => setTimeout(r, 20));
  return { db, bus, bridge, posted, updated, calls, settle, repo };
}

const dm = (text: string, extra: Record<string, unknown> = {}) => ({ user: OWNER, channel: DM, ts: '50.1', text, ...extra });

describe('SlackBridge', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(async () => {
    t = setup();
    await t.bridge.start();
  });

  it('escapes Slack markup', () => {
    expect(esc('a <b> & c')).toBe('a &lt;b&gt; &amp; c');
  });

  it('ignores everyone but the owner, bots and edits', async () => {
    await t.bridge.onMessage({ ...dm('do a thing'), user: 'U0STRANGER' });
    await t.bridge.onMessage(dm('do a thing', { subtype: 'message_changed' }));
    await t.bridge.onMessage(dm('do a thing', { bot_id: 'B1' }));
    await t.settle();
    expect(t.calls).toEqual([]);
    expect(t.posted).toEqual([]);
  });

  it('turns a DM into a task and makes that message its thread', async () => {
    await t.bridge.onMessage(dm('add a greeting'));
    await t.settle();
    expect(t.calls).toEqual([`create:${t.repo.id}:add a greeting`]);
    const task = t.db.select().from(schema.tasks).get()!;
    expect(task.slackChannel).toBe(DM);
    expect(task.slackThreadTs).toBe('50.1');
    // The acknowledgement and the status message are both in the owner's thread; no second thread was started.
    expect(t.posted.every((p) => p.thread_ts === '50.1')).toBe(true);
    expect(t.posted.some((p) => p.text.includes('queued'))).toBe(true);
  });

  it('picks the repo by name when there are several, and asks when it is unclear', async () => {
    const many = setup(['alpha', 'beta']);
    await many.bridge.start();
    await many.bridge.onMessage(dm('beta: fix the footer'));
    expect(many.calls).toEqual([`create:${many.db.select().from(schema.repos).all()[1]!.id}:fix the footer`]);
    await many.bridge.onMessage(dm('fix the footer', { ts: '51.1' }));
    expect(many.calls).toHaveLength(1);
    expect(many.posted.at(-1)!.text).toContain('Which repo?');
  });

  it('starts a task from a reply in a thread that has none, using that thread', async () => {
    await t.bridge.onMessage(dm('alpha: add a greeting', { ts: '55.1', thread_ts: '50.1' }));
    await t.settle();
    expect(t.calls).toEqual([`create:${t.repo.id}:add a greeting`]);
    const task = t.db.select().from(schema.tasks).get()!;
    expect([task.slackChannel, task.slackThreadTs]).toEqual([DM, '50.1']);
    await t.bridge.onMessage(dm('just chatting', { ts: '56.1', thread_ts: '50.2' }));
    expect(t.calls).toHaveLength(1);
    expect(t.posted.at(-1)!.text).toContain('no task');
  });

  it('ignores a message that starts by mentioning someone else, and accepts one that mentions the bot', async () => {
    await t.bridge.onMessage(dm('<@U0INSTINCT1> whats the status and eta on the existing tasks'));
    expect(t.calls).toEqual([]);
    expect(t.posted).toEqual([]);
    await t.bridge.onMessage(dm('<@U0BOT0001> alpha: add a greeting', { ts: '58.1' }));
    expect(t.calls).toEqual([`create:${t.repo.id}:add a greeting`]);
  });

  it('starts a PR review from a pasted link', async () => {
    await t.bridge.onMessage(dm('please look at https://github.com/acme/widgets/pull/7 thanks'));
    await t.settle();
    expect(t.calls).toEqual(['review:https://github.com/acme/widgets/pull/7']);
    expect(t.db.select().from(schema.tasks).get()!.slackThreadTs).toBe('50.1');
  });

  it('gives a board-started task its own thread and keeps one status message it edits', async () => {
    const task = t.db.insert(schema.tasks).values({ repoId: t.repo.id, title: 'From the board', input: 'x', status: 'coding' }).returning().get();
    t.bus.emit(task.id, 'step_start', { step: 'coding', role: 'coder' });
    await t.settle();
    const root = t.posted[0]!;
    expect(root.thread_ts).toBeUndefined();
    expect(root.text).toContain('New task #1');
    const status = t.posted[1]!;
    expect(status.thread_ts).toBe(root.ts);
    expect(status.text).toContain('coder');

    t.db.update(schema.tasks).set({ status: 'reviewing' }).where(eq(schema.tasks.id, task.id)).run();
    t.bus.emit(task.id, 'step_start', { step: 'reviewing', role: 'reviewer' });
    await t.settle();
    expect(t.posted).toHaveLength(2);
    expect(t.updated.at(-1)).toMatchObject({ ts: status.ts });
    expect(t.updated.at(-1)!.text).toContain('reviewer');
  });

  it('posts a gate with buttons and edits it once decided', async () => {
    const task = t.db.insert(schema.tasks).values({ repoId: t.repo.id, title: 'Plan me', input: 'x', status: 'awaiting_plan_approval', slackChannel: DM, slackThreadTs: '50.1' }).returning().get();
    const gate = t.db.insert(schema.gates).values({ taskId: task.id, kind: 'plan' }).returning().get();
    t.bus.emit(task.id, 'gate', { gateId: gate.id, kind: 'plan', subject: null, status: 'pending', auto: false });
    await t.settle();
    const msg = t.posted.at(-1)!;
    expect(msg.thread_ts).toBe('50.1');
    const actions = (msg.blocks as Array<{ type: string; elements?: Array<{ action_id?: string }> }>).find((b) => b.type === 'actions')!;
    expect(actions.elements!.map((e) => e.action_id).filter(Boolean)).toEqual([`office_gate:${gate.id}:approve`, `office_gate:${gate.id}:reject`]);
    expect(t.db.select().from(schema.gates).get()!.slackTs).toBe(msg.ts);

    t.bus.emit(task.id, 'gate_decided', { gateId: gate.id, kind: 'plan', decision: 'approve' });
    await t.settle();
    expect(t.updated.at(-1)).toMatchObject({ ts: msg.ts });
    expect(t.updated.at(-1)!.text).toContain('Approved');
  });

  it('only obeys button taps from the owner', async () => {
    expect(await t.bridge.onButton('U0STRANGER', 'office_gate:3:approve')).toBeNull();
    expect(t.calls).toEqual([]);
    const task = t.db.insert(schema.tasks).values({ repoId: t.repo.id, title: 'x', input: 'x', slackChannel: DM, slackThreadTs: '50.1' }).returning().get();
    const gate = t.db.insert(schema.gates).values({ taskId: task.id, kind: 'push' }).returning().get();
    await t.bridge.onButton(OWNER, `office_gate:${gate.id}:approve`);
    expect(t.calls).toEqual([`gate:${gate.id}:approve:`]);
  });

  it('reject needs a reason, taken from the thread', async () => {
    const task = t.db.insert(schema.tasks).values({ repoId: t.repo.id, title: 'x', input: 'x', status: 'awaiting_plan_approval', slackChannel: DM, slackThreadTs: '50.1' }).returning().get();
    const gate = t.db.insert(schema.gates).values({ taskId: task.id, kind: 'plan' }).returning().get();
    await t.bridge.onButton(OWNER, `office_gate:${gate.id}:reject`);
    expect(t.calls).toEqual([]);
    expect(t.posted.at(-1)!.text).toContain('reject:');
    await t.bridge.onMessage(dm('reject: use a smaller scope', { ts: '60.1', thread_ts: '50.1' }));
    expect(t.calls).toEqual([`gate:${gate.id}:reject:use a smaller scope`]);
  });

  it('runs thread commands', async () => {
    const task = t.db.insert(schema.tasks).values({ repoId: t.repo.id, title: 'x', input: 'x', slackChannel: DM, slackThreadTs: '50.1' }).returning().get();
    const say = (text: string) => t.bridge.onMessage(dm(text, { ts: '61.1', thread_ts: '50.1' }));
    await say('pause');
    await say('resume');
    await say('steer: use the existing helper');
    await say('replan: wrong approach');
    await say('discard');
    expect(t.calls).toEqual([
      `action:${task.id}:stop`,
      `action:${task.id}:resume`,
      `steer:${task.id}:use the existing helper`,
      `replan:${task.id}:wrong approach`,
      `action:${task.id}:discard`,
    ]);
    await say('what is going on');
    expect(t.posted.at(-1)!.text).toContain('steer:');
  });

  it('reports a command error in the thread instead of throwing', async () => {
    const task = t.db.insert(schema.tasks).values({ repoId: t.repo.id, title: 'x', input: 'x', slackChannel: DM, slackThreadTs: '50.1' }).returning().get();
    (t.bridge as unknown as { deps: { pipeline: { action: () => never } } }).deps.pipeline.action = () => {
      throw new Error(`The task is done.`);
    };
    await t.bridge.onMessage(dm('stop', { ts: '62.1', thread_ts: '50.1' }));
    expect(t.posted.at(-1)!.text).toContain('The task is done.');
    expect(task.id).toBe(1);
  });

  it('posts milestones and alerts in the task thread', async () => {
    const task = t.db.insert(schema.tasks).values({ repoId: t.repo.id, title: 'x', input: 'x', status: 'pr_open', slackChannel: DM, slackThreadTs: '50.1' }).returning().get();
    t.bus.emit(task.id, 'alert', { kind: 'tokens', message: 'Used 9 tokens <a>' });
    t.bus.emit(task.id, 'pr_opened', { url: 'https://github.com/acme/widgets/pull/9' });
    await t.settle();
    const texts = t.posted.map((p) => p.text);
    expect(texts.some((x) => x.includes('Used 9 tokens &lt;a&gt;'))).toBe(true);
    expect(texts.some((x) => x.includes('pull/9'))).toBe(true);
    expect(t.posted.every((p) => p.thread_ts === '50.1')).toBe(true);
  });
});

describe('SlackBridge with an assistant channel', () => {
  let t: ReturnType<typeof setup>;
  const fromInstinct = (text: string, extra: Record<string, unknown> = {}) => ({ user: INSTINCT, bot_id: 'B0INSTINCT', channel: CH, ts: '70.1', text, ...extra });
  beforeEach(async () => {
    t = setup(['alpha'], true);
    await t.bridge.start();
  });

  it('lets the assistant start a named-repo task in the shared channel, with that message as the thread', async () => {
    await t.bridge.onMessage(fromInstinct('alpha: add a greeting'));
    await t.settle();
    expect(t.calls).toEqual([`create:${t.repo.id}:add a greeting`]);
    const task = t.db.select().from(schema.tasks).get()!;
    expect([task.slackChannel, task.slackThreadTs]).toEqual([CH, '70.1']);
  });

  it('ignores assistant chatter that is not an explicit task', async () => {
    await t.bridge.onMessage(fromInstinct('Thanks! Anything else?'));
    await t.bridge.onMessage(fromInstinct('add a greeting'));
    expect(t.calls).toEqual([]);
    expect(t.posted).toEqual([]);
  });

  it('ignores the assistant outside the shared channel and strangers inside it', async () => {
    await t.bridge.onMessage(fromInstinct('alpha: x', { channel: DM }));
    await t.bridge.onMessage(fromInstinct('alpha: x', { channel: 'C0OTHER', user: 'U0SOMEONE', bot_id: undefined }));
    await t.bridge.onMessage(fromInstinct('alpha: x', { user: 'U0IMPOSTOR', bot_id: 'B0IMPOSTOR' }));
    expect(t.calls).toEqual([]);
  });

  it('limits how many tasks the assistant can start per hour', async () => {
    for (let i = 0; i < 7; i++) await t.bridge.onMessage(fromInstinct(`alpha: job ${i}`, { ts: `80.${i}` }));
    expect(t.calls).toHaveLength(5);
    expect(t.posted.at(-1)!.text).toContain('Limit reached');
  });

  it('lets the assistant steer and pause, but never approve, reject, discard or replan', async () => {
    const task = t.db.insert(schema.tasks).values({ repoId: t.repo.id, title: 'x', input: 'x', slackChannel: CH, slackThreadTs: '70.1' }).returning().get();
    const say = (text: string) => t.bridge.onMessage(fromInstinct(text, { ts: '71.1', thread_ts: '70.1' }));
    await say('steer: keep it small');
    await say('pause');
    await say('approve');
    await say('reject: no');
    await say('discard');
    await say('replan: again');
    await say('ok great');
    expect(t.calls).toEqual([`steer:${task.id}:keep it small`, `action:${task.id}:stop`]);
    expect(t.posted.filter((p) => p.text.includes('needs the owner'))).toHaveLength(4);
  });

  it('keeps the owner able to do everything in the shared channel', async () => {
    const task = t.db.insert(schema.tasks).values({ repoId: t.repo.id, title: 'x', input: 'x', slackChannel: CH, slackThreadTs: '70.1' }).returning().get();
    await t.bridge.onMessage({ user: OWNER, channel: CH, ts: '72.1', thread_ts: '70.1', text: 'discard' });
    expect(t.calls).toEqual([`action:${task.id}:discard`]);
  });
});

// Keeps the Task type honest for the stubs above.
void (null as unknown as Task);

describe('files on a Slack task message', () => {
  it('become the new task\'s attachments; problems are reported, not fatal', async () => {
    const t = setup();
    await t.bridge.start();
    const file = (name: string, url = `https://files.slack.com/files-pri/T1-F1/${name}`) => ({ name, size: 10, url_private_download: url });
    await t.bridge.onMessage({
      ...dm('alpha: match this mock-up'),
      subtype: 'file_share',
      files: [file('spec.md'), file('virus.exe'), file('evil.md', 'https://evil.example/spec.md'), file('broken.md', 'https://files.slack.com/fail.md')],
    });
    await t.settle();
    expect(t.calls).toEqual([`create:${t.repo.id}:match this mock-up:files=1`]);
    const reply = t.posted.find((p) => p.text.includes('queued'))!.text;
    expect(reply).toContain('with 1 attachment');
    expect(reply).toContain('virus.exe: only text, Markdown, PDF and image files');
    expect(reply).toContain('evil.md: not a Slack file link');
    expect(reply).toContain('broken.md: download failed (500)');
  });

  it('only fetches from files.slack.com over https', () => {
    expect(isSlackFileUrl('https://files.slack.com/files-pri/T1/x.png')).toBe(true);
    expect(isSlackFileUrl('http://files.slack.com/x')).toBe(false);
    expect(isSlackFileUrl('https://files.slack.com.evil.example/x')).toBe(false);
    expect(isSlackFileUrl('nope')).toBe(false);
  });
});
