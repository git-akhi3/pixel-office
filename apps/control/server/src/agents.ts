import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { ROLES, type Role } from './domain.js';

/** Tools an office agent may be given. Agent/Task/Skill are left out on purpose: no built-in subagents or skills. */
export const KNOWN_TOOLS = ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'TodoWrite'] as const;
const WRITE_TOOLS = ['Edit', 'Write', 'NotebookEdit'];

const frontmatter = z.object({
  name: z.enum(ROLES),
  description: z.string().min(1),
  model: z.string().min(1),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  tools: z.array(z.enum(KNOWN_TOOLS)).min(1),
  /** none: read-only. tests: may only write files matching the repo's test globs. all: anywhere in the worktree. */
  write: z.enum(['none', 'tests', 'all']).default('none'),
  skills: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/, 'skill names use lowercase letters, digits and dashes')).default([]),
  maxTurns: z.number().int().positive().default(60),
});

export interface Skill {
  name: string;
  description: string;
  body: string;
}

export interface AgentDef extends z.infer<typeof frontmatter> {
  prompt: string;
  skillDefs: Skill[];
}

function splitFrontmatter(text: string, file: string): { data: unknown; body: string } {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new Error(`${file}: missing --- frontmatter ---`);
  return { data: parseYaml(m[1]!), body: m[2]!.trim() };
}

/** Directories to search, highest priority first (my custom skills, then the built-in ones). */
type Dirs = string | string[];
const dirList = (d: Dirs) => (Array.isArray(d) ? d : [d]);

export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,47}$/;

export function parseSkill(text: string, file: string): Skill {
  const { data, body } = splitFrontmatter(text, file);
  const meta = z.object({ name: z.string().regex(SKILL_NAME, 'lowercase letters, digits and dashes'), description: z.string().min(1) }).safeParse(data);
  if (!meta.success) throw new Error(`${file}: ${meta.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  if (!body) throw new Error(`${file}: empty skill body`);
  return { name: meta.data.name, description: meta.data.description, body };
}

export function loadSkill(skillsDirs: Dirs, name: string): Skill {
  if (!SKILL_NAME.test(name)) throw new Error(`Invalid skill name "${name}"`);
  for (const dir of dirList(skillsDirs)) {
    const file = join(dir, name, 'SKILL.md');
    if (existsSync(file)) return parseSkill(readFileSync(file, 'utf8'), file);
  }
  throw new Error(`Unknown skill "${name}"`);
}

export function listSkills(skillsDirs: Dirs): Array<Skill & { source: string; text: string }> {
  const seen = new Map<string, Skill & { source: string; text: string }>();
  for (const dir of dirList(skillsDirs)) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const file = join(dir, name, 'SKILL.md');
      if (seen.has(name) || !existsSync(file)) continue;
      const text = readFileSync(file, 'utf8');
      try {
        seen.set(name, { ...parseSkill(text, file), source: dir, text });
      } catch {
        // A broken custom skill is reported when it is saved; skip it in listings.
      }
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function parseAgent(text: string, file: string, skillsDir: Dirs): AgentDef {
  const { data, body } = splitFrontmatter(text, file);
  const parsed = frontmatter.safeParse(data);
  if (!parsed.success) {
    throw new Error(`${file}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const def = parsed.data;
  const hasWriteTool = def.tools.some((t) => WRITE_TOOLS.includes(t));
  if (def.write === 'none' && hasWriteTool) throw new Error(`${file}: write is "none" but tools include a write tool`);
  if (def.write !== 'none' && !hasWriteTool) throw new Error(`${file}: write is "${def.write}" but no write tool is listed`);
  if (!body) throw new Error(`${file}: empty prompt`);
  return { ...def, prompt: body, skillDefs: def.skills.map((s) => loadSkill(skillsDir, s)) };
}

/**
 * Loads every role, taking each from the first directory that has a valid definition (my custom
 * version wins). A broken custom file is skipped, reported through onError, and the next one used.
 */
export function loadAgents(agentsDirs: Dirs, skillsDir: Dirs, onError: (message: string) => void = () => {}): Record<Role, AgentDef> {
  const out: Partial<Record<Role, AgentDef>> = {};
  const dirs = dirList(agentsDirs);
  dirs.forEach((dir, i) => {
    if (!existsSync(dir)) return;
    const isLast = i === dirs.length - 1;
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
      const role = f.slice(0, -3) as Role;
      if (out[role] || !ROLES.includes(role)) continue;
      try {
        const def = parseAgent(readFileSync(join(dir, f), 'utf8'), f, skillsDir);
        if (`${def.name}.md` !== f) throw new Error(`${f}: name "${def.name}" does not match the file name`);
        out[def.name] = def;
      } catch (e) {
        if (isLast) throw e; // the built-in definitions must be valid
        onError(`${join(dir, f)} is invalid, using the built-in ${role}: ${(e as Error).message}`);
      }
    }
  });
  const missing = ROLES.filter((r) => !out[r]);
  if (missing.length) throw new Error(`Missing agent definitions: ${missing.join(', ')}`);
  return out as Record<Role, AgentDef>;
}

/** The agent with a repo's extra skills for its role added. */
export function withRepoSkills(agent: AgentDef, repoSkills: Record<string, string[]>, skillsDirs: Dirs): AgentDef {
  const extra = (repoSkills[agent.name] ?? []).filter((n) => !agent.skills.includes(n));
  if (!extra.length) return agent;
  return { ...agent, skills: [...agent.skills, ...extra], skillDefs: [...agent.skillDefs, ...extra.map((n) => loadSkill(skillsDirs, n))] };
}

/** The text appended to Claude Code's system prompt for this agent. */
export function systemPromptFor(agent: AgentDef): string {
  const skills = agent.skillDefs.map((s) => `\n\n## Skill: ${s.name}\n${s.description}\n\n${s.body}`).join('');
  return `${agent.prompt}${skills}`;
}
