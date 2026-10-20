# Phase 7 plan: a fast lane, shipping, and Fury in Slack

Status 2026-10-20: planned with the owner. Step 1 built and tried end to end in a sandbox office: a real solo task went intake (10 s) → the all-rounder (18 s) → PR → "Changes needed" back into the same session (19 s) → merge → retro. Step 2 built. Step 4 built 2026-10-20 (see below). Steps 3 and 5 to do. Each step is reviewed on its own and tried on a real task before the next one starts.

## Why

A change that one Claude Code session makes in about 5 minutes took about 40 in the office. The office's own data (`~/.office/office.db`, tasks 7–15) shows where the time went:

| Task | Lane | Created → ready to push | Agents working | Where the rest went |
|---|---|---|---|---|
| #15 health version | small | 2.4 min | 2.3 min | (nothing) |
| #7 app foundation | standard | 13 min | 6.9 min | waiting for plan approval |
| #14 embedded auth | standard | 28 min | 25 min | architect 13.7 min (Opus, planned twice), 13 min of command prompts |
| #8 auth milestone | standard | 64 min | 22.7 min | 28 min of plan approval, 14 min of command prompts, 13 min waiting for the previous milestone |

The bottlenecks, worst first:

1. **Almost everything ran the standard lane.** `laneAtIntake` forces every task that isn't size S into the standard lane. 1 task of 10 went small, and it finished in 2.4 minutes.
2. **Gates waited on the owner or on the verifier, which runs every 15 minutes.**
3. **Every step started from scratch.** On #14 the architect read 0.8M tokens, the coder 1.7M and the reviewer 0.6M. Each fix loop starts another fresh session.
4. **The architect, on Opus at high effort, is the slowest step.**
5. **Everything ran one step at a time.**

## Decisions (settled 2026-10-20)

