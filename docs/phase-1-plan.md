# Phase 1 plan: core pipeline

Goal: from the browser on my Mac, I can create a task for a registered repo, approve the architect's plan, watch the coder, reviewer and tester run in an isolated worktree, and approve a push that opens a draft PR. Every step is visible on the board with its handoff document and token use.

## Status (2026-10-05)

Steps 0–7 are built and tested: 83 tests, plus one real end-to-end run on a scratch repo, from intake to the push gate and through the retrospective. Step 8, the trial on real repos, is next and needs the owner.

Changes from the plan, found while building:
- **Repo setup command.** Worktrees don't contain untracked environments (venvs, `node_modules`), so each repo has a setup command the office runs in every new worktree, with `$REPO_PATH` pointing to the main checkout.
- **Handoffs are the agent's final message.** The office saves the document, so read-only agents never need write access outside their worktree. Output that breaks its format is sent back once for a fix in the same session.
- **Orchestration is code.** The state machine drives every transition. The manager only does intake sizing and the retrospective.
- **Re-plan limit.** A task is re-planned at most twice, whether for a coder blocker or for repeated review/test failures. After that it's blocked for the owner.
- **Bug found by the smoke run.** The guard treated every worktree file as a secret, because worktrees live under `~/.office`. Fixed, with tests that use the real layout.

Run it: `npm run office` from the repo root → http://127.0.0.1:4100

Design: [design.md](design.md). Not in this phase: Slack, Cloudflare, PR review flow, knowledge files, Graphify, the agent editor UI, usage-limit pausing, the office tab.

## Step 0: SDK spike (done 2026-10-05)

Result: all assumptions hold. See [research/agent-sdk-spike.md](research/agent-sdk-spike.md). Changes folded into steps 2 and 5: auth via a `setup-token` token in `~/.office/env`; explicit `tools` lists to keep built-in agents and skills out; the guard lives in the `PreToolUse` hook.

Original checklist:

Prove the assumptions the rest of the plan depends on, in a throwaway script under `apps/control/spike/`. Record results in `docs/research/agent-sdk-spike.md`.

1. `query()` from `@anthropic-ai/claude-agent-sdk` runs using my logged-in subscription with no `ANTHROPIC_API_KEY` set.
2. Per-session `model` works for Opus 5.5 and Sonnet 5.5. Find how effort is set (option, setting or env var), or note that it isn't supported.
3. Sessions can be isolated from `~/.claude`: no user settings, agents or hooks loaded (`settingSources`), with our own system prompt, tools and MCP servers passed in.
4. `cwd` set to a worktree confines file tools, and a `PreToolUse` hook or `canUseTool` callback can block or pause a tool call (needed for the guard and allow-list).
5. Result messages report token usage, including cache reads and writes.
6. A running session can be interrupted, and a message can be sent to it mid-run (needed later for `steer:`).
7. What a rate-limit error looks like, so a task can be marked paused rather than failed.

Anything that fails changes the plan before more code is written.

## Step 1: monorepo restructure

1. Back up `pixel-office/` first.
2. `git init` at `pixel-office/`.
3. Add the fork with its history as a subtree: `git subtree add --prefix apps/pixel ./src <branch>`. This keeps the local "resident agents" commit (`58f4bd5`). Add the upstream remote for future `git subtree pull`.
4. Move `build_layouts.py`, `build_art.py`, `apply.sh`, `layouts/`, `art-pack/` into `tools/`, and fix their paths.
5. Root `package.json` with npm workspaces. Update `start.sh` to start `apps/pixel` from its new path (it currently `cd`s into zobaze-item-search; check why first).
6. Create a private GitHub repo on my personal account and push.

Done when: the pixel office starts from the new layout exactly as before, and `npm test` passes in `apps/pixel`.

## Step 2: control app skeleton

- `apps/control`: `server/` (Fastify, WebSockets, Drizzle + better-sqlite3) and `web/` (React + Vite). The production build serves `web/` from Fastify.
- Runtime data dir `~/.office/` (override with `OFFICE_HOME`): `office.db`, `tasks/<task-id>/`, `worktrees/<task-id>/`.
- Lint, typecheck and Vitest set up as in `apps/pixel`.
- Binds to `127.0.0.1` only.
- Auth: reads `CLAUDE_CODE_OAUTH_TOKEN` from `~/.office/env` (created with `claude setup-token`) and passes it only to SDK sessions. It refuses to start, with a clear message, if the file is missing or not mode 600. Never logs it.

### Data model

