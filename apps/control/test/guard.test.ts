import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  checkCommand,
  checkToolCall,
  globToRegExp,
  matchesAllowlist,
  splitCommand,
  type GuardContext,
} from '../server/src/guard.js';
import { BASE_ALLOWLIST, effectiveAllowlist } from '../server/src/repos.js';
import type { Repo } from '../server/src/db/schema.js';

let wt: string;
let ctx: (write?: GuardContext['write']) => GuardContext;

beforeAll(() => {
  // Same shape as real worktrees: ~/.office/worktrees/<id>
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'guard-home-')));
  wt = join(home, '.office', 'worktrees', '1');
  mkdirSync(join(wt, 'src'), { recursive: true });
  ctx = (write = 'all') => ({
    worktree: wt,
    write,
    testGlobs: ['**/*.test.ts', '**/__tests__/**'],
    allowlist: [...BASE_ALLOWLIST, 'npm test', 'npm run lint', 'npx vitest *'],
  });
});

const decision = (d: { decision: string }) => d.decision;

describe('worktree under ~/.office', () => {
  it('reads and writes ordinary files in the worktree', () => {
    expect(decision(checkToolCall(ctx(), 'Read', { file_path: join(wt, 'src/math.js') }))).toBe('allow');
    expect(decision(checkToolCall(ctx(), 'Read', { file_path: 'src/math.js' }))).toBe('allow');
    expect(decision(checkToolCall(ctx(), 'Edit', { file_path: join(wt, 'src/math.js') }))).toBe('allow');
    expect(decision(checkCommand(ctx(), `cat ${wt}/src/math.js`))).toBe('allow');
  });

  it('still blocks the rest of ~/.office', () => {
    const office = join(wt, '..', '..');
    expect(decision(checkToolCall(ctx(), 'Read', { file_path: join(office, 'env') }))).toBe('deny');
    expect(decision(checkCommand(ctx(), `cat ${office}/env`))).toBe('deny');
    expect(decision(checkCommand(ctx(), 'cat ~/.office/env'))).toBe('deny');
    expect(decision(checkCommand(ctx(), 'ls ~/.office/tasks'))).toBe('deny');
  });
});

describe('file writes', () => {
  it('allows writes inside the worktree', () => {
    expect(decision(checkToolCall(ctx(), 'Write', { file_path: join(wt, 'src/a.ts') }))).toBe('allow');
    expect(decision(checkToolCall(ctx(), 'Edit', { file_path: 'src/new/dir/b.ts' }))).toBe('allow');
  });

  it('blocks writes outside the worktree, including via ..', () => {
    expect(decision(checkToolCall(ctx(), 'Write', { file_path: '/tmp/outside.txt' }))).toBe('deny');
    expect(decision(checkToolCall(ctx(), 'Write', { file_path: join(wt, '../escape.txt') }))).toBe('deny');
  });

  it('treats /var and /private/var as the same place (macOS)', () => {
    const viaVar = wt.replace(/^\/private/, '');
    expect(decision(checkToolCall(ctx(), 'Write', { file_path: join(viaVar, 'src/a.ts') }))).toBe('allow');
  });

  it('blocks writes through a symlink that points outside', () => {
    const link = join(wt, 'link-out');
    symlinkSync(tmpdir(), link);
    expect(decision(checkToolCall(ctx(), 'Write', { file_path: join(link, 'x.txt') }))).toBe('deny');
  });

  it('blocks the .git directory', () => {
    expect(decision(checkToolCall(ctx(), 'Write', { file_path: '.git/config' }))).toBe('deny');
  });

  it('enforces read-only and tests-only roles', () => {
    expect(decision(checkToolCall(ctx('none'), 'Edit', { file_path: 'src/a.ts' }))).toBe('deny');
    expect(decision(checkToolCall(ctx('tests'), 'Edit', { file_path: 'src/a.ts' }))).toBe('deny');
    expect(decision(checkToolCall(ctx('tests'), 'Write', { file_path: 'src/a.test.ts' }))).toBe('allow');
    expect(decision(checkToolCall(ctx('tests'), 'Write', { file_path: 'src/__tests__/b.ts' }))).toBe('allow');
  });
});

