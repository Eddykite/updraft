# UPDRAFT

A one-button kite-flying arcade game. Hold to climb, let go to glide. Thread the gaps in the
power lines, snatch the thermals, see how far you get before the wind drops you.

Static site, Canvas 2D, no engine, **zero runtime dependencies**. Built against the signed-off
spec on GOK-2 (v1, 2026-10-17); where this README and the spec disagree, the spec wins.

## Quick start

```sh
pnpm install --frozen-lockfile   # lifecycle scripts are disabled by .npmrc
pnpm dev                         # vite dev server
pnpm verify                      # everything CI runs, minus Playwright
pnpm exec playwright install chromium webkit && pnpm e2e
```

Node 22 (see `.nvmrc`), pnpm 12. `pnpm verify` = typecheck → lint → format check → tests with
coverage → build → bundle budget.

## Controls

|                |                                                                                   |
| -------------- | --------------------------------------------------------------------------------- |
| Climb          | hold Space / ↑ / W / left mouse button, or hold anywhere on the canvas            |
| Start, restart | press any of the above                                                            |
| Pause          | Esc, losing focus, or hiding the tab — the press that resumes does not also climb |
| Mute           | M, or the speaker (a 44 × 44 target, top right); persists across reloads          |

`?seed=12345` replays an identical course — the game-over screen prints the seed a run was
flown with, so a bug report can carry one.

## Layout

```
src/
  main.ts                bootstrap: canvas element, loop driver, visibility/pause wiring
  app/loop.ts            fixed-timestep accumulator; separates update from render
  app/scenes.ts          scene machine: Title | Playing | Paused | GameOver
  game/                  ← pure. no DOM, no canvas, no Date.now, no Math.random
    constants.ts         every tuning number, single source of truth
    rng.ts               mulberry32 seeded PRNG
    state.ts             GameState, InputState, events[], createInitialState(seed)
    update.ts            step(state, input, dt) -> GameState   (the whole simulation)
    physics.ts           kite integration, velocity and position clamps
    spawner.ts           gate + thermal generation, reachability invariant
    collision.ts         circle-vs-rect, circle-vs-circle
    scoring.ts           score, streak, multiplier
    difficulty.ts        speed / gap / interval as pure functions of elapsed time
  io/                    input.ts · storage.ts · audio.ts
  render/                viewport.ts · renderer.ts · hud.ts · palette.ts
```

The shell publishes what it is doing as `data-updraft-*` attributes on `<html>` (phase, score,
best, muted). That is the seam the Playwright suite asserts against — reading pixels off a
canvas proves nothing and breaks on every tuning change. The pixels are evidence for a human
instead: `test-results/screens/`, uploaded by CI.

## The one architectural rule

`src/game/**` is pure. No DOM, no canvas, no `Date.now`, no `Math.random`, no imports from
`io/`, `render/` or `app/`. Everything non-deterministic is passed in; everything that happens
on the way out goes through the `events[]` channel.

This is not style. It is what makes the determinism, golden-replay and 10,000-seed property
tests in spec §3 possible at all, so it fails the build rather than being a review comment:

- **`eslint.config.js`** — `no-restricted-imports` blocks the cross-layer imports, plus
  `no-restricted-globals` / `no-restricted-properties` for `window`, `document`, `localStorage`,
  `fetch`, `Math.random`, `Date.now`, `new Date()`.
- **`tsconfig.game.json`** — typechecks `src/game` with `lib: ["ES2022"]` and `types: []`, so
  browser and Node globals do not merely lint badly there, they do not exist.

Both run in CI.

## The frozen contract

These files are the interface the simulation and shell tasks build against in parallel. Treat
them as frozen: **adding** to them is fine, changing an existing signature or field means
saying so on the task first, because someone else is already coding against it.

| File                    | What is frozen                                                                                                                                                                                                                               |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/game/constants.ts` | Every tuning number from spec §2, exported individually. Game-feel values may be retuned (spec §8.1) — names and units may not.                                                                                                              |
| `src/game/state.ts`     | `GameState`, `InputState`, `Kite`, `Gate`, `Thermal`, `GameEvent`, `Phase`, `CrashCause`, `createInitialState(seed)`, `drainEvents`, `pause`/`resume`, `multiplierFor`. Everything is `readonly`: `step` returns a new state, never mutates. |
| `src/game/rng.ts`       | `Rng`, `createRng(seed)`, and the `[nextRng, value]` return shape of `nextFloat` / `nextRange` / `nextInt` / `nextBool`. Thread the returned generator through; never reuse one you have drawn from.                                         |
| `src/game/update.ts`    | `step(state: GameState, input: InputState, dt: number): GameState` — the signature only. The body throws `not implemented` until the simulation lands.                                                                                       |

Everything else under `src/` is a stub with the right exports and a `not implemented` body.

## Dependency posture

**Runtime dependencies: zero**, and that is load-bearing — it is what makes `pnpm audit --prod`
a real signal and `connect-src 'none'` an honest claim. No runtime dependency is added without
CTO **and** Security Engineer sign-off (spec §7). Dev dependencies are pinned exactly, the
lockfile is committed, CI installs with `--frozen-lockfile`, and lifecycle scripts are disabled.

## CI

One workflow (`.github/workflows/ci.yml`), fail-fast, `permissions: contents: read`, every
third-party action pinned to a commit SHA: install → typecheck → lint → format → tests with
coverage → build → **bundle budget (60 KB gzipped JS, hard fail)** → Playwright smoke against
the built `dist` → `pnpm audit --prod` (blocking) + dev advisories (report only) → upload
`dist`, Playwright report and coverage.

The ≥ 85 % coverage gate on `src/game/**` is wired but **non-blocking** until the simulation
task lands; flipping `COVERAGE_ENFORCE` to `'1'` in the workflow is the entire change. There is
deliberately no coverage gate on `render/`.

**CI does not deploy.** The deploy job is added later, once a host is chosen.

## Deploy neutrality

The host is deliberately deferred to deploy time (spec §5), and two rules keep that free:

- The Vite `base` path comes from `UPDRAFT_BASE` and defaults to `/`. Never hardcode it —
  GitHub Pages project sites serve from `/<repo>/`.
- Security headers are authored once, host-agnostically, in [`deploy/headers.md`](deploy/headers.md).
  The deploy task projects them into `_headers` or a `<meta>` subset. Do not scatter header
  strings into host config files.
