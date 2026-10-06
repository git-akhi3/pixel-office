// Files I attach to a mission: uploaded first (the board uploads as I pick them), then claimed by
// the task when it is created and moved into its folder, ~/.office/tasks/<id>/attachments/.
// Agents read them with the Read tool only (the guard opens that one folder, read-only).

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { Attachment } from './db/schema.js';

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_MISSION_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;
export const MAX_LINKS = 10;
/** Unclaimed uploads (a mission I never launched) are deleted after this long. */
const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

/** What agents can read with the Read tool: text, PDFs and images. Extension → served type. */
const TYPES: Record<string, string> = {
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.xml': 'text/xml',
  '.html': 'text/html',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};
/** Shown in the board's browser tab as-is; everything else downloads (an HTML or SVG file could run script). */
const INLINE = new Set(['text/plain', 'text/markdown', 'text/csv', 'application/json', 'text/yaml', 'application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export const ACCEPTED_EXTENSIONS = Object.keys(TYPES);
/** Next to each upload; a dotfile, so it can never clash with an uploaded name (safeName drops leading dots). */
const META = '.meta.json';

/** A safe file name: no folders, no leading dot, plain characters, the original extension kept. */
export function safeName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const ext = extname(base).toLowerCase();
  const stem = base
    .slice(0, base.length - ext.length)
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^[.-]+|-+$/g, '')
    .slice(0, 80);
  return `${stem || 'file'}${ext}`;
}

export function typeOf(name: string): string | null {
  return TYPES[extname(name).toLowerCase()] ?? null;
}

/** How the board serves a stored attachment: inline only for types that can't run script. */
export function servedAs(name: string): { type: string; inline: boolean } {
  const type = typeOf(name);
  if (!type || !INLINE.has(type)) return { type: 'application/octet-stream', inline: false };
  if (type.startsWith('text/')) return { type: 'text/plain; charset=utf-8', inline: true };
  if (type === 'application/json') return { type: 'application/json; charset=utf-8', inline: true };
  return { type, inline: true };
}

export function attachmentsDir(taskDir: string): string {
  return join(taskDir, 'attachments');
}

interface UploadMeta {
  name: string;
  size: number;
  type: string;
  at: number;
}

export class Uploads {
  constructor(private dir: string) {}

  /** Stores one uploaded file until a task claims it. Returns its id. */
  save(name: string, data: Buffer, now = Date.now()): { id: string; name: string; size: number; type: string } {
    const clean = safeName(name);
    const type = typeOf(clean);
    if (!type) throw new Error(`${clean}: only text, Markdown, PDF and image files can be attached (${ACCEPTED_EXTENSIONS.join(' ')}).`);
    if (data.length === 0) throw new Error(`${clean} is empty.`);
    if (data.length > MAX_ATTACHMENT_BYTES) throw new Error(`${clean} is over 10 MB.`);
    this.sweep(now);
    const id = randomBytes(12).toString('hex');
    const d = join(this.dir, id);
    mkdirSync(d, { recursive: true, mode: 0o700 });
    writeFileSync(join(d, clean), data, { mode: 0o600 });
    const meta: UploadMeta = { name: clean, size: data.length, type, at: now };
    writeFileSync(join(d, META), JSON.stringify(meta));
    return { id, name: clean, size: data.length, type };
  }

  private meta(id: string): UploadMeta {
    if (!/^[0-9a-f]{24}$/.test(id)) throw new Error('Unknown upload.');
    const f = join(this.dir, id, META);
    if (!existsSync(f)) throw new Error('That upload has expired. Attach the file again.');
    return JSON.parse(readFileSync(f, 'utf8')) as UploadMeta;
  }

  /** Checks a mission's uploads before the task is created: they exist, and fit the limits together. */
  check(ids: string[]): void {
    if (ids.length > MAX_ATTACHMENTS) throw new Error(`At most ${MAX_ATTACHMENTS} files per mission.`);
    const total = [...new Set(ids)].reduce((sum, id) => sum + this.meta(id).size, 0);
    if (total > MAX_MISSION_BYTES) throw new Error('The attachments are over 25 MB together.');
  }

  /** Moves uploads into a task's attachments folder. Names that clash get -2, -3. */
  claim(ids: string[], dest: string): Attachment[] {
    this.check(ids);
    mkdirSync(dest, { recursive: true, mode: 0o700 });
    // APFS is case-insensitive: Spec.md and spec.md are the same file.
    const taken = new Set((existsSync(dest) ? readdirSync(dest) : []).map((n) => n.toLowerCase()));
    const out: Attachment[] = [];
    for (const id of [...new Set(ids)]) {
      const meta = this.meta(id);
      let name = meta.name;
      const ext = extname(name);
      for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${meta.name.slice(0, meta.name.length - ext.length)}-${n}${ext}`;
      taken.add(name.toLowerCase());
      renameSync(join(this.dir, id, meta.name), join(dest, name));
      rmSync(join(this.dir, id), { recursive: true, force: true });
      out.push({ name, size: meta.size, type: meta.type });
    }
    return out;
  }

  /** Deletes uploads nobody claimed within a day. */
  sweep(now = Date.now()): void {
    if (!existsSync(this.dir)) return;
    for (const id of readdirSync(this.dir)) {
      const d = join(this.dir, id);
      try {
        const metaFile = join(d, META);
        const at = existsSync(metaFile) ? (JSON.parse(readFileSync(metaFile, 'utf8')) as UploadMeta).at : statSync(d).mtimeMs;
        if (now - at > UPLOAD_TTL_MS) rmSync(d, { recursive: true, force: true });
      } catch {
        rmSync(d, { recursive: true, force: true });
      }
    }
  }
}

/** Links I add to a mission: http(s) only, trimmed, at most MAX_LINKS. */
export function cleanLinks(links: string[]): string[] {
  const out: string[] = [];
  for (const raw of links) {
    const l = raw.trim();
    if (!l) continue;
    let url: URL;
    try {
      url = new URL(l);
    } catch {
      throw new Error(`Not a link: ${l.slice(0, 80)}`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`Only http(s) links: ${l.slice(0, 80)}`);
    if (!out.includes(url.href)) out.push(url.href);
  }
  if (out.length > MAX_LINKS) throw new Error(`At most ${MAX_LINKS} links per mission.`);
  return out;
}