describe('secrets (ported from zobaze-item-search guard.sh)', () => {
  it.each(['.env', '.env.local', '.env.production', 'config/server.pem', 'id_rsa', 'deploy/id_ed25519'])(
    'blocks reading and writing %s',
    (f) => {
      expect(decision(checkToolCall(ctx(), 'Read', { file_path: f }))).toBe('deny');
      expect(decision(checkToolCall(ctx(), 'Write', { file_path: f }))).toBe('deny');
    },
  );

  it('allows .env.example', () => {
    expect(decision(checkToolCall(ctx(), 'Read', { file_path: '.env.example' }))).toBe('allow');
  });

  it('blocks reads outside the worktree', () => {
    expect(decision(checkToolCall(ctx(), 'Read', { file_path: '/etc/hosts' }))).toBe('deny');
    expect(decision(checkToolCall(ctx(), 'Grep', { pattern: 'x', path: '/Users' }))).toBe('deny');
    expect(decision(checkToolCall(ctx(), 'Glob', { pattern: '/Users/**/*.ts' }))).toBe('deny');
  });

  it.each([
    'cat .env',
    'cat ./config/.env.local',
    'grep KEY .env',
    'cat ~/.ssh/id_rsa',
    'ls ~/.office',
    'cat ~/.config/gh/hosts.yml',
    'echo $CLAUDE_CODE_OAUTH_TOKEN',
    'echo ${GH_TOKEN}',
    'env',
    'env | grep CLAUDE',
    'printenv',
    'security find-generic-password -s x',
  ])('blocks %s', (cmd) => {
    expect(decision(checkCommand(ctx(), cmd))).toBe('deny');
  });
});

describe('git and GitHub (ported from guard.sh, stricter)', () => {
  it.each([
    'git push',
    'git push --force origin feat',
    'git push origin main',
    'git push -f',
    'gh pr merge 12',
    'gh pr create --fill',
    'gh api repos/x/y -X DELETE',
    'git remote set-url origin https://evil.example',
    'git config user.email x@y',
    'git commit -m "x"',
    'git reset --hard HEAD~3',
    'git rebase main',
    'git worktree add ../x',
    'git status && git push',
  ])('blocks %s', (cmd) => {
    expect(decision(checkCommand(ctx(), cmd))).toBe('deny');
  });
});

