// Which Agent SDK session each Slack thread's conversation with Fury is, per sender. A new message in
// a thread resumes that sender's session, so Fury remembers what was said above it. The owner and the
// assistant never share one: the assistant relays other people's words, and the owner's turns hold
// the tools that approve, merge and discard, so that text must never sit in the owner's conversation.
//
// Kept in a small JSON file in the office folder, not the database: it is only a cache of ids. A
// lost or unreadable file just means the next message in each thread starts a fresh conversation.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

interface Entry {
  sessionId: string;
  updatedAt: number;
}

/** Conversations untouched for this long are forgotten, so the file doesn't grow for ever. */
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;

export class ConversationStore {
  private entries: Record<string, Entry> = {};

  constructor(
    private file: string,
    private now: () => number = Date.now,
  ) {
    try {
      const read = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as unknown) : {};
      this.entries = read && typeof read === 'object' && !Array.isArray(read) ? (read as Record<string, Entry>) : {};
    } catch {
      this.entries = {};
    }
  }

  private key(channel: string, threadTs: string, sender: string): string {
    return `${channel}:${threadTs}:${sender}`;
  }

  get(channel: string, threadTs: string, sender: string): string | undefined {
    return this.entries[this.key(channel, threadTs, sender)]?.sessionId;
  }

  set(channel: string, threadTs: string, sender: string, sessionId: string): void {
    this.entries[this.key(channel, threadTs, sender)] = { sessionId, updatedAt: this.now() };
    const oldest = this.now() - KEEP_MS;
    for (const [k, e] of Object.entries(this.entries)) if (e.updatedAt < oldest) delete this.entries[k];
    this.save();
  }

  /** Forgets a thread's conversation (its session could not be resumed). */
  drop(channel: string, threadTs: string, sender: string): void {
    if (delete this.entries[this.key(channel, threadTs, sender)]) this.save();
  }

  private save(): void {
    try {
      // Written beside and renamed over, so a crash never leaves half a file.
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.entries), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (e) {
      console.warn(`Slack: could not save conversations: ${(e as Error).message}`);
    }
  }
}
