# pixel-office

A personal multi-agent dev workspace. See [docs/design.md](docs/design.md) and [docs/phase-1-plan.md](docs/phase-1-plan.md).

- `apps/control` – the control app: agent runner, task board, gates.
- `apps/pixel` – Pixel Agents fork (git subtree of github.com/pixel-agents-hq/pixel-agents, MIT). Has its own `npm install`; not an npm workspace.
- `tools/` – office layout and art generators (`build_layouts.py`, `build_art.py`, `apply.sh <layout>`).

## Control app (task board)

    npm install
    npm run office        # http://127.0.0.1:4100
    npm test              # control app tests

It needs a Claude subscription token in `~/.office/env`, created once with `claude setup-token`:

    CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-…     (chmod 600; the folder chmod 700)

Runtime data (database, task documents, worktrees) lives in `~/.office/`. Agents and skills are in `apps/control/agents/*.md` and `apps/control/skills/*/SKILL.md`.

## Pixel office

`./start.sh` → http://127.0.0.1:3100

Pull upstream Pixel Agents changes:

    git subtree pull --prefix apps/pixel pixel-upstream main