describe('shell allow-list', () => {
  it('allows listed commands, with arguments and chains', () => {
    for (const cmd of ['git status', 'git diff main...HEAD', 'npm test', 'npm run lint', 'npx vitest run src', 'git log --oneline -5 && git status']) {
      expect(decision(checkCommand(ctx(), cmd)), cmd).toBe('allow');
    }
  });

  it('sees through plain ( ) groups but still asks about $( )', () => {
    expect(decision(checkCommand(ctx(), '(cd src && npm test 2>&1 | tail -4); git status --short'))).toBe('allow');
    expect(decision(checkCommand(ctx(), '(cd / && ls)'))).toBe('deny');
    expect(decision(checkCommand(ctx(), 'echo $(cat x)'))).toBe('ask');
  });

  it.each([
    'rg --pre ./evil.sh foo',
    'rg foo --pre=./evil.sh',
    'git grep -O./evil.sh foo',
    'git grep --open-files-in-pager=sh foo',
    'git diff --ext-diff',
    'git diff --output=/tmp/x',
    'git -c core.pager=./evil.sh log',
    'sort -o out.txt in.txt',
    'tree -o x.txt',
    // bundled short flags and abbreviated long options (from review)
    'git grep -lOsh pat',
    'git grep --open-files=sh pat',
    'git grep --open=sh pat',
    'git diff --outp=/tmp/x',
    'git diff --ext',
    'git -C /etc log',
    'git --git-dir=/x/.git log',
    'sort -uo f in.txt',
    'sort --outp=f in.txt',
    'sort --compress-program=sh x',
    'cd src && git grep -nO./x.sh foo',
  ])('blocks read-only tools used to run or write: %s', (cmd) => {
    expect(decision(checkCommand(ctx(), cmd))).toBe('deny');
  });

  it('still allows the ordinary flags of those tools', () => {
    for (const cmd of ['git grep -n -c foo', 'git log --oneline -5', 'git diff --stat main', 'sort -u -r x', 'git show HEAD:src/a.ts', 'rg -n foo src', 'git log --oneline -- src']) {
      expect(decision(checkCommand(ctx(), cmd)), cmd).toBe('allow');
    }
  });

  it('allows read-only text pipelines', () => {
    expect(decision(checkCommand(ctx(), `cat tsconfig*.json | grep -n "strict\\|noUnused" ; grep -o '"category": "[^"]*"' src/seed.json | sort | uniq -c | head -30`))).toBe('allow');
    expect(decision(checkCommand(ctx(), 'find . -name x -delete'))).toBe('ask');
    expect(decision(checkCommand(ctx(), "sed -i 's/a/b/' src/a.ts"))).toBe('ask');
    expect(decision(checkCommand(ctx(), 'echo hi > /tmp/x'))).toBe('deny');
  });

  it('allows cd inside the worktree but not outside', () => {
    expect(decision(checkCommand(ctx(), 'cd src && ls'))).toBe('allow');
    expect(decision(checkCommand(ctx(), 'cd / && ls'))).toBe('deny');
  });

  it('asks about anything else, naming the unlisted parts', () => {
    const d = checkCommand(ctx(), 'npm test && curl --version');
    expect(d.decision).toBe('ask');
    if (d.decision === 'ask') expect(d.unmatched).toEqual(['curl --version']);
  });

  it('asks about command substitution even when the parts look allowed', () => {
    expect(decision(checkCommand(ctx(), 'ls $(cat list)'))).toBe('ask');
    expect(decision(checkCommand(ctx(), 'ls `pwd`'))).toBe('ask');
  });

  it('does not let a prefix match a different command', () => {
    expect(matchesAllowlist('lsof -i', ['ls'])).toBe(false);
    expect(matchesAllowlist('npm test -- --watch', ['npm test'])).toBe(true);
    expect(matchesAllowlist('npm testing', ['npm test'])).toBe(false);
  });

  it('checks redirect targets', () => {
    expect(decision(checkCommand(ctx(), 'npm test > /tmp/out.txt'))).toBe('deny');
    expect(decision(checkCommand(ctx(), 'npm test > out.txt'))).toBe('allow');
    expect(decision(checkCommand(ctx(), 'npm test 2>/dev/null'))).toBe('allow');
    expect(decision(checkCommand(ctx('none'), 'npm test > out.txt'))).toBe('deny');
  });

  it('splits command lines, respecting quotes and escapes', () => {
    expect(splitCommand('a && b || c; d | e')).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(splitCommand(`grep -rn "/add\\|AddItem" src | head -5`)).toEqual([`grep -rn "/add\\|AddItem" src`, 'head -5']);
    expect(splitCommand(`git log --format='%h|%s' && ls`)).toEqual([`git log --format='%h|%s'`, 'ls']);
    expect(splitCommand('grep a\\|b src')).toEqual(['grep a\\|b src']);
  });

  it('allows the read-only exploration command an architect actually ran', () => {
    const cmd = `cd ${wt}/src && grep -rn "/add\\|\\"/add\\|AddItemScreen\\|categor" . --include=*.tsx | grep -v "^src/components/CreateItemSheet" | head -50; cat ui.tsx; git log --oneline -12; ls tests`;
    expect(decision(checkCommand(ctx(), cmd))).toBe('allow');
  });
});

describe('other tools', () => {
  it('denies tools office agents do not have', () => {
    for (const t of ['Agent', 'Task', 'Skill', 'Mystery']) expect(decision(checkToolCall(ctx(), t, {}))).toBe('deny');
  });
});

describe('globToRegExp', () => {
  it('matches like a shell glob', () => {
    expect(globToRegExp('**/*.test.ts').test('a/b/c.test.ts')).toBe(true);
    expect(globToRegExp('**/*.test.ts').test('c.test.ts')).toBe(true);
    expect(globToRegExp('src/*.ts').test('src/a/b.ts')).toBe(false);
  });
});

describe('effectiveAllowlist', () => {
  it('allows each part of a chained configured command', () => {
    const repo = { buildCmd: null, testCmd: 'cd app && ../poc/.venv/bin/python -m pytest -q tests', lintCmd: 'poc/.venv/bin/ruff check .', allowlist: [] } as unknown as Repo;
    const allowlist = effectiveAllowlist(repo);
    const c = { ...ctx(), allowlist };
    expect(decision(checkCommand(c, 'cd app && ../poc/.venv/bin/python -m pytest -q tests'))).toBe('allow');
    expect(decision(checkCommand(c, 'poc/.venv/bin/ruff check .'))).toBe('allow');
    expect(allowlist).not.toContain('cd app');
  });
});