| Table | Key fields |
|---|---|
| `repos` | id, name, path, default_branch, protected_branches, build_cmd, test_cmd, lint_cmd, gh_account, allowlist (json) |
| `tasks` | id, repo_id, title, input, kind (feature/bug), size (S/M/L), roles (json), status, loop_count, replan_count, branch, pr_url, created/updated |
| `runs` | id, task_id, role, model, effort, session_id, status, input/output/cache tokens, duration, started/ended |
| `gates` | id, task_id, kind (plan/push/command), status, comment, decided_at |
| `events` | id, task_id, run_id, type, payload (json), at: the live feed for the board and, in phase 2, Slack |
| `settings` | key, value: auto-approve toggle, concurrency cap |

Done when: the server starts, migrations run, and an empty board loads.

## Step 3: repo list

- API and board page to add, edit and remove a repo: a local path (must be a git repo) with default branch, commands, `gh` account (chosen from `gh auth status`) and allow-list.
- Default allow-list: the repo's build/test/lint commands, read-only `git` (`status`, `diff`, `log`, `show`, `branch`), `ls`, `cat`, `grep`, `rg`, `node`, `npm test`/`npm run <script>`.
- Cloning by GitHub URL can wait for a later phase.

Done when: I can register `zobaze-item-search` and `galaxy`, and edits persist.

## Step 4: agent definitions

- Agents are config files in `apps/control/agents/*.md` (frontmatter: model, effort, tools, skills; body: system prompt) until the phase 4 editor.
- Port the existing definitions from `zobaze-item-search/.claude/agents/`, then adapt them:
  - `manager`: Sonnet, low. Intake and retrospective only; it no longer delegates (the state machine does).
  - `architect`: new, Opus, high. Merges the old manager's planning duty and the designer's design note.
  - `coder`: Sonnet, high. Plus the `write-pr` skill (from the old pr-writer). Must raise `blocked.md` instead of improvising.
  - `reviewer`: Opus, medium. `tester`: Sonnet, medium. `debugger`: Opus, high. `researcher`: Sonnet.
  - Remove repo-specific lines (deepinfra, turbopuffer) from global prompts; they belong in that repo's knowledge file later.
- Skills live in `apps/control/skills/<name>/SKILL.md` and are attached per agent in frontmatter.

Done when: a loader validates every agent file, and a unit test fails on a missing model or unknown tool.

## Step 5: agent runner and safety guard

`runAgent(role, task, inputs)`:

1. Builds the prompt: the agent's system prompt, the task, the handoff documents this role needs, the repo's `CLAUDE.md` if present, and the output format for its handoff file.
2. Calls the SDK with `cwd` = the task's worktree, the role's model and effort, `settingSources: []`, and an explicit `tools` list without `Agent`/`Task`/`Skill`, so built-in subagents and skills can't run. Prompts go through streaming input mode, so `interrupt()` and steer messages work.
3. Streams every message into `events` (tool calls, text, errors) for the live board.
4. Records tokens (from `modelUsage`, including cache and thinking tokens; ignore `costUSD`) and duration in `runs`, and stores the latest `rate_limit_event` utilization for auto-pause later.
5. Checks the expected handoff file exists and is within its size cap; if not, retries once with a correction, then fails the step.

The guard runs in the `PreToolUse` hook, which sees every tool call. `canUseTool` misses commands Claude Code auto-approves as read-only (seen in the spike), so it is used only to pause and ask about off-list commands. Paths are compared after `realpath`:

- File writes outside the worktree: deny.
- `.env*`, `*.pem`, `id_rsa*` and credential paths: deny reads and writes.
- `git push`, `gh pr`, `gh api` that writes, `git remote`, force operations: deny for all roles.
- Role limits: reviewer, architect, manager and debugger have no write tools; the tester may only write files matching the repo's test globs.
- Shell commands not on the allow-list: pause the run and create a `command` gate (allow once / always for this repo / deny).
- Port the regex rules from `zobaze-item-search/.claude/hooks/guard.sh` as test cases.

Done when: unit tests cover each guard rule, and a spike run on a scratch repo shows an off-list command pausing for approval.

## Step 6: task pipeline (state machine)

```
queued → intake (manager) → [debugging (debugger)] → planning (architect)
  → awaiting_plan_approval → coding (coder) → reviewing (reviewer) → testing (tester)
  → awaiting_push_approval → pushing → pr_open → done
```

Side states: `blocked`, `paused_permission`, `stopped`, `failed`.

