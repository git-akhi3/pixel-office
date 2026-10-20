# Pixel Office: design

A personal, local-first dev workspace. I hand a task to a manager agent, a small team of Claude Code agents carries it through plan → code → review → test → draft PR, and I steer from a web board or from Slack. Single user, runs on my Mac, uses my Claude Max 5x subscription.

Status: agreed design, 2026-10-05. Build plan: [phase-1-plan.md](phase-1-plan.md).

## Goals

- Hand off feature work, bug fixes and PR reviews (and sometimes debugging) with little babysitting.
- Agents stay on track: small fresh contexts, written handoffs, hard limits in code.
- Stay within 5x Max usage limits.
- Reachable from anywhere: phone, other laptop.

Not goals: multi-user, teammates using it, non-code work (docs, email) as agent pipelines.

## Engine

- **Runtime:** the Claude Agent SDK (TypeScript) on my Mac, authenticated with my logged-in Claude Code subscription. No API keys. Personal, single-user use only: Anthropic's terms forbid offering claude.ai login in products for others.
- **Orchestration is code, judgment is agents.** A state machine in the office drives each task. Agents are called at defined steps and never start each other. The manager is an agent for judgment calls only: sizing the task, deciding which roles run, status summaries and retrospectives.
- **Coordination is hub and spoke.** Each agent starts a fresh session with only: the task, the documents handed over by earlier steps, the repo knowledge file and the worktree. It ends by writing one handoff document. There is no shared chat history.
- **Handoffs are short and capped.** Markdown files in the task folder, each with a fixed format and length limit (see Phase 1 plan).

### Team

| Agent | Model / effort | Job | Tools |
|---|---|---|---|
| Manager | Sonnet 5.5, low | Intake, sizing, routing, status, retrospective | read-only |
| Architect | Opus 5.5, high | Reads code, writes the plan (with design section when flagged) | read-only |
| Coder | Sonnet 5.5, high | Carries out the plan exactly, writes the PR description | edit + allow-listed shell |
| Reviewer | Opus 5.5, medium | Independent review of the diff against the plan | read-only + allow-listed shell |
| Tester | Sonnet 5.5, medium | Tests for the acceptance criteria, runs the suite | edit test files only + allow-listed shell |
| Debugger (on demand) | Opus 5.5, high | Root cause for unclear bugs, before the architect | read-only + allow-listed shell |
| Researcher (on demand) | Sonnet 5.5 | External docs and API facts | read-only + web |

Model and effort can be changed per agent. PR writing is a skill the coder runs, not its own agent.

### Robustness rules

- The coder never improvises. A plan gap produces `blocked.md` and the task goes back to the architect.
- Review or test failures loop back to the coder at most twice, then the task goes back to the architect to re-plan, then to me.
- "Going sideways" alerts fire when: files outside the plan's scope are touched, the same test fails 3 times, tokens exceed 2× the plan's estimate, or an agent is blocked.

## Gates

- **Plan:** I always approve it. This includes the design section on tasks flagged as UI or architecture work.
- **Push and draft PR:** gated, with one global auto-approve toggle. Even with auto-approve on, these limits are enforced in code:
  - only when reviewer and tester both pass
  - never to `main`, `master` or protected branches; only `office/<task-id>-<slug>` branches
  - PRs open as drafts
  - *Since phase 7 ([phase-7-plan.md](phase-7-plan.md)):* the PR opens by itself once the checks pass, and the gate is on the merge instead. The branch rules above still hold.
- **Posting a PR review:** always manual.
- At any gate: approve, reject with a comment (the agent revises), or take over (open the worktree in my editor).

## Safety

- Edits only inside the task's worktree.
- `git push`, `gh pr *` and posting reviews are blocked for every agent. Only the office does them, after the gate.
- Shell commands come from a per-repo allow-list. Anything else pauses and asks me: allow once, always for this repo, or deny.
- Per-role tool limits as in the team table.
- `.env` files, keys and credential paths are never read or written.

