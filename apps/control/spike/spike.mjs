// Step 0 SDK spike. Throwaway: proves the assumptions in docs/phase-1-plan.md.
// Run: node spike.mjs [check...]   (checks: auth models isolation guard interrupt; default all)
import { query } from '@anthropic-ai/claude-agent-sdk';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const HAIKU = 'claude-haiku-4-5-20251001';
const SONNET = 'claude-sonnet-5-5';
const OPUS = 'claude-opus-5-5';

// Run as a standalone process would: drop everything the desktop app injects.
const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([k]) => !/^(CLAUDE|ANTHROPIC|MCP_)/.test(k) && k !== 'CLAUDECODE',
  ),
);

// Subscription token from `claude setup-token`, kept in ~/.office/env (KEY=value lines, chmod 600).
// Never logged.
const envFile = join(homedir(), '.office', 'env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*CLAUDE_CODE_OAUTH_TOKEN\s*=\s*"?([^"\s]+)"?\s*$/);
    if (m) cleanEnv.CLAUDE_CODE_OAUTH_TOKEN = m[1];
  }
}
console.log(`auth: ${cleanEnv.CLAUDE_CODE_OAUTH_TOKEN ? 'token from ~/.office/env' : 'keychain login (no token file)'}`);

const base = { env: cleanEnv, settingSources: [], persistSession: false };
const results = {};

async function run(prompt, options) {
  const q = query({ prompt, options: { ...base, ...options } });
  const msgs = [];
  for await (const m of q) msgs.push(m);
  return { q, msgs, init: msgs.find((m) => m.type === 'system' && m.subtype === 'init'), result: msgs.find((m) => m.type === 'result') };
}

function summarizeResult(r) {
  if (!r) return null;
  return {
    subtype: r.subtype,
    is_error: r.is_error,
    text: typeof r.result === 'string' ? r.result.slice(0, 200) : undefined,
    usage: r.usage,
    modelUsage: r.modelUsage,
    duration_ms: r.duration_ms,
  };
}

