// The safety guard. Runs in the PreToolUse hook, which sees every tool call
// (canUseTool misses commands Claude Code auto-approves as read-only).
// Pure functions: no I/O except realpath lookups.

import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export type WriteAccess = 'none' | 'tests' | 'all';

export interface GuardContext {
  /** realpath of the task's worktree */
  worktree: string;
  write: WriteAccess;
  testGlobs: string[];
  allowlist: string[];
}

export type GuardDecision =
  | { decision: 'allow' }
  | { decision: 'deny'; reason: string }
  | { decision: 'ask'; reason: string; subject: string; unmatched: string[] };

const allow = (): GuardDecision => ({ decision: 'allow' });
const deny = (reason: string): GuardDecision => ({ decision: 'deny', reason });

// ---------------------------------------------------------------- paths

/** realpath that also works for files that don't exist yet (resolves the nearest existing parent). */
export function realPath(p: string): string {
  let current = resolve(p);
  const rest: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    rest.unshift(basename(current));
    current = parent;
  }
  try {
    return join(realpathSync(current), ...rest);
  } catch {
    return resolve(p);
  }
}

export function isInside(root: string, p: string): boolean {
  const rel = relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

const SAFE_ENV_EXAMPLES = /\.env\.(example|sample|template|dist)$/i;

export function isSecretPath(p: string): boolean {
  const name = basename(p).toLowerCase();
  if (SAFE_ENV_EXAMPLES.test(name)) return false;
  if (name === '.env' || name.startsWith('.env.')) return true;
  if (/\.(pem|key|p12|pfx|keystore)$/.test(name)) return true;
  if (/^id_(rsa|ed25519|ecdsa|dsa)/.test(name)) return true;
  if (['.netrc', '.npmrc', '.pypirc', 'credentials', 'credentials.json', '.git-credentials'].includes(name)) return true;
  return /\/(\.ssh|\.aws|\.gnupg|\.office|\.docker|Keychains)(\/|$)|\/\.config\/gh(\/|$)/.test(p);
}

/** Minimal glob: ** matches across directories, * and ? within a segment. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') {
        i++;
        re += '(?:.*/)?';
      } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function matchesAnyGlob(relPath: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(relPath));
}

/**
 * Secret check relative to the worktree when the path is inside it: the worktree itself
 * lives under ~/.office, which must not make every file look secret.
 */
function isSecretFor(ctx: GuardContext, real: string): boolean {
  return isSecretPath(isInside(ctx.worktree, real) ? `/${relative(ctx.worktree, real)}` : real);
}

function checkRead(ctx: GuardContext, p: string): GuardDecision {
  const real = realPath(isAbsolute(p) ? p : join(ctx.worktree, p));
  if (isSecretFor(ctx, real)) return deny(`secrets are off-limits: ${p}`);
  if (!isInside(ctx.worktree, real) && !isInside(realPath(tmpdir()), real)) {
    return deny(`reads are limited to the task's worktree: ${p}`);
  }
  return allow();
}

function checkWrite(ctx: GuardContext, p: string): GuardDecision {
  const real = realPath(isAbsolute(p) ? p : join(ctx.worktree, p));
  if (isSecretFor(ctx, real)) return deny(`secrets are off-limits: ${p}`);
  if (!isInside(ctx.worktree, real)) return deny(`writes outside the worktree are blocked: ${p}`);
  const rel = relative(ctx.worktree, real).split(sep).join('/');
  if (rel === '.git' || rel.startsWith('.git/')) return deny('the .git directory is off-limits');
  if (ctx.write === 'none') return deny('this role is read-only');
  if (ctx.write === 'tests' && !matchesAnyGlob(rel, ctx.testGlobs)) {
    return deny(`this role may only write test files (${ctx.testGlobs.join(', ')}): ${rel}`);
  }
  return allow();
}

// ---------------------------------------------------------------- shell

