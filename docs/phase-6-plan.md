# Phase 6 plan: mission skills, briefings, attachments

Design: [design.md](design.md#mission-skills-briefings-and-attachments). Three steps, each reviewed independently and verified on the live board before the next.

## Step 1: mission skills

- **Data:** `tasks.skill_picks` (JSON `{role: {skills, by: owner|manager, why}}`), migration 0004.
- **Catalog API:** `GET /api/skills` already lists names and descriptions; add `wrapper` (calls the Skill tool) and import metadata.
- **Import:** `GET /api/skills/importable` scans `~/.claude/skills`, `~/.claude/plugins/**/skills` and the desktop app's plugin skill folders; each entry has source label, path, hash, imported/update state. `POST /api/skills/import {key}` copies `SKILL.md` into `~/.office/skills/<name>/` with `.source.json` (path, hash, time). Only discovered paths can be imported. `GET /api/skills/:name/update` returns the old and new text for the diff.
- **Picks:** `POST /api/tasks` takes `skills: {role: string[]}` (locked, by owner). The intake contract gains `skills:` and `skill_reasons:`; the manager's prompt lists the catalog and the locked roles; unknown names are dropped with an alert. `PUT /api/tasks/:id/skills {role, skills}` for roles that haven't started.
- **Running:** each step's agent = role defaults + repo skills + mission skills for that role; the office adds the "ask the user / sub-agents" adapter lines.
- **UI:** mission panel skill picker per role (chips from the catalog); task page skills panel (who picked, why, editable until the role starts; shown with the plan gate); Team page Import dialog and "update available" diff.

## Step 2: briefing (grilling in planning)

- **Data:** `tasks.grill_mode` (auto|always|never), `tasks.grill`, `tasks.grill_reason`; table `questions` (task, run, round, index, title, body, options, recommended, answer, answered_via, answered_at, slack_ts); gate kind `question`; status `awaiting_answer`; document `brief.md`. Migration 0005.
- **Intake:** contract gains `grill: true|false` and `grill_reason`; the mission's mode overrides it.
- **Runner:** an `interject(text)` hook on each successful result, before validation. The pipeline recognises a question round (front matter `questions:`), stores it, opens the gate and waits up to 15 minutes. Answers go back into the same session; a timeout parks the run (`parked`). Owner messages sent while a round is open are held and sent with the answers.
- **Pipeline:** parked → `awaiting_answer` (resume status planning, slot freed); answers on a parked task resume planning with the brief. Stop, discard and re-plan cancel the round. Boot recovery keeps open question gates and parks the task as `awaiting_answer`.
- **Answers API:** `POST /api/questions/:id {answer | decide | option}` and `POST /api/tasks/:id/briefing {action: send|enough}`.
- **Board:** a briefing card on the task page (one question at a time, history above), a question chip in the office's Live panel and on board cards.
- **Slack:** each question as a message with option buttons, Lock it in, You decide, Enough; a thread reply answers the open question; messages update when answered elsewhere.

## Step 3: attachments

- **Upload:** `POST /api/uploads` (raw body, `x-filename`), 10 MB per file, kept in `~/.office/uploads/` until a task claims it. `POST /api/tasks` takes `attachments: [uploadId]` and `links: [url]`; total 25 MB. `GET /api/tasks/:id/attachments/:name`.
- **Guard:** `GuardContext.readRoots` (the task's attachments folder), read-only through Read/Grep/Glob.
- **Prompts:** an Attachments section in every step; manager and architect told to read them.
- **Slack:** files on the DM that starts a task are downloaded with the bot token (`files:read`, `file_share` messages).
- **UI:** drop zone and link field in the mission panel; attachment list on the task page.
