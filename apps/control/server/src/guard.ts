// The safety guard. Runs in the PreToolUse hook, which sees every tool call
// (canUseTool misses commands Claude Code auto-approves as read-only).
// Pure functions: no I/O except realpath lookups.

import { existsSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { GRAPH_TOOLS } from './graph.js';

export type WriteAccess = 'none' | 'tests' | 'all';

export interface GuardContext {
  /** realpath of the task's worktree */
  worktree: string;
  write: WriteAccess;
  testGlobs: string[];
  allowlist: string[];
  /** realpaths of extra folders this run may read (never write): the task's attachments. */
  readRoots?: string[];
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
  // The worktree and the attachment folders live under ~/.office: judge their files by their own path.
  const root = [ctx.worktree, ...(ctx.readRoots ?? [])].find((r) => isInside(r, real));
  return isSecretPath(root ? `/${relative(root, real)}` : real);
}

function checkRead(ctx: GuardContext, p: string): GuardDecision {
  const real = realPath(isAbsolute(p) ? p : join(ctx.worktree, p));
  if (isSecretFor(ctx, real)) return deny(`secrets are off-limits: ${p}`);
  if (!isInside(ctx.worktree, real) && !isInside(realPath(tmpdir()), real) && !(ctx.readRoots ?? []).some((r) => isInside(r, real))) {
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
  // Flags that make "read-only" tools run programs or write files: also checked per argument in unsafeFlag().
  [/\brg\b[^|;&]*\s--pre(-glob)?(=|\s)/, 'rg --pre runs a program'],
  [/\brm\s+-\w*r\w*\s+(\/|~|\$HOME)(\s|$|\/\s|\/$)/, 'no deleting outside the project'],
  [/\b(curl|wget)\b[^|]*\|\s*(ba|z)?sh\b/, 'no piping downloads into a shell'],
  [/\b(printenv|security|launchctl|crontab|osascript)\b|(^|[;&|]\s*)(env|set|export\s+-p|declare\s+-x)\s*($|[;&|])/, 'no reading the environment or system credentials'],
  [/\$\{?\w*(TOKEN|SECRET|KEY|OAUTH|PASSWORD|CREDENTIAL)\w*/i, 'no reading tokens or secrets from the environment'],
  [/(^|[\s'"=/])\.env(\.(?!example|sample|template|dist)[\w-]+)?(?=$|[\s'";|&)/])/, 'secrets are off-limits: .env'],
  [/(^|[\s'"=/])(\.ssh|\.aws|\.gnupg|\.netrc|\.npmrc|\.git-credentials|id_rsa|id_ed25519)\b|\.pem\b|\.config\/gh/, 'secrets are off-limits'],
  // ~/.office holds the token and other tasks; only the worktrees under it are fair game.
  [/\.office(?!\/worktrees\/)(\/|\b)/, 'secrets are off-limits: ~/.office'],
];

/** Long options that make a read-only tool run a program, write a file or read elsewhere. */
const DANGEROUS_LONG: Record<string, string[]> = {
  git: ['--open-files-in-pager', '--output', '--ext-diff', '--exec-path', '--config-env', '--upload-pack', '--receive-pack', '--exec', '--no-index', '--git-dir', '--work-tree', '--textconv'],
  sort: ['--output', '--compress-program'],
  tree: ['--output'],
  rg: ['--pre', '--pre-glob', '--search-zip', '--hostname-bin'],
};
/** Short flags with the same effect; they can be bundled (-lO) so any cluster containing them counts. */
const DANGEROUS_SHORT: Record<string, string> = { git: 'O', sort: 'o', tree: 'o', rg: 'z' };

/**
 * Tokenises one simple command and flags dangerous options, including bundled short flags and
 * abbreviated long options (git accepts --open-files= for --open-files-in-pager). Returns a reason or null.
 */
export function unsafeFlag(segment: string): string | null {
  const tokens = segment.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  const tool = basename((tokens[0] ?? '').replace(/["'\\]/g, ''));
  // uniq writes its second positional argument as an output file.
  if (tool === 'uniq') return tokens.slice(1).filter((t) => !t.startsWith('-')).length > 1 ? 'uniq writes its second argument as a file' : null;
  if (!(tool in DANGEROUS_LONG)) return null;
  if (tool === 'git') {
    // Global options before the subcommand: -c (config override) and -C (another directory).
    for (const t of tokens.slice(1)) {
      if (!t.startsWith('-')) break;
      if (/^-[cC]/.test(t) || t.startsWith('--git-dir') || t.startsWith('--work-tree') || t.startsWith('--exec-path') || t.startsWith('--config-env')) return 'no git global overrides (-c, -C, --git-dir, --work-tree)';
    }
  }
  for (const raw of tokens.slice(1)) {
    // The shell removes quotes and backslashes before the program sees an option: '--pre'=x is --pre=x.
    if (/^["'\\]*-/.test(raw) && /["'\\]/.test(raw.split('=')[0]!)) return `quoted or escaped option names are not allowed: ${raw}`;
    const t = raw;
    if (t === '--') break;
    if (t.startsWith('--')) {
      const name = t.split('=')[0]!;
      if (name.length >= 4 && DANGEROUS_LONG[tool]!.some((opt) => opt.startsWith(name))) return `${tool} ${name} can run a program or write a file`;
    } else if (/^-[A-Za-z]/.test(t) && t.slice(1).split(/[=\d]/)[0]!.includes(DANGEROUS_SHORT[tool]!)) {
      return `${tool} -${DANGEROUS_SHORT[tool]} can run a program or write a file`;
    }
  }
  return null;
}

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

/** Tools whose arguments are text, not files: their arguments are never read as paths. */
const TEXT_ONLY = new Set(['echo', 'printf', 'basename', 'dirname', 'tr', 'which', 'pwd']);
/** Tools whose first positional argument is a pattern (unless -e/-f give it). */
const PATTERN_FIRST = new Set(['grep', 'rg', 'egrep', 'fgrep']);

/**
 * File arguments of one simple command must stay inside the worktree (or the temp dir, or a read
 * root), and never be secrets: `cat ../../env` from a worktree under ~/.office would otherwise read
 * the office's token. Paths are resolved from `cwd` (after any cd in the same command). "Inside" is
 * judged on the written path, so the repo's setup links (a venv linked from the main checkout) still
 * work; the real path is still checked for secrets.
 */
export function shellPathProblem(ctx: GuardContext, segment: string, cwd: string): { decision: 'deny' | 'ask'; reason: string } | null {
  const tokens = (segment.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []).map((t) => t.replace(/^["']|["']$/g, '').replace(/\\(.)/g, '$1'));
  const tool = basename(tokens[0] ?? '');
  if (TEXT_ONLY.has(tool)) return null;
  const isGitGrep = tool === 'git' && tokens[1] === 'grep';
  let patternPending = PATTERN_FIRST.has(tool) || isGitGrep;
  // Written and real spellings both count (macOS: /var is /private/var).
  const roots = [ctx.worktree, tmpdir(), realPath(tmpdir()), ...(ctx.readRoots ?? [])];
  for (let i = isGitGrep ? 2 : 1; i < tokens.length; i++) {
    let v = tokens[i]!;
    if (v === '--') continue;
    if (v.startsWith('-')) {
      // -e PATTERN / --regexp=PATTERN: the pattern is given, the next positional is a path.
      if (patternPending && (v === '-e' || v === '--regexp')) {
        patternPending = false;
        i++;
        continue;
      }
      if (patternPending && v.startsWith('--regexp=')) {
        patternPending = false;
        continue;
      }
      if (!v.includes('=')) continue;
      v = v.slice(v.indexOf('=') + 1);
    } else if (patternPending) {
      patternPending = false;
      continue;
    }
    v = v.replace(/^</, '');
    if (!v) continue;
    // A variable or substitution could point anywhere: I decide.
    if (v.includes('$') || v.includes('`')) return { decision: 'ask', reason: `a file argument uses a variable: ${v}` };
    if (/^~[^/]/.test(v)) return { decision: 'deny', reason: `another user's home is off-limits: ${v}` };
    const pathLike = v.includes('/') || v === '..' || v.startsWith('~');
    if (!pathLike || /^\/+$/.test(v)) continue;
    // Globs: check the fixed part before the first wildcard.
    const expanded = v.replace(/^~(?=\/|$)/, homedir());
    const glob = expanded.search(/[*?[{]/);
    const fixed = glob === -1 ? expanded : expanded.slice(0, expanded.lastIndexOf('/', glob) + 1) || '.';
    const lexical = resolve(isAbsolute(fixed) ? fixed : join(cwd, fixed));
    const real = realPath(lexical);
    if (isSecretFor(ctx, real) || isSecretFor(ctx, lexical)) return { decision: 'deny', reason: `secrets are off-limits: ${v}` };
    if (!roots.some((r) => isInside(r, lexical) || isInside(r, real))) return { decision: 'deny', reason: `reads outside the worktree are blocked: ${v} (use paths inside the task's worktree)` };
  }
  return null;
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
  // Where relative paths point: the worktree, then wherever a `cd` in this command went.
  let cwd = ctx.worktree;
  for (const segment of splitCommand(command)) {
    const cd = segment.match(/^cd\s+(\S+)$/);
    if (cd) {
      const target = cd[1]!.replace(/^["']|["']$/g, '');
      const next = realPath(isAbsolute(target) ? target : join(cwd, target));
      if (isInside(ctx.worktree, next)) {
        cwd = next;
        continue;
      }
      return deny(`cd outside the worktree is blocked: ${target}`);
    }
    // Strip a trailing redirect (already checked above) before matching.
    const bare = segment.replace(/\s*\d?>>?\s*\S+/g, '').replace(/\s*2>&1/g, '').trim();
    const flag = unsafeFlag(bare);
    if (flag) return deny(flag);
    const path = shellPathProblem(ctx, bare, cwd);
    if (path?.decision === 'deny') return deny(path.reason);
    if (path?.decision === 'ask') {
      unmatched.push(bare);
      continue;
    }
    if (!matchesAllowlist(bare, ctx.allowlist)) unmatched.push(bare);
  }
  if (unmatched.length) {
    return { decision: 'ask', reason: `not on the allow-list: ${unmatched.join(' ; ')}`, subject: command.trim(), unmatched };
  }
  return allow();
}

// ---------------------------------------------------------------- crucial commands

/** Cloud, hosting and infrastructure CLIs: they act on live systems with my stored logins. */
const CLOUD_CLIS = new Set(['gcloud', 'gsutil', 'bq', 'aws', 'az', 'kubectl', 'terraform', 'pulumi', 'helm', 'firebase', 'vercel', 'netlify', 'fly', 'flyctl', 'heroku', 'wrangler', 'eas', 'fastlane', 'supabase', 'railway', 'doctl']);
/** Tools that reach other machines or send mail. */
const REMOTE = new Set(['ssh', 'scp', 'sftp', 'rsync', 'ftp', 'telnet', 'nc', 'ncat', 'mail', 'sendmail']);
/** Database clients: the connection string can point at production. */
const DB_CLIENTS = new Set(['psql', 'mysql', 'mongo', 'mongosh', 'redis-cli', 'cqlsh']);
/** Tools that change this machine outside the worktree, or stop running programs (the office itself). */
const SYSTEM = new Set(['kill', 'pkill', 'killall', 'shutdown', 'reboot', 'brew', 'defaults', 'systemctl']);
const PACKAGE_MANAGERS = new Set(['npm', 'yarn', 'pnpm', 'bun']);
const RELEASE_WORD = /deploy|publish|release/i;

/**
 * Why a command still needs me even when commands are auto-allowed: it deploys, publishes, touches
 * cloud or remote systems, sends data out, or changes the machine. Null when it is routine work
 * (building, testing, reading, local servers). Checked per simple command; the guard's denies still apply first.
 */
export function crucialCommand(command: string): string | null {
  for (const segment of splitCommand(command)) {
    const tokens = (segment.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []).map((t) => t.replace(/^["']|["']$/g, ''));
    // Skip leading VAR=value assignments and launchers that run the next word as the command.
    while (tokens.length && (/^\w+=/.test(tokens[0]!) || ['npx', 'bunx', 'time', 'nohup'].includes(tokens[0]!))) tokens.shift();
    if (tokens[0] === 'pnpm' && tokens[1] === 'dlx') tokens.splice(0, 2);
    const tool = basename(tokens[0] ?? '');
    const args = tokens.slice(1);
    if (tool === 'firebase' && args[0]?.startsWith('emulators:')) continue;
    if (CLOUD_CLIS.has(tool)) return `${tool} acts on live cloud systems`;
    if (REMOTE.has(tool)) return `${tool} reaches another machine`;
    if (DB_CLIENTS.has(tool)) return `${tool} connects to a database`;
    if (SYSTEM.has(tool)) return `${tool} changes this machine or stops programs`;
    if (tool === 'docker' && ['push', 'login'].includes(args[0] ?? '')) return `docker ${args[0]} talks to a registry`;
    if (PACKAGE_MANAGERS.has(tool)) {
      if (args.some((a) => a === '-g' || a === '--global')) return `${tool} global installs change this machine`;
      const script = args[0] === 'run' ? args[1] : args[0];
      if (args.includes('publish') || (script && RELEASE_WORD.test(script))) return `${tool} ${script ?? 'publish'} deploys or publishes`;
    }
    if (['make', 'just'].includes(tool) && args.some((a) => RELEASE_WORD.test(a))) return `${tool} target deploys or publishes`;
    if (['flutter', 'dart'].includes(tool) && args[0] === 'pub' && args[1] === 'publish') return 'publishes a package';
    if ((tool === 'twine' && args[0] === 'upload') || (tool === 'cargo' && args[0] === 'publish') || (tool === 'gem' && args[0] === 'push') || (tool === 'pod' && args[0] === 'trunk')) return 'publishes a package';
    if (tool === 'curl') {
      const sends = args.some((a) => /^-[a-zA-Z]*[dFT]/.test(a) || /^--(data|form|upload-file|json)/.test(a));
      const method = args.findIndex((a) => a === '-X' || a === '--request' || /^-X\w/.test(a) || a.startsWith('--request='));
      const verb = method === -1 ? 'GET' : (args[method]!.match(/^(?:-X|--request=)(\w+)$/)?.[1] ?? args[method + 1] ?? '').toUpperCase();
      if (sends || !['GET', 'HEAD', 'OPTIONS'].includes(verb)) return 'curl sends data to a server';
    }
    if (tool === 'wget' && args.some((a) => /^--(post-data|post-file|method|body-data|body-file)/.test(a))) return 'wget sends data to a server';
    if (['http', 'https', 'xh'].includes(tool) && args.some((a) => /^(POST|PUT|PATCH|DELETE)$/i.test(a))) return `${tool} sends data to a server`;
  }
  return null;
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
      // The Graphify code graph (local, read-only). Its PR tools call GitHub and are not allowed.
      if (tool.startsWith('mcp__graphify__') && GRAPH_TOOLS.includes(tool.slice('mcp__graphify__'.length))) return allow();
      return deny(`tool ${tool} is not available to office agents`);
  }
}
