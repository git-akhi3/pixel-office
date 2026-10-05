# Agent SDK spike (phase 1, step 0)

Date: 2026-10-05. SDK `@anthropic-ai/claude-agent-sdk` 0.3.289 (bundled Claude Code 2.1.289), Node 24, macOS arm64.
Script: `apps/control/spike/spike.mjs`. Raw output: `apps/control/spike/results-*.json`.

**Verdict: every assumption in the plan holds.** Three findings change the plan (marked ⚠️).

| # | Assumption | Result |
|---|---|---|
| 1 | Runs on the Max subscription, no API key | ✅ with a `setup-token` token. ⚠️ Keychain login did not work (see below) |
| 2 | Per-session model and effort | ✅ Opus 5.5 and Sonnet 5.5 both run; `effort` is a documented option and is accepted |
| 3 | Isolation from `~/.claude` | ✅ for user agents and skills. ⚠️ Built-in agents, skills and plugins still load |
| 4 | Worktree confinement and guard | ✅ inside writes allowed, outside writes denied, `.env` read denied, off-list command denied. ⚠️ Not every Bash call reaches `canUseTool` |
| 5 | Token usage reported | ✅ per model, including cache read/write and thinking tokens |
| 6 | Interrupt and steer | ✅ `interrupt()` stops the turn in ~12 ms; a new message in the same session is answered ~1 s later |
| 7 | Rate-limit visibility | ✅ `rate_limit_event` gives 5-hour and 7-day utilization and reset times |

## Details

### 1. Auth

- `claude auth login --claudeai` succeeded, and `auth status` showed logged in, but every SDK or `claude -p` call started from the Claude desktop app (its tool shell and its `!` prompt) said "Not logged in". The keychain login was not usable from processes started there. Not investigated further.
- A token from `claude setup-token` (1-year, subscription-scoped) works everywhere. It's stored in `~/.office/env` as `CLAUDE_CODE_OAUTH_TOKEN=…`, mode 600, folder mode 700. The init message reports `apiKeySource: none` and `tokenSource: CLAUDE_CODE_OAUTH_TOKEN`.
- **Decision:** the office reads `CLAUDE_CODE_OAUTH_TOKEN` from `~/.office/env` and passes it only to SDK sessions. It also means the office can move to a cloud server unchanged. Renew the token yearly (next: 2027-10).
- When copying the token, it prints wrapped over 3 lines. Save it with `pbpaste | tr -d '[:space:]'`, not an interactive `read`, which stops at the first line break.

### 2. Models and effort

- `claude-opus-5-5` and `claude-sonnet-5-5` with `effort: 'high' | 'low'` all succeeded.
- The trivial prompt used 0 thinking tokens, so the *effect* of effort isn't visible yet. Check on real tasks in step 8.
- Every session also makes a small Haiku call (~900 input tokens), presumably Claude Code's own housekeeping. Count it in token tracking; it's negligible.

### 3. Isolation

`settingSources: []` drops user-level agents (`coder`, `manager`, …) and user skills (`galaxy-onboarding`, `zobaze-workspace`). Still loaded: built-in agents (`Explore`, `general-purpose`, `Plan`, …), built-in skills (`code-review`, `simplify`, …) and 3 built-in plugins.

**Plan change:** each office session passes an explicit `tools` list, which leaves out the `Agent`/`Task` and `Skill` tools unless the role needs them, so agents can't start built-in subagents or skills. Office skills are injected by the office. Re-check the init message in step 5 tests.

### 4. Guard

The test asked an agent to write inside and outside the repo, read `.env`, run `git status` and run `curl --version`:

- `notes.txt` in the repo: allowed and written.
- File outside the repo: denied by `canUseTool`, not written.
- `.env` read: denied by the `PreToolUse` hook (reads never reach `canUseTool`).
- `curl --version`: denied by `canUseTool` (not on the allow-list).
- `git status`: passed the hook and ran **without** a `canUseTool` call. Claude Code auto-approves commands it considers read-only.

**Plan change:** enforce the whole guard (path scope, secrets, push/PR block, allow-list) in the `PreToolUse` hook, which sees every call. Use `canUseTool` only to *pause and ask me* for off-list commands. Compare paths after `realpath`, because macOS temp paths appear as both `/var/…` and `/private/var/…`.

### 5. Usage

The result message has `usage` (input, output, cache creation with 1-hour TTL, cache read, thinking tokens) and `modelUsage` per model. `costUSD` is list price, so it's meaningless on a subscription; show tokens, not dollars.

### 6. Interrupt and steer

Using streaming input mode (prompt as an async iterable): `interrupt()` during a `sleep 30` tool call ended the turn with `error_during_execution` after ~12 ms. A new user message pushed into the same stream got the reply `STEERED` about 1 s later. The session survives an interrupt, which is exactly what `steer:` needs.

### 7. Rate limits

`rate_limit_event` arrives at session start with `status`, `rateLimitType`, and `unifiedWindows.five_hour` / `seven_day` utilization (0.23 and 0.05 at test time) plus reset timestamps. That is enough for auto-pause near the limit and "resumes at HH:MM". An actual limit being hit (`SDKAssistantMessageError: 'rate_limit'`) wasn't triggered; it's covered by a fake-runner test.

## Cost of the spike

About 45k tokens in total, mostly cached input on Haiku; 5-hour utilization was 23% at the time, largely from this session.
