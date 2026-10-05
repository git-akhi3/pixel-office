# Status

Updated 2026-10-05. Design: [design.md](design.md). Phase 1 detail: [phase-1-plan.md](phase-1-plan.md).

| Phase | State |
|---|---|
| 1. Core pipeline | Built, reviewed, tried on one real task (add-item UX on zobaze-item-search) |
| 2. Remote (Slack, Cloudflare) | Deferred by the owner. Groundwork only: settings in `~/.office/env`, Slack app manifest in `tools/`, steer/replan available on the board |
| 3. PR reviews | Built and reviewed (three review rounds, security hardening) |
| 4. Smarts | Built and reviewed |
| 5. Office tab | Built, reviewed (two rounds), verified live against Pixel Agents |

## Using it

**Build or fix something.** Board → New task → pick the repo and describe it. The manager sizes it, the architect writes a plan, and you approve the plan (or send it back with a comment) before any code is written. The coder, reviewer and tester then run in their own git worktree. You approve the push, which opens a draft PR. Mark it done (or merge it) and the manager writes a short retrospective.

**While it runs.** "Message the agent" sends a note to the agent that's working (or the next step). "New plan" stops and sends it back to the architect. Commands outside the repo's allow-list stop and ask you (allow once / always for this repo / deny).

**Review a PR.** New task → Review a PR → paste the link (the repo must be registered). The reviewer reads the PR in a checkout of its head with read-only tools only (a PR's code never runs here). Edit or delete each comment and the summary, then post one comment review. On your own PRs, "Fix it" hands the blocking findings to the coder as a draft PR into your PR's branch. Optional: Settings → pick up review requests automatically.

**Team.** Edit any agent (model, effort, tools, prompt) or skill; reset to the built-in version anytime. Attach skills to one repo's agents under Repos → Edit.

**Knowledge.** Each repo has short notes every agent reads. Retrospectives suggest notes; you add, edit or dismiss them.

**Code graph.** Repos → Edit → Code graph (Graphify). Needs `uv tool install "graphifyy[mcp]==0.9.76"`. The repo list shows tokens per architect/reviewer/debugger run with and without it, so you can tell whether it pays off.

**Usage.** No new steps start above 90% (adjustable) of the 5-hour or 7-day limit; they resume after the reset.

**Office.** The Office tab shows the pixel office: residents work at their desks with the task they're on; a waiting bubble means a gate needs you.

## Safety model, in one paragraph

Agents run with your Claude subscription through the Agent SDK, isolated from your own Claude settings. A guard checks every tool call: writes only inside the task's worktree, no secrets (`.env`, keys, `~/.office`), no git history or GitHub commands (only the office pushes, after your approval, and only `office/*` branches as draft PRs), and shell commands from a per-repo allow-list with dangerous flags blocked (bundled, abbreviated or quoted). PR reviews get no shell at all. The board binds to 127.0.0.1 and rejects other sites and host names (remote access waits for phase 2's Cloudflare Access check).

## Next

- **Phase 2 when you're ready:** Slack app (manifest in `tools/slack-app-manifest.yml`, tokens into `~/.office/env`), then Cloudflare Tunnel + Access on your domain. Until phase 2 adds Cloudflare Access verification, the board accepts only 127.0.0.1/localhost: don't point a tunnel at it before then.
- Watch the knowledge files and token stats after a week of real tasks; tune agent prompts on the Team page.
