// Per-repo knowledge files: short, owner-approved notes every agent reads at the start of a step.
// Stored in the office (~/.office/knowledge/<repoId>.md), never committed to the repo.

import { and, desc, eq } from 'drizzle-orm';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { schema, type Db } from './db/index.js';
import type { KnowledgeProposal } from './db/schema.js';
import { parseDoc } from './handoffs.js';

/** About two pages. Longer files cost every agent tokens on every step. */
export const MAX_KNOWLEDGE_LINES = 120;
export const MAX_KNOWLEDGE_CHARS = 12_000;

export class Knowledge {
  constructor(
    private db: Db,
    private dir: string,
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  private file(repoId: number): string {
    return join(this.dir, `${repoId}.md`);
  }

  read(repoId: number): string {
    const f = this.file(repoId);
    return existsSync(f) ? readFileSync(f, 'utf8') : '';
  }

  write(repoId: number, text: string): void {
    const lines = text.trimEnd().split('\n').length;
    if (lines > MAX_KNOWLEDGE_LINES || text.length > MAX_KNOWLEDGE_CHARS) {
      throw new Error(
        `The knowledge file would be ${lines} lines / ${text.length} characters; the limit is ${MAX_KNOWLEDGE_LINES} lines and ${MAX_KNOWLEDGE_CHARS} characters (every agent reads it on every step). Trim it on the Knowledge page first.`,
      );
    }
    writeFileSync(this.file(repoId), text.trimEnd() + '\n');
  }

  propose(repoId: number, taskId: number | null, text: string): KnowledgeProposal {
    return this.db.insert(schema.knowledgeProposals).values({ repoId, taskId, text: text.trim() }).returning().get();
  }

  proposals(status: KnowledgeProposal['status'] = 'pending', repoId?: number): KnowledgeProposal[] {
    const where = repoId === undefined ? eq(schema.knowledgeProposals.status, status) : and(eq(schema.knowledgeProposals.status, status), eq(schema.knowledgeProposals.repoId, repoId));
    return this.db.select().from(schema.knowledgeProposals).where(where).orderBy(desc(schema.knowledgeProposals.id)).all();
  }

  /** Accepting appends the note (optionally as I edited it) as a bullet. */
  decide(id: number, decision: 'accept' | 'reject', editedText?: string): KnowledgeProposal {
    const p = this.db.select().from(schema.knowledgeProposals).where(eq(schema.knowledgeProposals.id, id)).get();
    if (!p) throw new Error(`No proposal ${id}`);
    if (p.status !== 'pending') throw new Error('This proposal has already been decided.');
    if (decision === 'accept') {
      const note = (editedText ?? p.text).trim().replace(/^[-*]\s+/, '');
      if (!note) throw new Error('The note is empty.');
      const current = this.read(p.repoId).trimEnd();
      this.write(p.repoId, `${current ? `${current}\n` : '# Repo notes\n\n'}- ${note}`);
    }
    return this.db
      .update(schema.knowledgeProposals)
      .set({ status: decision === 'accept' ? 'accepted' : 'rejected', ...(editedText ? { text: editedText.trim() } : {}) })
      .where(eq(schema.knowledgeProposals.id, id))
      .returning()
      .get();
  }
}

/** The "Knowledge-file edit" line of a retrospective, or null for "none". */
export function proposalFromRetro(retro: string): string | null {
  const line = parseDoc(retro).body.match(/\*\*Knowledge-file edit:\*\*\s*(.+)/)?.[1]?.trim();
  if (!line || /^(none|n\/a|-)\b/i.test(line) || /^none[.!]?$/i.test(line)) return null;
  return line;
}
