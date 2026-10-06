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
const MAX_FILES = 3000;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.venv', '__pycache__']);

export const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const keyOf = (realPath: string) => sha(realPath).slice(0, 16);

/** SKILL.md files under a directory, without following symlinked directories. */
function findSkillFiles(dir: string): string[] {
  const found: string[] = [];
  let visited = 0;
  const walk = (d: string, depth: number) => {
    if (depth > MAX_DEPTH || visited > MAX_FILES) return;
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      visited++;
      if (e.isDirectory() && !SKIP_DIRS.has(e.name)) walk(join(d, e.name), depth + 1);
      else if (e.isFile() && e.name === 'SKILL.md') found.push(join(d, e.name));
    }
  };
  if (existsSync(dir)) walk(dir, 0);
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

  /** Every skill found in the roots, one entry per distinct file. */
  list(): ImportableSkill[] {
    const seen = new Set<string>();
    const out: ImportableSkill[] = [];
    const existing = this.existing();
    for (const root of this.roots) {
      for (const file of findSkillFiles(root.dir)) {
        let real: string;
        try {
          real = realpathSync(file);
        } catch {
          continue;
        }
        if (seen.has(real)) continue;
        seen.add(real);
        let text: string;
        let skill;
        try {
          text = readFileSync(real, 'utf8');
          skill = parseSkill(text, file);
        } catch {
          continue; // not a valid skill file
        }
        const info = readSourceInfo(this.officeSkillsDir, skill.name);
        const fromHere = info?.path === real;
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
          source: pluginName(real, root.dir) ?? root.label,
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
    const s = this.list().find((x) => x.key === key);
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
    if (statSync(s.path).size > 200_000) throw new Error(`${basename(s.path)} is too large to use as a skill.`);
    const text = readFileSync(s.path, 'utf8');
    parseSkill(text, s.path);
    const dir = join(this.officeSkillsDir, s.name);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'SKILL.md'), text);
    const info: SourceInfo = { path: s.path, source: s.source, hash: sha(text), importedAt: Date.now() };
    writeFileSync(join(dir, SOURCE_FILE), JSON.stringify(info, null, 2));
    return { name: s.name };
  }
}