- **Worktree:** created at `planning` from the latest default branch, on `office/<task-id>-<slug>`.
- **Plan rejected:** back to the architect with my comment.
- **Coder blocked:** back to the architect with `blocked.md`.
- **Review has blocking findings or tests fail:** back to the coder with `review.md` / `test-report.md`. After 2 failed loops, back to the architect to re-plan. After 1 re-plan that fails twice again, `blocked` for me.
- **Push gate:** auto-approved only if the toggle is on, review has no blocking findings and tests pass. The office (not an agent) then runs `git push` as the repo's `gh` account and `gh pr create --draft` with `pr.md`.
- **Alerts** (shown on the board, sent to Slack in phase 2): coder touched files not listed in the plan, the same test failed 3 times, tokens above 2× the plan's estimate.
- **Concurrency:** a scheduler runs at most N tasks (default 2) in active states; gates don't hold a slot.
- **Stop / resume:** stop aborts the running session and keeps the worktree; resume restarts the current step.
- **Restart safety:** on server start, any task left in an active state is marked `paused` rather than silently re-run.

### Handoff documents (`~/.office/tasks/<task-id>/`)

| File | Written by | Format and cap |
|---|---|---|
| `task.md` | office + manager | My input; repo; kind; size S/M/L; roles to run; draft acceptance criteria. ≤ 40 lines |
| `diagnosis.md` | debugger | Reproduction, root cause, evidence. ≤ 60 lines |
| `plan.md` | architect | Goal; acceptance criteria; files in scope; numbered steps; out of scope; risks; token estimate; design section if flagged. ≤ ~1 page (80 lines) |
| `blocked.md` | any | The question, what was tried, options. ≤ 20 lines |
| `changes.md` | coder | What changed per plan step, deviations, commands run. ≤ 40 lines |
| `pr.md` | coder (`write-pr` skill) | Title ≤ 70 chars, 3-bullet summary, how it was tested |
| `review.md` | reviewer | Findings list: `blocking` / `suggestion` / `nit`, each with file:line and one line of reasoning. No prose essay |
| `test-report.md` | tester | Tests added, suite result, failing output verbatim (trimmed) |
| `retro.md` | manager | 3 lines: went well, went wrong, proposed knowledge-file edit |

Each loop writes a new numbered version (`review.2.md`) so history is kept.

Done when: an integration test runs the whole state machine against a fake runner (no real SDK calls), covering the happy path, plan rejection, blocked coder, the 2-loop re-plan rule, stop/resume and restart safety.

## Step 7: board

- **Board view:** columns Queued → Planning → Awaiting you → Building → Review/Test → Done, with live updates over WebSocket.
- **New task form:** repo, description, kind.
- **Task detail:**
  - status, current agent, elapsed time
  - handoff documents rendered as markdown, with history
  - diff of the worktree against the default branch
  - live event feed (tool calls, collapsed by default)
  - token use per run and total
  - alerts
- **Gate bar:** approve; reject with comment; take over (opens the worktree with `code <path>`); stop; resume; discard.
- **Command gates:** show the command, with allow once / always for this repo / deny.
- **Settings:** auto-approve toggle, concurrency cap.
- Mobile-friendly layout now, because phase 2 puts it on my phone.

Done when: I can do a full task from the browser without touching the terminal.

## Step 8: real-world trial

1. Run 3 small real tasks (one bug fix, one small feature, one refactor) on `zobaze-item-search`.
2. For each: did the plan match what I wanted, did the coder stay in scope, how many loops, tokens per role.
3. Write the findings into `docs/research/phase-1-trial.md` and adjust prompts, caps and the allow-list before phase 2.

## Acceptance criteria for phase 1

- A task goes from creation to an open draft PR on a feature branch with only my two approvals.
- No agent can push, open a PR, write outside its worktree or read `.env`; each rule is covered by a test.
- An off-list shell command pauses the task until I decide.
- A rejected plan, a blocked coder and repeated review failures each route as designed.
- Two tasks run in parallel in separate worktrees without interfering; a third waits in the queue.
- Token use is shown per run and per task.
- Restarting the server never re-runs a step silently or loses a task.

## Risks

- **SDK assumptions** (subscription auth, effort, isolation, interrupt): covered by step 0.
- **Prompt quality** decides whether the coder stays in scope: step 8 exists to tune it.
- **Allow-list friction** in the first days: expected; "always for this repo" makes it shrink quickly.
- **Restructure** could break the pixel office start-up: back up first, and step 1 has its own done check.