- **Solo lane, the default.** One all-rounder, Captain America ("Cap"), on Opus 5.5 at high effort, works the way a local Claude Code session does. The full team handles epics, briefings, design reviews, or anything the owner sends with "full team".
- **The PR opens by itself.** The owner's approval now means "merge and deploy to staging". There are no production deploys (no prod access yet).
- **wati-relay deploys need a second tap.** Its staging project `pos-staging-0` serves real customers. Approving merges it, and a separate "Deploy now" tap deploys it. The check after its deploy only reads logs and never sends a message.
- **The desktop verifier is retired.** The office checks staging itself right after each deploy. A failed check posts the report and a Roll back button, then opens a follow-up fix task.
- **CLI logins are the Mac's own OAuth sessions** (gcloud, firebase, gh, vercel), so there are no credential files. Each repo pins its account and project. When a login expires, the office runs the CLI's sign-in-on-another-device flow and posts the link in Slack.
- **Fury is the one brain in Slack, in plain language.** The fixed grammar (`repo: title`, `steer:`, `reject: …`) goes away. Heroes post their handoffs under their own name, and the owner can address any hero by name. Heroes don't chat among themselves.
- **Instinct takes instructions only from Akhil.** Colleagues' asks only go into his digest, and a task starts only when he says so. This keeps the office single-user, which is what the personal plan is for.
- **The architect stays on Opus for every size,** including S (it's taken out of "Sonnet for small tasks"). No other role changes model.
- **No Remote Control.** Sessions started with a `claude setup-token` token can't open Remote Control, and the Agent SDK has no option for it. Slack steering covers it.
- **The office stays on while the Mac is awake,** so it can be reached from the phone through Slack.

## Step 1: solo lane (Cap)

- **Role:** `all-rounder` (`agents/all-rounder.md`).
  - Settings: Opus 5.5 at high effort; tools Read, Grep, Glob, Bash, Edit, Write, WebFetch and WebSearch; `write: all`; skills `[write-pr]`.
  - What its prompt says: read what matters, plan briefly in your head, make the change, add tests for behaviour changes, then run the repo's build, lint and tests. Review your own diff against the request, then hand off the PR text.
  - Escape hatch: if the request turns out bigger than it looked, it raises a blocker instead, and the office moves the task to the full team (`standard`), starting with a plan.
- **Lanes** (`domain.ts`, `lanes.ts`):
  - New tasks get `solo` or `standard` (the full team). Old tasks' `trivial` and `small` run as solo.
  - Intake puts a task on the full team when it is an epic, has a briefing, needs a design review, is size L, or the owner asked for the full team. Everything else goes to `solo`, including size M, bugs and research.
  - The board's mission panel gets **Who builds it**: Auto / Solo / Full team. The owner's Solo pick wins over the manager's sizing; only a briefing still needs the architect. An epic's Full-team pick carries over to its milestones.
- **Pipeline:**
  - The solo step goes intake → `coding` (Cap) → commit, then the PR opens right away (see below).
  - Thor reviews it once first when the diff is past `SMALL_MAX_LINES` / `SMALL_MAX_FILES` (prose doesn't count, but agent instructions and skills do), or when Cap read web pages while working. Blocking findings go back into Cap's own session (Agent SDK `resume` with the run's session id), not a fresh one.
  - Tasks Fury creates (step 4) already carry their lane, so they skip intake.
- **The PR opens by itself** (both lanes):
  - Once checks pass, the office pushes and opens a ready-for-review PR. That replaces the push gate and the `autoApprovePush` setting.
  - The new gate kind `merge`: **Merge** (step 3 makes it "Merge and deploy to staging") or **Changes needed**. The merge takes exactly the commit the office pushed (`--match-head-commit`), so nothing pushed after it merges unseen.
  - "Changes needed" (reject with a comment) goes back to Cap or the coder, who push new commits to the same PR; its title and description are refreshed.
  - A merge cut off by a stop or a restart is never retried blind: resuming checks GitHub, then asks again. A PR closed on GitHub drops the gate. A milestone stacked on another merges only after that one has, retargeted to the default branch; a predecessor dropped without merging blocks it with the reason.
- **Merge method:** a `repos.merge_method` column (squash, merge or rebase; migration 0008), edited under Repos → Edit. It moved here from step 3's `ship` settings because merging lands in this step.
- **Fix loops resume their session.** Review findings, failing tests or "Changes needed" go back into the last coding session of the same role (Agent SDK `resume`), unless the architect has planned since. If the session can't be resumed, the run starts fresh. A resumed run records only its own tokens (the SDK reports the session's whole history). This covers the coder too, so step 5's item is done here.
- **Feedback survives a failed step.** It stays on the task until the step that got it succeeds, so a rate limit, a failure or a restart doesn't lose your comment.
- **Models:** `forSize` stops moving the architect to Sonnet. The reviewer keeps its current S-size rule.
- **Office:** the Helicarrier's Captain America resident (`captain`) plays the all-rounder (`residentFor` in pixelBridge.ts); layouts without him use the coder's desk.

## Step 2: always on while the Mac is awake

Built 2026-10-20.

- **Login item:** `tools/mac-agent.sh install|uninstall|status` writes `~/Library/LaunchAgents/com.pixeloffice.office.plist`.
  - Settings: RunAtLoad, KeepAlive, a ThrottleInterval of 30 s so a crash loop doesn't spin, and the PATH of the shell `install` ran from.
  - It runs `tools/office-service.sh`, which waits while another copy serves the port (one started by hand) and then takes over. It builds the board, then `exec`s the office itself, so launchd's SIGTERM reaches the office's shutdown handler and running steps are parked, not killed. `caffeinate -s -w <office pid>` keeps the Mac from sleeping on power only. No system setting changes.
  - Logs go to `~/.office/server.log`.
- **Slack recovers after a dropped connection** (`server/src/slackLink.ts`). @slack/socket-mode 3.1.0's own reconnect treats a network error as unrecoverable and leaves an unhandled rejection. That fits the dead Slack link seen after Wi-Fi drops.
  - The office turns that reconnect off and owns it: one attempt at a time (never two sockets), waiting 1 s, then doubling up to 2 min, forever.
  - The first connection is retried the same way when the office starts before the network is up (`untilConnected`). A failed start leaves no socket behind.
  - Stray promise rejections are logged instead of crashing the office.
  - Tested against the real socket-mode client and a stand-in local Slack.
- **Pixel office:** `install --with-pixel` adds `com.pixeloffice.pixel` (`start.sh`).
- **README:** "Keep it running on your Mac", including the closed-lid caveat (a MacBook sleeps unless it's on an external display).

## Step 3: shipping (merge, staging deploy, live check, rollback, logins)

Built 2026-10-20.

- **Data:** a `repos.ship` JSON column (migration 0009), edited under Repos → Edit → Staging:
  - `staging`: `deployCmd`, `cwd`, `project`, `account`, `confirm` (the second tap), `healthUrls`, `checkNotes`, `rollbackCmd`.
  - No staging section: approving a PR only merges it, as in step 1.
- **Statuses:** `awaiting_merge_approval` → `merging` → (`awaiting_deploy_approval` when `confirm`) → `deploying` → `checking` → `retro`/`done`. A failed check goes to `check_failed` (gate `rollback`) or straight to the retrospective when the repo has no rollback command.
- **Deploy** (`deploy()` in pipeline.ts, `ship.ts`; runs in the background, in its own process group, so Stop and Discard kill it):
  - The office runs `deployCmd` itself, not an agent, in a fresh detached checkout of the merged default branch (`<id>-deploy`, with the repo's setup command).
  - It uses my own CLI logins with `CLOUDSDK_CORE_PROJECT`, `GOOGLE_CLOUD_PROJECT` and `CLOUDSDK_CORE_ACCOUNT` pinned (that covers gcloud; firebase deploys where its own command or `.firebaserc` says, so a firebase deploy command must name its project). A command naming another project (`--project`, `-P`, `firebase use`, env prefixes, `gcloud config set project`) or switching configuration is refused. A failed fetch stops the deploy rather than shipping stale code.
  - The last 60 lines of output are kept as `deploy.md`. A failure blocks the task with the reason; resuming deploys again, except on a `confirm` repo, which asks for the tap again.
  - A PR I merge on GitHub myself ships the same way.
- **Live check:** the new role `verifier` (Hawkeye; Sonnet 5.5, high effort; Read/Grep/Glob/Bash, no writes) runs in the deploy checkout with the project pinned.
  - Its guard is `lookOnly` (`lookOnlyCheck` in guard.ts), a short list of what may run: plain readers inside the checkout, read-only git, curl GETs of the repo's staging URL hosts only, and fixed cloud read forms (`gcloud logging read`, `run services|revisions describe|list`, `functions describe|list|logs read`, `firebase functions:log`, `vercel logs|inspect`) pinned to the project. Everything else is refused without asking: wrappers, interpreters, `xargs`, env prefixes, substitutions, redirects, the repo allow-list.
  - It reports `verify.md` (stage `staging`), which is posted in the thread.
- **Failure:** a solo follow-up task "Fix staging: …" gets the report. With a `rollbackCmd`, the task waits on **Roll back** or **Keep it**.
- **Logins, simplified for now:** when a deploy fails on an expired login (gcloud, firebase, vercel, gh), the block note names the command to run on the Mac, e.g. `firebase login --reauth`; then resume. The sign-in-on-another-device relay through Slack waits for Fury (step 4), who can run it and pass the code.
- **Verifier skill:** it now also handles merge gates. The desktop scheduled task `office-verifier` is deleted once this is merged into the office you run (until then the running office still relies on it).
- **Not done yet:** the item-search and wati-relay staging settings go into the live office's database after the merge:
  - item-search: `bash deploy/deploy-environment.sh staging` on project `zobaze-poc-akhil`.
  - wati-relay: `npm run deploy:staging` in `point-of-sale/wati-relay`, project `pos-staging-0`, with `confirm` on, log-only checks and no messages ever.

## Step 4: Fury at the desk (Slack in plain language)

Built 2026-10-20 on `feat/phase-7-fury`. Decisions where the plan was open:

- **No `conversations` table.** Another branch owns the next migration, so the thread-to-session map is a JSON file, `~/.office/slack-conversations.json` (`conversations.ts`). Fury's sessions are kept under `~/.office/desk`. Entries untouched for 30 days are dropped.
- **A task started in a thread becomes that thread's task thread** (the bridge's existing `claim`), so the status message, gate buttons and questions stay in the conversation. If the thread already has a task, the new one gets its own thread in the owner's DM and Fury says so.
- **Typed answers to briefing questions go through Fury** (`answer_question`, owner only); the open question is in the header Fury reads with each message. The buttons still answer directly.
- **Heroes' handoffs** are posted from `step_end` events, reading the step's document after the pipeline saves it. A hero the owner steered live posts their first words after the steer, under their name.
- **Added beyond the plan:** a `review_pr` tool (pasting a PR link used to start a review), `briefing_action` (send / enough), a limit of 40 assistant messages answered per hour on top of the 5 tasks per hour (Fury would otherwise answer an assistant's every message, and two bots could talk for ever), and `Pipeline.leaveNote` (a note for a hero who isn't running, which must not reach whoever is).
- **Not done:** tasks Fury creates still go through intake (the plan's step 1 note that they skip it needs a pipeline change; their lane pick already wins over the manager's). The verifier hero (Hawkeye) is in the map and speaks for live-check reports; the staging check itself comes with step 3. `roll_back` waits for step 3's gates.

- **One brain:**
  - Every owner or Instinct message in the DM or the office channel goes to Fury instead of the command parser. That means top-level messages and thread replies.
  - Fury is a manager agent on Sonnet 5.5 at low effort, so replies come back in seconds. It has no file tools.
  - Each Slack thread is one conversation. A new table `conversations(channel, thread_ts, session_id, updated_at)` maps it to an Agent SDK session, resumed with each new message.
- **Tools** (in-process MCP via `createSdkMcpServer`):
  - Anyone allowed to speak:
    - `list_repos`, `list_tasks`, `task_status`;
    - `start_task(repo, request, lane, refs, links, files from the Slack message)`;
    - `steer(task, hero?, note)`;
    - `pause` / `stop` / `resume`.
  - Owner only:
    - `answer_question`, `approve` / `reject` (merge, deploy, plan, breakdown);
    - `roll_back`, `discard`, `done`, `replan`.
  - Each turn is a fresh `query()` resuming the thread's session, with the tool set for that message's sender. Instinct's turns never get the owner-only tools, and each handler checks the sender again.
  - `ASSISTANT_TASKS_PER_HOUR` stays.
- **Status, ETA, blockers:**
  - `task_status` returns the step, the hero working on it, elapsed time, pending gates ("waiting on you: merge"), blockers, the last few events and the PR link.
  - The ETA comes from code: the median duration per lane and step over recent successful runs, minus elapsed time. Fury reports it and never makes one up.
- **Heroes speak:**
  - Add the `chat:write.customize` scope to `tools/slack-app-manifest.yml`, then reinstall the app.
  - Handoffs post under the hero's name with an emoji avatar. Image avatars need a public URL, which comes later with Cloudflare.
  - Who posts what:
    - Strange: the plan summary.
    - Cap or Iron Man: "done, N files, tests pass".
    - Thor: the review verdict.
    - Hulk: test results.
    - Hawkeye: the live check.
  - The single edited status message stays.
- **Addressing a hero:**
  - "Loki, use the shared button" becomes a steer to Loki's running session. If he isn't running, it goes to his next run. His first reply after it posts under his name.
  - "Thor, what's up?" is answered by Fury from live state, without interrupting Thor.
- **Removed:**
  - the fixed grammar (`HELP`, `parseTask`'s `repo:` prefix rule, `isExplicitCommand`, the `steer:` / `reject:` / `ref:` syntax);
  - typed "approve" / "reject" (they go through Fury's tools). Gate and question buttons stay.
  - The steer box (uncommitted on `feat/slack-steer-box`) isn't shipped in the office. It stays on its branch for the WATI relay idea.
- **Instinct:**
  - Rewrite `docs/instinct-prompt.md`: Instinct takes instructions only from Akhil and talks to Fury in plain language in the office channel, with no template.
  - Colleagues' asks go only into the digest.
  - Its "follow each task" table changes to match the new messages: PR opened, merged, deployed to staging, live check.

## Step 5: team-lane trims

Built 2026-10-20.

- **Plans go ahead on their own** unless a briefing shaped them or I've sent one of that task's plans back. Strange's plan is posted in the thread ("Plan ready, going ahead") with the way to change course (ask for a new plan). The auto-approved plan gate is kept on the task. Settings → **Plans wait for me** brings back an approval for every plan.
- **Fix loops resume the coder's session:** done in step 1.
- **Milestones:** no change needed. The next milestone already starts when the previous one's PR is open, and PRs now open as soon as checks pass.
- **Review and tests in parallel: not done.** The office's data puts the tester at 0.2–1 minute per task, so running them side by side would save under a minute. It would also need two sessions on one task at once (separate worktrees, cherry-picked test commits, new failure paths). Worth revisiting only if tests get slow.

## Not doing

- **Production deploys:** no access yet. `ship` has no prod section.
- **Remote Control for office sessions:** not supported for `claude setup-token` tokens or Agent SDK sessions.
- **Agents chatting freely in Slack:** slower and costs tokens with no gain.
- **Credential files:** not needed on the Mac. A cloud host would need a GCP service account limited to staging, plus Vercel and GitHub tokens.