/** Always denied, whatever the allow-list says. */
const DENIED_COMMANDS: Array<[RegExp, string]> = [
  [/\bgit\s+push\b/, 'only the office pushes, after your approval'],
  [/(^|[\s;&|(])gh(\s|$)/, 'only the office talks to GitHub'],
  [/\bgit\s+(remote\s+(add|set-url|remove|rm|rename)|config|commit|merge|rebase|tag|worktree|filter-branch|update-ref|reset\s+--hard|clean\s+-\w*f)\b/, 'the office manages git history; agents only edit files'],
  [/\bsudo\b/, 'no sudo'],
  // Flags that make "read-only" tools run programs or write files.
  [/\brg\b[^|;&]*\s--pre(-glob)?(=|\s)/, 'rg --pre runs a program'],
  [/\bgit\b[^|;&]*\s(-O|--open-files-in-pager|--ext-diff|--output)(\S*)/, 'that git flag runs a program or writes a file'],
  [/\bgit\s+(-c|--config-env|--exec-path)\b/, 'no git config overrides'],
  [/\b(sort|tree)\b[^|;&]*\s(-o|--output)(=|\s|\S)/, 'that flag writes a file'],
  [/\brm\s+-\w*r\w*\s+(\/|~|\$HOME)(\s|$|\/\s|\/$)/, 'no deleting outside the project'],
  [/\b(curl|wget)\b[^|]*\|\s*(ba|z)?sh\b/, 'no piping downloads into a shell'],
  [/\b(printenv|security|launchctl|crontab|osascript)\b|(^|[;&|]\s*)(env|set|export\s+-p|declare\s+-x)\s*($|[;&|])/, 'no reading the environment or system credentials'],
  [/\$\{?\w*(TOKEN|SECRET|KEY|OAUTH|PASSWORD|CREDENTIAL)\w*/i, 'no reading tokens or secrets from the environment'],
  [/(^|[\s'"=/])\.env(\.(?!example|sample|template|dist)[\w-]+)?(?=$|[\s'";|&)/])/, 'secrets are off-limits: .env'],
  [/(^|[\s'"=/])(\.ssh|\.aws|\.gnupg|\.netrc|\.npmrc|\.git-credentials|id_rsa|id_ed25519)\b|\.pem\b|\.config\/gh/, 'secrets are off-limits'],
  // ~/.office holds the token and other tasks; only the worktrees under it are fair game.
  [/\.office(?!\/worktrees\/)(\/|\b)/, 'secrets are off-limits: ~/.office'],
];

/**
 * Splits a command line into simple commands on && || ; | and newlines, outside quotes.
 * Anything it gets wrong only over-splits, which causes an "ask", never an "allow".
 */
export function splitCommand(command: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote) {
      current += c;
      if (c === '\\' && quote === '"' && i + 1 < command.length) current += command[++i];
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '\\' && i + 1 < command.length) {
      current += c + command[++i];
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      current += c;
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      parts.push(current);
      current = '';
      i++;
      continue;
    }
    // Plain ( ) group commands; $( and <( are caught separately and always ask.
    const grouping = (c === '(' && command[i - 1] !== '$' && command[i - 1] !== '<') || c === ')';
    if (c === ';' || c === '|' || c === '\n' || grouping) {
      parts.push(current);
      current = '';
      continue;
    }
    current += c;
  }
  parts.push(current);
  return parts.map((p) => p.trim().replace(/\s+/g, ' ')).filter(Boolean);
}

export function matchesAllowlist(segment: string, allowlist: string[]): boolean {
  return allowlist.some((entry) => {
    const e = entry.trim().replace(/\s+/g, ' ');
    if (e.endsWith(' *')) return segment.startsWith(e.slice(0, -1));
    return segment === e || segment.startsWith(`${e} `);
  });
}

function redirectTargets(command: string): string[] {
  return [...command.matchAll(/(?:^|[^<>&\d])\d?>>?\s*([^\s;&|<>]+)/g)].map((m) => m[1]!).filter((t) => !t.startsWith('&'));
}

export function checkCommand(ctx: GuardContext, command: string): GuardDecision {
  for (const [re, reason] of DENIED_COMMANDS) {
    if (re.test(command)) return deny(reason);
  }
  for (const target of redirectTargets(command)) {
    if (target === '/dev/null') continue;
    const decision = checkWrite(ctx, target);
    if (decision.decision !== 'allow') return decision;
  }

  const unmatched: string[] = [];
  if (/\$\(|`|<\(|\beval\b|\bsource\b|^\s*\.\s/.test(command)) unmatched.push(command.trim());
  for (const segment of splitCommand(command)) {
    const cd = segment.match(/^cd\s+(\S+)$/);
    if (cd) {
      const target = cd[1]!.replace(/^["']|["']$/g, '');
      if (isInside(ctx.worktree, realPath(isAbsolute(target) ? target : join(ctx.worktree, target)))) continue;
      return deny(`cd outside the worktree is blocked: ${target}`);
    }
    // Strip a trailing redirect (already checked above) before matching.
    const bare = segment.replace(/\s*\d?>>?\s*\S+/g, '').replace(/\s*2>&1/g, '').trim();
    if (!matchesAllowlist(bare, ctx.allowlist)) unmatched.push(bare);
  }
  if (unmatched.length) {
    return { decision: 'ask', reason: `not on the allow-list: ${unmatched.join(' ; ')}`, subject: command.trim(), unmatched };
  }
  return allow();
}

// ---------------------------------------------------------------- tool calls

export function checkToolCall(ctx: GuardContext, tool: string, input: Record<string, unknown>): GuardDecision {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : undefined);
  switch (tool) {
    case 'Read':
      return checkRead(ctx, str('file_path') ?? '');
    case 'Grep':
    case 'Glob': {
      const path = str('path');
      if (path) {
        const d = checkRead(ctx, path);
        if (d.decision !== 'allow') return d;
      }
      const pattern = str('pattern') ?? '';
      if (tool === 'Glob' && isAbsolute(pattern)) return checkRead(ctx, pattern.split('*')[0] || '/');
      return allow();
    }
    case 'Write':
    case 'Edit':
      return checkWrite(ctx, str('file_path') ?? '');
    case 'NotebookEdit':
      return checkWrite(ctx, str('notebook_path') ?? '');
    case 'Bash':
      return checkCommand(ctx, str('command') ?? '');
    case 'WebFetch':
    case 'WebSearch':
    case 'TodoWrite':
      return allow();
    default:
      return deny(`tool ${tool} is not available to office agents`);
  }
}
