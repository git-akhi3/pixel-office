import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadAgents, parseAgent, systemPromptFor } from '../server/src/agents.js';

const appDir = resolve(import.meta.dirname, '..');
const agentsDir = join(appDir, 'agents');
const skillsDir = join(appDir, 'skills');

const agent = (front: string, body = 'You are a test agent.') => `---\n${front}\n---\n${body}\n`;

describe('agent definitions', () => {
  it('loads every role from apps/control/agents', () => {
    const agents = loadAgents(agentsDir, skillsDir);
    expect(Object.keys(agents).sort()).toEqual(['all-rounder', 'architect', 'coder', 'debugger', 'manager', 'researcher', 'reviewer', 'tester', 'ui-coder', 'verifier']);
    expect(agents.verifier).toMatchObject({ model: 'claude-sonnet-5-5', write: 'none' });
    expect(agents.architect.model).toBe('claude-opus-5-5');
    expect(agents['all-rounder']).toMatchObject({ model: 'claude-opus-5-5', effort: 'high', write: 'all' });
    expect(agents['all-rounder'].tools).toEqual(expect.arrayContaining(['Bash', 'Edit', 'WebSearch']));
    expect(agents.coder.model).toBe('claude-sonnet-5-5');
    expect(agents.coder.write).toBe('all');
    expect(agents.tester.write).toBe('tests');
    expect(agents.reviewer.write).toBe('none');
    expect(systemPromptFor(agents.coder)).toContain('## Skill: write-pr');
  });

  it('never gives an agent the subagent or skill tools', () => {
    for (const a of Object.values(loadAgents(agentsDir, skillsDir))) {
      expect(a.tools).not.toContain('Agent');
      expect(a.tools).not.toContain('Task');
      expect(a.tools).not.toContain('Skill');
    }
  });

  it('rejects a missing model', () => {
    expect(() => parseAgent(agent('name: coder\ndescription: x\ntools: [Read]'), 'coder.md', skillsDir)).toThrow(/model/);
  });

  it('rejects an unknown tool', () => {
    expect(() =>
      parseAgent(agent('name: coder\ndescription: x\nmodel: m\ntools: [Read, Agent]'), 'coder.md', skillsDir),
    ).toThrow(/tools/);
  });

  it('rejects a read-only agent with a write tool, and the reverse', () => {
    expect(() =>
      parseAgent(agent('name: reviewer\ndescription: x\nmodel: m\ntools: [Read, Edit]'), 'reviewer.md', skillsDir),
    ).toThrow(/read|write/);
    expect(() =>
      parseAgent(agent('name: coder\ndescription: x\nmodel: m\ntools: [Read]\nwrite: all'), 'coder.md', skillsDir),
    ).toThrow(/no write tool/);
  });

  it('rejects an unknown skill', () => {
    expect(() =>
      parseAgent(agent('name: coder\ndescription: x\nmodel: m\ntools: [Read]\nskills: [nope]'), 'coder.md', skillsDir),
    ).toThrow(/Unknown skill/);
  });
});
