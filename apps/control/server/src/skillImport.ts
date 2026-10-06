// Importing skills from Claude Code into the office's catalog.
//
// Office agents never load my Claude Code setup (settingSources: []). Instead I pick skills from my
// Claude Code plugins and ~/.claude/skills, and the office copies a snapshot into ~/.office/skills,
// recording where it came from. A changed source shows as "update available"; I decide whether to take it.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { isWrapperSkill, parseSkill, SKILL_NAME } from './agents.js';

export interface ImportRoot {
  /** Shown when a skill isn't inside a plugin, e.g. "~/.claude/skills". */
  label: string;
  dir: string;
}

export interface ImportableSkill {
  /** Stable id of the source file, used to import it. */
  key: string;
  name: string;
  description: string;
  /** The plugin it belongs to, or the root's label. */
  source: string;
  path: string;
  /** Other files next to SKILL.md (references, scripts). Only SKILL.md is imported. */
  extraFiles: number;
  /** It only tells the agent to call other skills, which office agents can't do. */
  wrapper: boolean;
  /** new: not in the office. imported: same as the office copy. update: the source changed since import.
   *  taken: the office already has a different skill with this name. */
  status: 'new' | 'imported' | 'update' | 'taken';
}

export interface SourceInfo {
  path: string;
  source: string;
  hash: string;
  importedAt: number;
}

const SOURCE_FILE = '.source.json';
const MAX_DEPTH = 9;
const MAX_FILES = 5000;
/** Same cap as a skill saved on the Team page: the body goes into every prompt that uses it. */
export const MAX_SKILL_BYTES = 50_000;
/** list() walks folders and hashes files; the board asks for it several times per import. */
const LIST_CACHE_MS = 3000;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.venv', '__pycache__']);

export const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const keyOf = (realPath: string) => sha(realPath).slice(0, 16);

const inside = (root: string, p: string) => p === root || p.startsWith(`${root}/`);

/**
 * SKILL.md files under a directory, as real paths. Symlinks are followed (tools often install
 * skills as links) but only while the target stays inside the root, and each real folder is
 * walked once, so link cycles end.
 */
function findSkillFiles(dir: string): string[] {
  const found: string[] = [];
  let root: string;
  try {
    root = realpathSync(dir);
  } catch {
    return found;
  }
  const seenDirs = new Set<string>();
  let visited = 0;
  const walk = (d: string, depth: number) => {
    if (depth > MAX_DEPTH || visited > MAX_FILES || seenDirs.has(d)) return;
    seenDirs.add(d);
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (++visited > MAX_FILES) return;
      if (SKIP_DIRS.has(e.name)) continue;
      let real = join(d, e.name);
      let isDir = e.isDirectory();
      let isFile = e.isFile();
      if (e.isSymbolicLink()) {
        try {
          real = realpathSync(real);
          const st = statSync(real);
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch {
          continue; // dangling link
        }
        if (!inside(root, real)) continue;
      }
      if (isDir) walk(real, depth + 1);
      else if (isFile && e.name === 'SKILL.md') found.push(real);
    }
  };
  walk(root, 0);
  return found;
}

/** The name of the plugin a skill file belongs to: the nearest .claude-plugin/plugin.json above it. */
function pluginName(file: string, root: string): string | null {
  for (let d = dirname(dirname(file)); d.startsWith(root) && d !== dirname(d); d = dirname(d)) {
    const manifest = join(d, '.claude-plugin', 'plugin.json');
    if (existsSync(manifest)) {
      try {
        const name = (JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown }).name;
        if (typeof name === 'string' && name) return name;
      } catch {
        // unreadable manifest: fall back to the root's label
      }
    }
  }
  return null;
}

export function readSourceInfo(officeSkillsDir: string, name: string): SourceInfo | null {
  const f = join(officeSkillsDir, name, SOURCE_FILE);
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, 'utf8')) as SourceInfo;
  } catch {
    return null;
  }
}

/** Whether an imported skill's source has changed since it was copied (null: not imported, or source gone). */
export function updateAvailable(officeSkillsDir: string, name: string): boolean {
  const info = readSourceInfo(officeSkillsDir, name);
  if (!info || !existsSync(info.path)) return false;
  try {
    return sha(readFileSync(info.path, 'utf8')) !== info.hash;
  } catch {
    return false;
  }
}