const checks = {
  // 1. Subscription auth, no API key. 5. Usage reporting. 7. Rate-limit info.
  async auth() {
    const { q, msgs, init, result } = await run('Reply with exactly: OK', { model: HAIKU, tools: [], maxTurns: 1 });
    return {
      apiKeySource: init?.apiKeySource,
      model: init?.model,
      result: summarizeResult(result),
      rateLimitEvents: msgs.filter((m) => m.type === 'rate_limit_event').map((m) => m.rate_limit_info),
      accountInfo: await q.accountInfo?.().catch((e) => `error: ${e.message}`),
    };
  },

  // 2. Opus/Sonnet per session, effort option accepted.
  async models() {
    const out = {};
    for (const [model, effort] of [[SONNET, 'high'], [OPUS, 'high'], [SONNET, 'low']]) {
      try {
        const { init, result } = await run('Reply with exactly: OK', { model, effort, tools: [], maxTurns: 1 });
        out[`${model}/${effort}`] = { initModel: init?.model, result: summarizeResult(result) };
      } catch (e) {
        out[`${model}/${effort}`] = { error: e.message };
      }
    }
    return out;
  },

  // 3. Isolation from ~/.claude: compare what loads with and without user settings.
  async isolation() {
    const pick = (init) => ({
      agents: init?.agents,
      skills: init?.skills,
      slash_commands: init?.slash_commands?.length,
      mcp_servers: init?.mcp_servers,
      plugins: init?.plugins,
    });
    const isolated = await run('Reply with exactly: OK', { model: HAIKU, tools: [], maxTurns: 1, settingSources: [] });
    const withUser = await run('Reply with exactly: OK', { model: HAIKU, tools: [], maxTurns: 1, settingSources: ['user'] });
    return { isolated: pick(isolated.init), withUserSettings: pick(withUser.init) };
  },

  // 4. cwd confinement + guard via canUseTool and a PreToolUse hook.
  async guard() {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'office-spike-repo-')));
    execSync('git init -q && echo "SECRET=do-not-read" > .env && echo hello > README.md && git add README.md && git -c user.email=s@s -c user.name=s commit -qm init', { cwd: repo });
    const outside = join(tmpdir(), `office-spike-outside-${Date.now()}.txt`);
    const allow = [/^git (status|diff|log)\b/, /^ls\b/, /^cat README\.md$/];
    const log = [];

    const inRepo = (p) => typeof p === 'string' && resolve(repo, p).startsWith(repo + '/');
    const preToolUse = async (input) => {
      const ti = input.tool_input ?? {};
      const path = ti.file_path ?? ti.path ?? ti.notebook_path;
      if (path && /(^|\/)\.env(\.|$)/.test(path)) {
        log.push({ via: 'hook', tool: input.tool_name, path, decision: 'deny-secret' });
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'secrets are off-limits' } };
      }
      if (input.tool_name === 'Bash' && /\.env\b/.test(ti.command ?? '')) {
        log.push({ via: 'hook', tool: 'Bash', command: ti.command, decision: 'deny-secret' });
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'secrets are off-limits' } };
      }
      log.push({ via: 'hook', tool: input.tool_name, decision: 'pass' });
      return {};
    };
    const canUseTool = async (tool, input) => {
      if (['Write', 'Edit', 'NotebookEdit'].includes(tool)) {
        const ok = inRepo(input.file_path ?? input.notebook_path);
        log.push({ via: 'canUseTool', tool, path: input.file_path, decision: ok ? 'allow' : 'deny-outside' });
        return ok ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'writes outside the worktree are blocked' };
      }
      if (tool === 'Bash') {
        const ok = allow.some((re) => re.test(input.command.trim()));
        log.push({ via: 'canUseTool', tool, command: input.command, decision: ok ? 'allow' : 'deny-not-allowlisted (would pause for approval)' });
        return ok ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'command not on allow-list' };
      }
      log.push({ via: 'canUseTool', tool, decision: 'allow' });
      return { behavior: 'allow', updatedInput: input };
    };

    const prompt = [
      'Do these steps in order, one tool call each, and continue even if one is denied:',
      '1. Create the file notes.txt in the current directory containing "inside".',
      `2. Create the file ${outside} containing "outside".`,
      '3. Read the file .env in the current directory.',
      '4. Run the shell command: git status --short',
      '5. Run the shell command: curl --version',
      'Then reply with one line per step saying whether it worked.',
    ].join('\n');

    const { result } = await run(prompt, {
      model: HAIKU,
      cwd: repo,
      tools: ['Read', 'Write', 'Edit', 'Bash'],
      permissionMode: 'default',
      canUseTool,
      hooks: { PreToolUse: [{ hooks: [preToolUse] }] },
      maxTurns: 12,
    });
    return {
      repo,
      insideFileWritten: existsSync(join(repo, 'notes.txt')),
      outsideFileWritten: existsSync(outside),
      log,
      result: summarizeResult(result),
    };
  },

  // 6. Interrupt a running session, then steer it with a new message.
  async interrupt() {
    let push;
    const queue = [];
    let wake;
    async function* input() {
      yield { type: 'user', message: { role: 'user', content: 'Run the shell command `sleep 30 && echo finished` and tell me the output.' }, parent_tool_use_id: null };
      while (true) {
        if (!queue.length) await new Promise((r) => (wake = r));
        const next = queue.shift();
        if (next === null) return;
        yield next;
      }
    }
    push = (m) => { queue.push(m); wake?.(); };

    const q = query({
      prompt: input(),
      options: { ...base, model: HAIKU, tools: ['Bash'], permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true, maxTurns: 6 },
    });
    const events = [];
    const t0 = Date.now();
    let interrupted = false;
    let steered = false;
    for await (const m of q) {
      events.push({ t: Date.now() - t0, type: m.type, subtype: m.subtype });
      if (!interrupted && m.type === 'assistant' && m.message?.content?.some((c) => c.type === 'tool_use')) {
        interrupted = true;
        setTimeout(async () => {
          events.push({ t: Date.now() - t0, note: 'calling interrupt()' });
          await q.interrupt();
        }, 3000);
      }
      if (m.type === 'result' && !steered) {
        steered = true;
        events.push({ t: Date.now() - t0, note: 'sending steer message' });
        push({ type: 'user', message: { role: 'user', content: 'Change of plan: do not run anything. Reply with exactly: STEERED' }, parent_tool_use_id: null });
        continue;
      }
      if (m.type === 'result' && steered) {
        events.push({ t: Date.now() - t0, final: typeof m.result === 'string' ? m.result.slice(0, 100) : m.subtype });
        push(null);
        break;
      }
    }
    return { totalMs: Date.now() - t0, events: events.filter((e) => e.note || e.final || e.type === 'result' || e.subtype === 'tool_use') .concat(events.filter((e) => e.type === 'result')) };
  },
};

const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(checks);
for (const name of wanted) {
  process.stdout.write(`\n=== ${name} ===\n`);
  try {
    results[name] = await checks[name]();
  } catch (e) {
    results[name] = { error: e.message, stack: e.stack?.split('\n').slice(0, 4).join('\n') };
  }
  console.log(JSON.stringify(results[name], null, 2));
}
writeFileSync(`results-${wanted.join('-')}.json`, JSON.stringify(results, null, 2));
