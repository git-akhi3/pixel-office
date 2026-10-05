# pixel-office

A personal multi-agent dev workspace. See [docs/design.md](docs/design.md) and [docs/phase-1-plan.md](docs/phase-1-plan.md).

- `apps/control` – the control app: agent runner, task board, gates.
- `apps/pixel` – Pixel Agents fork (git subtree of github.com/pixel-agents-hq/pixel-agents, MIT). Has its own `npm install`; not an npm workspace.
- `tools/` – office layout and art generators (`build_layouts.py`, `build_art.py`, `apply.sh <layout>`).

Pixel office: `./start.sh` → http://127.0.0.1:3100

Pull upstream Pixel Agents changes:

    git subtree pull --prefix apps/pixel pixel-upstream main