export class SkillImporter {
  /**
   * @param roots where to look (Claude Code's skill and plugin folders)
   * @param officeSkillsDir ~/.office/skills, where imports go
   * @param existing names already in the office's catalog (built-in or mine)
   */
  constructor(
    private roots: ImportRoot[],
    private officeSkillsDir: string,
    private existing: () => Set<string>,
  ) {}

  private cache: { at: number; list: ImportableSkill[] } | null = null;

  /** Every skill found in the roots, one entry per distinct file. */
  list(fresh = false): ImportableSkill[] {
    if (!fresh && this.cache && Date.now() - this.cache.at < LIST_CACHE_MS) return this.cache.list;
    const list = this.scan();
    this.cache = { at: Date.now(), list };
    return list;
  }

  private scan(): ImportableSkill[] {
    const seen = new Set<string>();
    const out: ImportableSkill[] = [];
    const existing = this.existing();
    for (const root of this.roots) {
      let rootDir = root.dir;
      try {
        rootDir = realpathSync(root.dir);
      } catch {
        continue; // the folder doesn't exist on this Mac
      }
      for (const file of findSkillFiles(rootDir)) {
        const real = file;
        if (seen.has(real)) continue;
        seen.add(real);
        let text: string;
        let skill;
        try {
          if (statSync(real).size > MAX_SKILL_BYTES) continue;
          text = readFileSync(real, 'utf8');
          skill = parseSkill(text, file);
        } catch {
          continue; // not a valid skill file
        }
        const source = pluginName(real, rootDir) ?? root.label;
        const info = readSourceInfo(this.officeSkillsDir, skill.name);
        // The same skill when it's this file, or when the plugin moved it (plugin caches are versioned,
        // so an upgrade changes the path) and the old file is gone.
        const fromHere = !!info && (info.path === real || (info.source === source && !existsSync(info.path)));
        const status: ImportableSkill['status'] = fromHere
          ? info.hash === sha(text)
            ? 'imported'
            : 'update'
          : existing.has(skill.name)
            ? 'taken'
            : 'new';
        const siblings = (() => {
          try {
            return readdirSync(dirname(real)).filter((f) => f !== 'SKILL.md' && !f.startsWith('.')).length;
          } catch {
            return 0;
          }
        })();
        out.push({
          key: keyOf(real),
          name: skill.name,
          description: skill.description,
          source,
          path: real,
          extraFiles: siblings,
          wrapper: isWrapperSkill(skill.body),
          status,
        });
      }
    }
    return out.sort((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name));
  }

  private find(key: string): ImportableSkill {
    const s = this.list(true).find((x) => x.key === key);
    if (!s) throw new Error('That skill is no longer there. Refresh the list.');
    return s;
  }

  /** The office copy and the source's current text, for the update diff. */
  diff(key: string): { name: string; current: string; incoming: string } {
    const s = this.find(key);
    const current = join(this.officeSkillsDir, s.name, 'SKILL.md');
    return { name: s.name, current: existsSync(current) ? readFileSync(current, 'utf8') : '', incoming: readFileSync(s.path, 'utf8') };
  }

  /**
   * Copies a discovered skill into the office. Only paths found by list() can be imported, so this
   * can't be used to read arbitrary files. Never overwrites a skill that came from somewhere else.
   */
  import(key: string): { name: string } {
    const s = this.find(key);
    if (!SKILL_NAME.test(s.name)) throw new Error(`"${s.name}" isn't a valid skill name here.`);
    if (s.status === 'taken') throw new Error(`The office already has a skill named "${s.name}". Delete or rename it on the Team page first.`);
    if (statSync(s.path).size > MAX_SKILL_BYTES) throw new Error(`${basename(s.path)} is too large to use as a skill.`);
    const text = readFileSync(s.path, 'utf8');
    parseSkill(text, s.path);
    const dir = join(this.officeSkillsDir, s.name);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'SKILL.md'), text);
    const info: SourceInfo = { path: s.path, source: s.source, hash: sha(text), importedAt: Date.now() };
    writeFileSync(join(dir, SOURCE_FILE), JSON.stringify(info, null, 2));
    this.cache = null;
    return { name: s.name };
  }
}
