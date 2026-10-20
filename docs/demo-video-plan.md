# Helicarrier demo video — plan

Goal: an animated product video where the S.H.I.E.L.D. deck runs a mission end to end — Fury briefs the crew, Strange
plans, Iron Man builds, Hulk smashes it, Thor reviews, Spidey writes the PR — showing every animation the office has
(portals, holograms, chats, night mode, labels, gates), followed by the real board and Slack screens.

## What OpenMontage (github.com/calesthio/OpenMontage, AGPL-3.0) gives us

An agent-driven video production framework (Python + Node, Remotion / HyperFrames / FFmpeg): research → proposal →
script → scene plan → assets → edit → compose, with human approval gates. It does narration (ElevenLabs, Google, or
free local Piper TTS), word-timed captions, music (Suno, ElevenLabs), title cards, zoom-crops, mixing and final
encode, and it runs from Claude Code as skills.

It does **not** record web pages or animate our pixel characters. Its `character-animation` pipeline makes its own
SVG/GSAP characters, which is not our office. So its role here is post-production: the `screen-demo` pipeline (takes a
provided recording, scripts it, picks zoom regions, generates subtitles and narration, composes) and `hybrid` (mixes
our simulation footage with the real screen captures and generated title cards).

## The three pieces

1. **Director mode in the pixel office** (the real work, about two days). A scenario file (`demo/*.yaml`) the webview
   plays back deterministically, through a `?scenario=` query or a `playScenario` message:
   - `walk <hero> to <area|tile>`, `face`, `gather at <area>` (the briefing ring on the Bridge).
   - `say <hero> "<text>" [seconds]` — a dialogue bubble with text over any character (today only the consent greeter
     has one). Fury: "Mission #42. Strange, plan it. Stark, build it. Banner, break it."
   - `work <hero> "<task>"` / `done <hero>` — the sub-agent job the labels and night mode already react to.
   - `handoff <from> <to>` — the finishing hero walks to the next room's door and hands a glowing brief over.
   - `gate "<title>"`, `approve` — the waiting bubble and the permission sting.
   - `arrive <agent>` / `leave <agent>` — portal in, dust out; `hologram` for a sub-agent without a hero.
   - `camera follow <hero>` / `camera fit` — the camera-follow the office already has, plus a pan to the whole deck.
   - `night on|auto|off`, `pet goose chase`, `break shawarma` (the post-mission gathering).
   Scripted bubbles and walks reuse `officeState` (pathfinding, seats, bubbles), so it is a thin scheduler on top.

2. **Recording** (hours). Playwright is already in `apps/pixel` (`e2e/`). A script opens
   `http://127.0.0.1:3100/?scenario=mission&fit=contain` at 1920x1080 with `recordVideo`, waits for the scenario's
   `done` hook, and writes `demo/raw/mission.webm`. A second pass records the real board (`:4100`, the Office tab, the
   mission board, a Slack thread) the same way. Sound is added in post, not captured.

3. **Post with OpenMontage** (an afternoon once it is set up). Clone it next to this repo, `make setup`, keys in
   `.env` (Piper needs none). Feed it the brief + both recordings through `hybrid`: it writes the narration script
   from the brief, voices it, lays captions, adds music and chapter cards (Brief → Plan → Build → Smash → Review →
   Ship), composes and self-reviews. Approve at its gates.

## Storyboard (about 90 seconds)

1. Cold open, night mode: the eagle glows, Fury at the Bridge rail. Title: "Pixel Office".
2. A task arrives from Slack (real screenshot inset). Portal: a field agent walks in with the brief.
3. Briefing: the crew gathers in a ring around the eagle. Fury's bubbles assign the roles. Lights up.
4. Strange in the Sanctum: label "Strange (architect) / #42 …", the spell circle glows, he says "The plan is written."
5. Handoff to Stark: Iron Man builds, Hulkbuster stands by, holograms for his helper sub-agents.
6. Hulk smashes it: tester label, gamma tanks, a fail bubble, back to Stark, then green.
7. Thor reviews, a gate: the waiting bubble, the permission sting; the real approve button is shown.
8. Spidey writes the PR; the crew drifts to the shawarma counter; fanfare.
9. Cut to the real screens: board, Office tab live panel, Slack thread, PR. End card.

## Order of work

1. ~~Director mode: scenario parser, `say` bubbles, `gather`, scripted `work/done`, `?scenario=`.~~ Built 2026-10-20
   (`office/engine/director.ts`, `scenarios/mission.ts`, `scripts/record-scenario.mjs`). Still to add: `handoff` with a
   travelling brief, portal `arrive`/`leave`, impact beats (shake, dust, lightning), hero close-up portraits.
2. ~~The mission scenario and the Playwright recorder.~~ First cut done; iterate on the script and pacing.
3. OpenMontage setup and a first `hybrid` run on the raw footage; iterate on narration and pacing.
