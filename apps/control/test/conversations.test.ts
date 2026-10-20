import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConversationStore } from '../server/src/conversations.js';

const file = () => join(mkdtempSync(join(tmpdir(), 'conv-')), 'conversations.json');

describe('ConversationStore', () => {
  it("remembers each thread's session across restarts", () => {
    const f = file();
    const a = new ConversationStore(f);
    a.set('D1', '10.1', 'owner', 'sess-a');
    a.set('D1', '10.2', 'owner', 'sess-b');
    a.set('D1', '10.1', 'owner', 'sess-c');
    const b = new ConversationStore(f);
    expect(b.get('D1', '10.1', 'owner')).toBe('sess-c');
    expect(b.get('D1', '10.2', 'owner')).toBe('sess-b');
    expect(b.get('D2', '10.1', 'owner')).toBeUndefined();
  });

  it('forgets a dropped thread, and threads untouched for a month', () => {
    const f = file();
    let now = 1_000_000_000_000;
    const s = new ConversationStore(f, () => now);
    s.set('D1', '1.1', 'owner', 'old');
    s.set('D1', '2.2', 'owner', 'dropped');
    s.drop('D1', '2.2', 'owner');
    now += 31 * 24 * 60 * 60 * 1000;
    s.set('D1', '3.3', 'owner', 'new');
    const again = new ConversationStore(f, () => now);
    expect(again.get('D1', '1.1', 'owner')).toBeUndefined();
    expect(again.get('D1', '2.2', 'owner')).toBeUndefined();
    expect(again.get('D1', '3.3', 'owner')).toBe('new');
  });

  it("keeps the owner's and the assistant's conversations in one thread apart", () => {
    const s = new ConversationStore(file());
    s.set('C1', '5.5', 'assistant', 'from-instinct');
    expect(s.get('C1', '5.5', 'owner')).toBeUndefined();
    s.set('C1', '5.5', 'owner', 'mine');
    expect(s.get('C1', '5.5', 'owner')).toBe('mine');
    expect(s.get('C1', '5.5', 'assistant')).toBe('from-instinct');
  });

  it('starts empty from a missing or unreadable file instead of failing', () => {
    expect(new ConversationStore(file()).get('D1', '1.1', 'owner')).toBeUndefined();
    const f = file();
    writeFileSync(f, 'null');
    expect(new ConversationStore(f).get('D1', '1.1', 'owner')).toBeUndefined();
    writeFileSync(f, '{not json');
    const s = new ConversationStore(f);
    expect(s.get('D1', '1.1', 'owner')).toBeUndefined();
    s.set('D1', '1.1', 'owner', 'x');
    expect(JSON.parse(readFileSync(f, 'utf8'))['D1:1.1:owner'].sessionId).toBe('x');
  });
});
