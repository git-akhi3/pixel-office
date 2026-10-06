import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanLinks, MAX_ATTACHMENT_BYTES, safeName, servedAs, Uploads } from '../server/src/attachments.js';
import { checkToolCall } from '../server/src/guard.js';

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'office-att-')));

describe('attachment names and types', () => {
  it('keeps names plain: no folders, no hidden files, the extension kept', () => {
    expect(safeName('../../etc/passwd.md')).toBe('passwd.md');
    expect(safeName('C:\\Users\\me\\Spec v2 (final).PDF')).toBe('Spec-v2-final.pdf');
    expect(safeName('.env.md')).toBe('env.md');
    expect(safeName('mock-up ✨.png')).toBe('mock-up.png');
    expect(safeName('.png')).toBe('png'); // a dotfile has no extension, so it is refused as an unknown type
  });

  it('serves script-capable files as downloads, never inline', () => {
    expect(servedAs('spec.md')).toEqual({ type: 'text/plain; charset=utf-8', inline: true });
    expect(servedAs('shot.png')).toEqual({ type: 'image/png', inline: true });
    expect(servedAs('page.html')).toEqual({ type: 'application/octet-stream', inline: false });
    expect(servedAs('logo.svg')).toEqual({ type: 'application/octet-stream', inline: false });
  });

  it('accepts only http(s) links, de-duplicated', () => {
    expect(cleanLinks([' https://example.com/a ', 'https://example.com/a', ''])).toEqual(['https://example.com/a']);
    expect(() => cleanLinks(['javascript:alert(1)'])).toThrow(/Only http/);
    expect(() => cleanLinks(['not a url'])).toThrow(/Not a link/);
  });
});

describe('uploads', () => {
  it('stores an upload until a task claims it, then moves it, renaming clashes', () => {
    const dir = tmp();
    const u = new Uploads(join(dir, 'uploads'));
    const a = u.save('spec.md', Buffer.from('# Spec'));
    const b = u.save('spec.md', Buffer.from('# Other'));
    expect(a.type).toBe('text/markdown');
    const dest = join(dir, 'task', 'attachments');
    expect(u.claim([a.id, b.id], dest)).toEqual([
      { name: 'spec.md', size: 6, type: 'text/markdown' },
      { name: 'spec-2.md', size: 7, type: 'text/markdown' },
    ]);
    expect(readdirSync(dest).sort()).toEqual(['spec-2.md', 'spec.md']);
    expect(readdirSync(join(dir, 'uploads'))).toEqual([]);
    expect(() => u.claim([a.id], dest)).toThrow(/expired/);
  });

  it('refuses other file types, empty and oversized files, bad ids and too much in total', () => {
    const u = new Uploads(join(tmp(), 'uploads'));
    expect(() => u.save('tool.exe', Buffer.from('x'))).toThrow(/only text, Markdown, PDF and image/);
    expect(() => u.save('a.md', Buffer.alloc(0))).toThrow(/empty/);
    expect(() => u.save('a.png', Buffer.alloc(MAX_ATTACHMENT_BYTES + 1))).toThrow(/over 10 MB/);
    expect(() => u.check(['../../etc'])).toThrow(/Unknown upload/);
    const ids = [1, 2, 3].map(() => u.save('big.pdf', Buffer.alloc(9 * 1024 * 1024)).id);
    expect(() => u.check(ids)).toThrow(/over 25 MB/);
  });

  it('keeps a file called meta.json intact, and treats names differing in case as a clash', () => {
    const dir = tmp();
    const u = new Uploads(join(dir, 'uploads'));
    const meta = u.save('meta.json', Buffer.from('{"real":true}'));
    const upper = u.save('Spec.md', Buffer.from('A'));
    const lower = u.save('spec.md', Buffer.from('B'));
    const dest = join(dir, 'att');
    expect(u.claim([meta.id, upper.id, lower.id], dest).map((a) => a.name)).toEqual(['meta.json', 'Spec.md', 'spec-2.md']);
    expect(readFileSync(join(dest, 'meta.json'), 'utf8')).toBe('{"real":true}');
  });

  it('deletes uploads nobody claimed within a day', () => {
    const u = new Uploads(join(tmp(), 'uploads'));
    const old = u.save('a.md', Buffer.from('x'), Date.now() - 2 * 24 * 60 * 60 * 1000);
    u.sweep();
    expect(() => u.check([old.id])).toThrow(/expired/);
  });
});

describe('guard: the attachments folder', () => {
  it('can be read, never written, and opens nothing else under ~/.office', () => {
    const home = tmp();
    const office = join(home, '.office');
    const worktree = join(office, 'worktrees', '1');
    const attachments = join(office, 'tasks', '1', 'attachments');
    mkdirSync(worktree, { recursive: true });
    mkdirSync(attachments, { recursive: true });
    writeFileSync(join(attachments, 'spec.md'), '# x');
    writeFileSync(join(office, 'env'), 'TOKEN=x');
    const ctx = { worktree, write: 'all' as const, testGlobs: [], allowlist: [], readRoots: [attachments] };
    expect(checkToolCall(ctx, 'Read', { file_path: join(attachments, 'spec.md') }).decision).toBe('allow');
    expect(checkToolCall(ctx, 'Grep', { pattern: 'x', path: attachments }).decision).toBe('allow');
    expect(checkToolCall(ctx, 'Write', { file_path: join(attachments, 'spec.md'), content: 'y' }).decision).toBe('deny');
    expect(checkToolCall(ctx, 'Read', { file_path: join(office, 'env') }).decision).toBe('deny');
    expect(checkToolCall(ctx, 'Read', { file_path: join(office, 'tasks', '2', 'attachments', 'x.md') }).decision).toBe('deny');
    expect(checkToolCall(ctx, 'Read', { file_path: join(attachments, '..', 'plan.md') }).decision).toBe('deny');
    // Without the folder in readRoots (a task with no attachments), nothing opens.
    expect(checkToolCall({ ...ctx, readRoots: [] }, 'Read', { file_path: join(attachments, 'spec.md') }).decision).toBe('deny');
    expect(existsSync(join(attachments, 'spec.md'))).toBe(true);
  });
});
