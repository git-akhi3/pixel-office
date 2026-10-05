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
  skills: z.array(z.string()).default([]),
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

export function loadSkill(skillsDir: string, name: string): Skill {
  const file = join(skillsDir, name, 'SKILL.md');
  if (!existsSync(file)) throw new Error(`Unknown skill "${name}" (expected ${file})`);
  const { data, body } = splitFrontmatter(readFileSync(file, 'utf8'), file);
  const meta = z.object({ name: z.string(), description: z.string() }).parse(data);
  return { name: meta.name, description: meta.description, body };
}

export function parseAgent(text: string, file: string, skillsDir: string): AgentDef {
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

export function loadAgents(agentsDir: string, skillsDir: string): Record<Role, AgentDef> {
  const out: Partial<Record<Role, AgentDef>> = {};
  for (const f of readdirSync(agentsDir).filter((f) => f.endsWith('.md'))) {
    const def = parseAgent(readFileSync(join(agentsDir, f), 'utf8'), f, skillsDir);
    if (`${def.name}.md` !== f) throw new Error(`${f}: name "${def.name}" does not match the file name`);
    out[def.name] = def;
  }
  const missing = ROLES.filter((r) => !out[r]);
  if (missing.length) throw new Error(`Missing agent definitions: ${missing.join(', ')}`);
  return out as Record<Role, AgentDef>;
}

/** The text appended to Claude Code's system prompt for this agent. */
export function systemPromptFor(agent: AgentDef): string {
  const skills = agent.skillDefs.map((s) => `\n\n## Skill: ${s.name}\n${s.description}\n\n${s.body}`).join('');
  return `${agent.prompt}${skills}`;
}
