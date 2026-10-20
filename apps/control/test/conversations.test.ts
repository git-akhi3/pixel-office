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
    a.set('D1', '10.1', 'sess-a');
    a.set('D1', '10.2', 'sess-b');
    a.set('D1', '10.1', 'sess-c');
    const b = new ConversationStore(f);
    expect(b.get('D1', '10.1')).toBe('sess-c');
    expect(b.get('D1', '10.2')).toBe('sess-b');
    expect(b.get('D2', '10.1')).toBeUndefined();
  });

  it('forgets a dropped thread, and threads untouched for a month', () => {
    const f = file();
    let now = 1_000_000_000_000;
    const s = new ConversationStore(f, () => now);
    s.set('D1', '1.1', 'old');
    s.set('D1', '2.2', 'dropped');
    s.drop('D1', '2.2');
    now += 31 * 24 * 60 * 60 * 1000;
    s.set('D1', '3.3', 'new');
    const again = new ConversationStore(f, () => now);
    expect(again.get('D1', '1.1')).toBeUndefined();
    expect(again.get('D1', '2.2')).toBeUndefined();
    expect(again.get('D1', '3.3')).toBe('new');
  });

  it('starts empty from a missing or unreadable file instead of failing', () => {
    expect(new ConversationStore(file()).get('D1', '1.1')).toBeUndefined();
    const f = file();
    writeFileSync(f, '{not json');
    const s = new ConversationStore(f);
    expect(s.get('D1', '1.1')).toBeUndefined();
    s.set('D1', '1.1', 'x');
    expect(JSON.parse(readFileSync(f, 'utf8'))['D1:1.1'].sessionId).toBe('x');
  });
});
