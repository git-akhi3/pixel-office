# Status

Updated 2026-10-06. Design: [design.md](design.md). Phase 1 detail: [phase-1-plan.md](phase-1-plan.md).

| Phase | State |
|---|---|
| 1. Core pipeline | Built, reviewed, tried on one real task (add-item UX on zobaze-item-search) |
| 2. Remote (Slack, Cloudflare) | Slack built (`server/src/slack.ts`: DM a task, one thread per task, live status, approve/reject buttons, thread commands). Cloudflare Tunnel + Access still to do |
| 3. PR reviews | Built and reviewed (three review rounds, security hardening) |
| 4. Smarts | Built and reviewed |
| 5. Office tab | Built, reviewed (two rounds), verified live against Pixel Agents |
| 6. Mission skills, briefings, attachments | Built, each step reviewed; checked in a sandbox office (no live agent run yet). Plan: [phase-6-plan.md](phase-6-plan.md) |

## Using it

**Build or fix something.** Assign mission (top right on every page, bottom right in the office) → pick the repo and describe it in the side panel. The manager sizes it, the architect writes a plan, and you approve the plan (or send it back with a comment) before any code is written. The coder, reviewer and tester then run in their own git worktree. You approve the push, which opens a draft PR. Mark it done (or merge it) and the manager writes a short retrospective.

**Routes (lanes).** The manager picks how much of the team a task gets. *Trivial* (docs, comments, wording): the coder, then your push approval; no plan, review, tests or retrospective. *Small* (a small, clear code change): no architect or plan approval; review and tests still run. *Standard*: everything above. Anything bigger than S, or needing the debugger, research, a design review or a briefing, is standard whatever the manager says. After the coder, the office measures the diff (`lanes.ts`): code files move a trivial task to small; over 200 lines or 8 files moves it to standard (review and tests). A replan always makes it standard. Trivial pushes always wait for you, even with auto-approve on. The lane shows on the card, the task page and in the Slack thread. The tester writes tests only for behaviour changes. On size S tasks the architect and reviewer run on Sonnet at medium effort instead of Opus (Settings → Sonnet for small tasks, on by default; applied over your Team-page agent edits).

**Grill me first.** In the mission panel: Auto (the manager decides: big, design-heavy or unclear tasks), Always or Never. When it's on, the architect asks its questions in rounds before planning. Answer on the task page (one question at a time: Lock it in, an option, You decide, or your own words) or in the task's Slack thread (buttons, or reply). "Send what I've answered" and "Enough, start planning" work at any time. If nobody answers for 15 minutes the task waits in Awaiting you and frees its slot; answering picks it up again. Answers are kept in brief.md, which re-plans read. Import "grilling" on the Team page for the full interview method (Settings → Briefing picks the skill).

**Crew skills.** In the mission panel, lock skills per role; the manager picks for the roles you leave empty (with a reason, shown on the task page). Change a role's skills on the task page any time it isn't working; at plan approval the panel opens for the coder, reviewer and tester.

**Attachments.** Drop specs, screenshots or PDFs (and links) in the mission panel, or attach files to the Slack message that starts a task. The manager and architect read them; the others open them when needed.

**While it runs.** "Message the agent" sends a note to the agent that's working (or the next step). "New plan" stops and sends it back to the architect. Commands outside the repo's allow-list stop and ask you (allow once / always for this repo / deny).

**Review a PR.** New task → Review a PR → paste the link (the repo must be registered). The reviewer reads the PR in a checkout of its head with read-only tools only (a PR's code never runs here). Edit or delete each comment and the summary, then post one comment review. On your own PRs, "Fix it" hands the blocking findings to the coder as a draft PR into your PR's branch. Optional: Settings → pick up review requests automatically.

**Team.** Edit any agent (model, effort, tools, prompt) or skill; reset to the built-in version anytime. "Import from Claude Code" copies skills from your Claude Code plugins and ~/.claude/skills into the office (a snapshot: a changed original shows "update available" with a diff). Attach skills to one repo's agents under Repos → Edit.

**Knowledge.** Each repo has short notes every agent reads. Retrospectives suggest notes; you add, edit or dismiss them.

**Code graph.** Repos → Edit → Code graph (Graphify). Needs `uv tool install "graphifyy[mcp]==0.9.76"`. The repo list shows tokens per architect/reviewer/debugger run with and without it, so you can tell whether it pays off.

**Usage.** No new steps start above 90% (adjustable) of the 5-hour or 7-day limit; they resume after the reset.

**Office.** The Office tab is the pixel office, filling the page (the corner button makes it full screen). Each working character carries a small name tag; the Live panel on the left lists the missions in flight and who is on duty with what they are doing right now. Hover a row to point out the character, or hover a character for its full label. A waiting bubble means a gate needs you.

## Safety model, in one paragraph

Agents run with your Claude subscription through the Agent SDK, isolated from your own Claude settings. A guard checks every tool call: writes only inside the task's worktree, no secrets (`.env`, keys, `~/.office`), no git history or GitHub commands (only the office pushes, after your approval, and only `office/*` branches as draft PRs), and shell commands from a per-repo allow-list with dangerous flags blocked (bundled, abbreviated or quoted). PR reviews get no shell at all. A mission's attachments folder is readable (never writable) by that task's agents only, through the Read tool. The board binds to 127.0.0.1 and rejects other sites and host names (remote access waits for phase 2's Cloudflare Access check).

## Next

- **Phase 2 remainder:** Cloudflare Tunnel + Access on your domain. Slack setup: manifest in `tools/slack-app-manifest.yml`, tokens `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_OWNER_ID` in `~/.office/env`. Until phase 2 adds Cloudflare Access verification, the board accepts only 127.0.0.1/localhost: don't point a tunnel at it before then.
- **Slack app:** reinstall it from `tools/slack-app-manifest.yml` to pick up the new `files:read` scope (attachments on Slack task messages).
- **Try phase 6 on a real task:** import "grilling", assign a mission with Grill me on Always, and answer a round on the board and one in Slack.
- Watch the knowledge files and token stats after a week of real tasks; tune agent prompts on the Team page.
