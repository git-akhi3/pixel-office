# pixel-office

A personal multi-agent dev workspace: hand a task to a team of Claude agents (manager, architect, coder, reviewer, tester, plus debugger and researcher on demand), approve the plan and the push, and watch them work in a pixel-art office.

Design: [docs/design.md](docs/design.md). What's built and how to use it: [docs/status.md](docs/status.md).

- `apps/control` – the control app: agent runner, safety guard, task pipeline, board, PR reviews.
- `apps/pixel` – Pixel Agents fork (git subtree of github.com/pixel-agents-hq/pixel-agents, MIT). Has its own `npm install`; not an npm workspace.
- `tools/` – office layout and art generators (`build_layouts.py`, `build_art.py`, `apply.sh <layout>`), and the Slack app manifest.

## Run it

    npm install
    npm run office        # task board: http://127.0.0.1:4100
    npm run pixel         # pixel office: http://127.0.0.1:3100 (also shown in the board's Office tab)
    npm test              # control app tests

The control app needs a Claude subscription token in `~/.office/env`, created once with `claude setup-token`:

    CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-…     (chmod 600; the folder chmod 700)

Runtime data (database, task documents, worktrees, knowledge files, graphs) lives in `~/.office/`. Built-in agents and skills are in `apps/control/agents/*.md` and `apps/control/skills/*/SKILL.md`; edits made on the board's Team page are saved in `~/.office/agents` and `~/.office/skills` and override them.

## Pixel office

`npm run pixel` (or `./start.sh`) runs Pixel Agents with the workspace `~/.office/pixel`, where the board writes the office's activity, so your residents work at their desks while office agents run. To watch a different project, set `PIXEL_WORKSPACE`; to also see your own Claude sessions, turn on "Watch All Sessions" in its settings.

Pull upstream Pixel Agents changes:

    git subtree pull --prefix apps/pixel pixel-upstream main