## Concurrency and limits

- Up to 2 tasks run at once (adjustable), each in its own git worktree. Tasks waiting at a gate don't count.
- Near my usage limit the queue pauses. A rate-limited task shows "paused, resumes at HH:MM", not "failed".
- Token use is recorded per agent run and shown per task.

## Context

- **Repo list:** each repo has its path, default branch, build/test/lint commands, `gh` account (multiple orgs and accounts via `gh`; the office stores no tokens) and command allow-list.
- **Knowledge file per repo**, about 2 pages max, stored in the office, not in the repo. The manager proposes edits after each task and I approve them. The repo's own `CLAUDE.md` / `AGENTS.md` is also read.
- **Graphify**, code only (tree-sitter, no tokens to build), run by the office: built when a repo is added, `--update` after each task, no git hooks installed in repos, version pinned. Exposed over MCP to the architect, reviewer and debugger. Can be switched off per repo if token tracking shows no savings.
- **Agents and skills are owned by the office** in three layers: global, per agent, per repo. They're passed to each SDK session at task start. Nothing is written to `~/.claude` or into repos, apart from an optional "also install globally" button for skills.

## Interface

- **Board tab:** columns Queued → Planning → Awaiting you → Building → Review/Test → Done. Task detail shows the plan, handoff documents, diff, test report, token use and the gate bar. Works on a phone screen.
- **Office tab:** the Pixel Agents scene, mostly unchanged. Characters are linked to running tasks, and clicking one opens its task in a panel.
- **Slack:** a bot in a personal Slack workspace, connected over Socket Mode (outbound, no public URL).
  - Talk to Fury, the manager, in plain language (DM it, or the shared office channel): ask for a task, ask how one is going, steer a hero, approve or ask for changes.
  - One thread per task, with a single live status message edited about every 10 seconds (agent, plan step, time, tokens, last action).
  - New messages only for milestones, gates and alerts.
  - Approve, reject or open-in-office buttons at gates.
  - Everything else is said in words in the thread; Fury turns it into the same actions the board has (pause, resume, stop, steer, replan, approve, reject). Heroes post their own handoffs under their own names.
- **Remote access:** Cloudflare Tunnel plus Cloudflare Access (Google login) on a subdomain of my own domain. The Mac must stay awake.

## PR review flow

- Triggered by pasting a PR link (board or Slack) or by auto-pickup: the office checks every few minutes, per `gh` account, for PRs requesting my review. Optional filters such as minimum size or repo.
- The reviewer reads the PR and linked issue, uses Graphify and the knowledge file, and runs tests in a worktree.
- Output is a draft review: summary, blocking issues, suggestions, nits, each tied to file and line. I edit, delete or approve each comment, then post as one GitHub review.
- My own PRs get a "fix it" button that turns blocking issues into a coder task.

## Task lifecycle

- **Done:** the PR is merged (detected via `gh`) or I mark the task done.
- The task folder is kept permanently.
- The worktree is removed 7 days after done, or as soon as the PR is merged. The branch stays on GitHub.
- A stopped task keeps its worktree until I choose Discard or Resume.
- On done, the manager writes a 3-line retrospective with a proposed knowledge-file edit for me to approve.

## Architecture

- **Monorepo** at `pixel-office/`, a private repo on my personal GitHub:
  - `apps/control`: the new app (runner, task store, API, board, Slack bot)
  - `apps/pixel`: the Pixel Agents fork as a git subtree, kept nearly unchanged so upstream pulls stay simple
  - `tools/`: layout and art scripts, layouts, art pack
