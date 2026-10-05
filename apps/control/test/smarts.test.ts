import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadAgents, withRepoSkills } from '../server/src/agents.js';
import { openDb, usagePause, type Settings } from '../server/src/db/index.js';
import { Knowledge, MAX_KNOWLEDGE_LINES, proposalFromRetro } from '../server/src/knowledge.js';
import { createRepo } from '../server/src/repos.js';
import { execSync } from 'node:child_process';

const appDir = resolve(import.meta.dirname, '..');
const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'office-smarts-')));

describe('knowledge files', () => {
  async function setup() {
    const dir = tmp();
    const db = openDb(join(dir, 'db.sqlite'));
    execSync(`mkdir -p "${dir}/app" && cd "${dir}/app" && git init -q -b main`);
    const repo = await createRepo(db, { name: 'app', path: join(dir, 'app') });
    return { k: new Knowledge(db, join(dir, 'knowledge')), repo };
  }

  it('turns a retro note into a proposal and appends it only when accepted', async () => {
    const { k, repo } = await setup();
    const note = proposalFromRetro('---\n---\n- **Went well:** x\n- **Went wrong:** y\n- **Knowledge-file edit:** Run `npm run gen` before typecheck.');
    expect(note).toBe('Run `npm run gen` before typecheck.');
    const p = k.propose(repo.id, 1, note!);
    expect(k.read(repo.id)).toBe('');
    k.decide(p.id, 'accept');
    expect(k.read(repo.id)).toContain('- Run `npm run gen` before typecheck.');
    expect(() => k.decide(p.id, 'accept')).toThrow(/already/);
  });

  it('accepts my edited wording and ignores rejected or empty notes', async () => {
    const { k, repo } = await setup();
    k.decide(k.propose(repo.id, 1, 'flaky payment mocks').id, 'accept', 'Payment mocks are flaky: run them alone first.');
    k.decide(k.propose(repo.id, 2, 'something wrong').id, 'reject');
    expect(k.read(repo.id)).toContain('Payment mocks are flaky');
    expect(k.read(repo.id)).not.toContain('something wrong');
    expect(proposalFromRetro('- **Knowledge-file edit:** none')).toBeNull();
    expect(proposalFromRetro('- **Knowledge-file edit:** None.')).toBeNull();
  });

  it('caps the file so it stays cheap to load into every agent', async () => {
    const { k, repo } = await setup();
    expect(() => k.write(repo.id, Array.from({ length: MAX_KNOWLEDGE_LINES + 1 }, (_, i) => `- ${i}`).join('\n'))).toThrow(/keep it under/);
  });
});

describe('custom agents and skills', () => {
  it('a custom agent overrides the default; skills resolve custom first', () => {
    const custom = tmp();
    const agents = join(custom, 'agents');
    const skills = join(custom, 'skills');
    mkdirSync(agents);
    mkdirSync(join(skills, 'fastify-conventions'), { recursive: true });
    writeFileSync(
      join(agents, 'coder.md'),
      readFileSync(join(appDir, 'agents', 'coder.md'), 'utf8').replace('model: claude-sonnet-5-5', 'model: claude-opus-5-5'),
    );
    writeFileSync(join(skills, 'fastify-conventions', 'SKILL.md'), '---\nname: fastify-conventions\ndescription: How we write Fastify routes.\n---\nUse zod for bodies.');
    const loaded = loadAgents([agents, join(appDir, 'agents')], [skills, join(appDir, 'skills')]);
    expect(loaded.coder.model).toBe('claude-opus-5-5'); // mine
    expect(loaded.architect.model).toBe('claude-opus-5-5'); // default
    expect(loaded.tester.model).toBe('claude-sonnet-5-5'); // default

    const withExtra = withRepoSkills(loaded.coder, { coder: ['fastify-conventions'], tester: ['x'] }, [skills, join(appDir, 'skills')]);
    expect(withExtra.skills).toEqual(['write-pr', 'fastify-conventions']);
    expect(withRepoSkills(loaded.reviewer, { coder: ['fastify-conventions'] }, [skills]).skills).toEqual([]);
  });
});

describe('usage pause', () => {
  const base: Settings = { autoApprovePush: false, concurrency: 2, reviewAutoPickup: false, reviewMinLines: 0, usagePauseAt: 0.9, rateLimit: null };
  const now = 1_000_000_000_000;
  const at = (fiveHour: number, sevenDay = 0.1, reset = now / 1000 + 3600) => ({ ...base, rateLimit: { fiveHour, sevenDay, fiveHourResetsAt: reset, sevenDayResetsAt: reset + 86400, at: now } });

  it('pauses near the 5-hour or 7-day limit until that window resets', () => {
    expect(usagePause(at(0.5), now).paused).toBe(false);
    expect(usagePause(at(0.92), now)).toMatchObject({ paused: true, window: '5-hour', until: now + 3600_000 });
    expect(usagePause(at(0.2, 0.95), now)).toMatchObject({ paused: true, window: '7-day' });
  });

  it('stops pausing once the reset time has passed, or when the threshold is 100%', () => {
    expect(usagePause(at(0.95, 0.1, now / 1000 - 1), now).paused).toBe(false);
    expect(usagePause({ ...at(0.99), usagePauseAt: 1 }, now).paused).toBe(false);
  });
});