- **Stack:** Node, Agent SDK for TypeScript, Fastify plus WebSockets, SQLite through Drizzle, React plus Vite, Slack Bolt in Socket Mode. One process, one `start` command.
- **Runtime data** in `~/.office/`: the database, task folders, worktrees, Graphify graphs. Never inside the repo.
- The agent runner doesn't depend on where it runs, so it can later move to a personal cloud server (with `claude setup-token`) or hand tasks to Claude Code cloud sessions (`claude --cloud`) without a rewrite.
- The office tab connects to Pixel Agents through its existing hook events, as the "resident agents" commit does today.

## Mission skills, briefings and attachments

Agreed 2026-10-06 (phase 6). Build plan: [phase-6-plan.md](phase-6-plan.md).

### Skills

- **Three layers.** Role defaults (Team page, always on, kept small), mission skills (per task) and repo skills (per repo, per role). An agent gets the union for its role.
- **Mission skills:** I can lock picks per role in the mission panel. At intake the manager fills the roles I left empty from the catalog (names and one-line descriptions only), with a reason per pick. I can change the coder, reviewer and tester picks at plan approval, and any role that hasn't started on the task page. Agents never load skills themselves: no Skill tool.
- **Catalog:** the office's own skills (`apps/control/skills`, `~/.office/skills`). The Team page imports skills from Claude Code (plugins and `~/.claude/skills`) as snapshots into `~/.office/skills`, recording the source. A changed source shows "update available" with a diff; I decide. Skills that only call other skills (wrappers such as `grill-me`) are flagged, since office agents have no Skill tool.
- Inside the office a skill's "ask the user" means a question round (below), and "dispatch a sub-agent" means look it up yourself with Read, Grep and Glob.

### Briefing: grilling inside the planning step

- **When:** a "Grill me" switch per mission: Auto (default), Always, Never. In Auto the manager turns it on for big tasks (L), design or architecture work, or whenever the request is unclear to it, and records why.
- **Who:** the architect, in its normal planning session, with the `grilling` skill (a setting names the skill; a short built-in fallback applies when it isn't imported). `grill-with-docs` is out for now.
- **How:** the architect ends a turn with a **question round** instead of the plan: every question it can ask without waiting on another answer, each with options and a recommended answer. The office opens a question gate, shows the round, collects the answers and sends them back into the same session. No question limit: it asks until it has clarity, then writes the plan. "Enough, start planning" works at any time; open points become assumptions under Risks.
- **Where I answer:** both the board (task page and the office's Live panel) and the task's Slack thread. Rounds are shown one question at a time with Lock it in (the recommendation), You decide, option buttons, free text, Send what I've answered, and Enough. The first answer wins; the other surface updates ("answered on Slack").
- **Waiting:** the session waits 15 minutes for the round, holding its slot. Then it parks: the task is `awaiting_answer` (Awaiting you), the slot is freed, answers given so far are kept. Answering resumes planning in a fresh session that reads the brief.
- **Record:** the office writes every answered round to `brief.md`. Re-plans read it instead of asking again; the brief shows next to the plan at approval.

### Attachments

- Files (Markdown, text, PDF, images; 10 MB each, 25 MB per mission) and links can be added in the mission panel, or attached to the Slack DM that starts a task (`files:read` scope).
- Stored with the task in `~/.office/tasks/<id>/attachments/` and listed on the task page.
- The manager and architect are told to read them; the coder, reviewer and tester see the list and open files when needed.
- The guard allows read-only access to that task's attachments folder only, through the Read tool. The rest of `~/.office` stays off-limits.

## Phases

1. **Core pipeline:** repo list, runner, worktrees, handoffs, plan and push gates, safety rules, basic board, token tracking.
2. **Remote:** Slack bot, Cloudflare Tunnel plus Access.
3. **Reviews:** PR review flow, auto-pickup, comment editor, "fix it".
4. **Smarts:** knowledge files, Graphify, agent and skill editor in the UI, usage-limit pausing.
5. **Office tab:** Pixel Agents embedded and linked to tasks.
6. **Mission skills and briefings:** skill catalog and import, per-mission skills picked by the manager, grilling in planning with answers on the board and in Slack, attachments.
