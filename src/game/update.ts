/**
 * The whole simulation (spec §2).
 *
 * `step` is the only entry point into the game logic. It is a pure function:
 * same `(state, input, dt)` in, same `GameState` out, every time, on every
 * machine. It must not read a clock, call `Math.random`, touch the DOM, or
 * mutate `state` — all of which are enforced by eslint.config.js and
 * tsconfig.game.json rather than by review.
 *
 * It is always called with `dt = FIXED_DT` (1/60) by app/loop.ts. The `dt`
 * parameter exists so tests can integrate at other steps, not so the loop can
 * pass a variable frame time — a variable timestep makes physics frame-rate
 * dependent and the determinism tests impossible.
 *
 * Order of operations inside one playing step. It is fixed, and the golden
 * replay pins it:
 *
 *   1. phase transitions (title/gameover + confirmPressed -> a fresh playing run)
 *   2. integrate the kite (physics.ts); vy clamp and the soft ceiling live there
 *   3. scroll the world and spawn gates (difficulty.ts, spawner.ts)
 *   4. thermals collected (collision.ts), then gate-pass scoring (scoring.ts)
 *   5. fatal collisions: columns first, then the ground
 *   6. cull gates that have left the field, append GameEvents for the shell
 *
 * Seeds. A run's course is entirely determined by `state.seed`, which is why the
 * game-over screen shows it: `createInitialState(seed)` plus `confirmPressed`
 * replays it exactly. The first run of a session uses the seed the shell chose;
 * each restart draws its seed from the finished run's generator, so a session is
 * still deterministic end to end while no two runs are the same course.
 */

import { GATE_WIDTH, KITE_RADIUS, KITE_START_Y, KITE_X } from './constants.js'
import { hitsGateColumns, touchesThermal } from './collision.js'
import { scrollSpeed, spawnInterval } from './difficulty.js'
import { hasHitGround, integrate } from './physics.js'
import { nextInt } from './rng.js'
import { gapCentre, spawnGate } from './spawner.js'
import { gateAward, thermalAward } from './scoring.js'
import {
  createInitialState,
  multiplierFor,
  type CrashCause,
  type Gate,
  type GameEvent,
  type GameState,
  type InputState,
} from './state.js'

export function step(state: GameState, input: InputState, dt: number): GameState {
  switch (state.phase) {
    case 'title':
    case 'gameover':
      return input.confirmPressed ? startRun(state) : state
    // Paused means "no time passes": the shell simply stops stepping, and
    // resuming is state.resume()'s job, not an input the simulation reads.
    case 'paused':
      return state
    case 'playing':
      return stepPlaying(state, input, dt)
  }
}

/** Begin a fresh run from the title or game-over screen. */
function startRun(state: GameState): GameState {
  // First run of the session: use the shell's seed verbatim, so "seed 1234" on
  // the title screen and "seed 1234" in a bug report are the same run. Restarts
  // draw from the finished run's generator.
  const seed = state.phase === 'title' ? state.seed : nextInt(state.rng, 0, 0x7fffffff)[1]
  return {
    ...createInitialState(seed),
    phase: 'playing',
    // Anything the shell has not drained yet survives the transition.
    events: [...state.events, { type: 'run_started' }],
  }
}

function stepPlaying(state: GameState, input: InputState, dt: number): GameState {
  const events: GameEvent[] = []

  const elapsed = state.elapsed + dt
  const kite = integrate(state.kite, input.holding, dt)

  const dx = scrollSpeed(elapsed) * dt
  let gates: Gate[] = state.gates.map((gate) => ({ ...gate, x: gate.x - dx }))

  // --- spawning -------------------------------------------------------------
  let rng = state.rng
  let nextGateId = state.nextGateId
  let spawnTimer = state.spawnTimer - dt
  while (spawnTimer <= 0) {
    // The first gate of a run is placed relative to where the kite starts, so an
    // opening gate is never a scramble; after that each gate is placed relative
    // to the one before it. (A run never has an empty gate list after the first
    // spawn — a gate lives longer on screen than the spawn interval — so the
    // fallback is the first-gate case.)
    const previous = gates.at(-1)
    const previousCentre = previous === undefined ? KITE_START_Y : gapCentre(previous)
    const [afterSpawn, gate] = spawnGate(rng, nextGateId, elapsed, previousCentre)
    rng = afterSpawn
    nextGateId += 1
    gates = [...gates, gate]
    spawnTimer += spawnInterval(elapsed)
  }

  // --- thermals and gate scoring -------------------------------------------
  let score = state.score
  let streak = state.streak
  let multiplier = state.multiplier
  const scored: Gate[] = []
  for (const original of gates) {
    let gate = original

    if (touchesThermal(kite, gate)) {
      // Paid at the rate you had going in; see scoring.ts.
      const points = thermalAward(multiplier)
      score += points
      events.push({ type: 'thermal_collected', gateId: gate.id, points })
      gate = { ...gate, thermal: { ...gate.thermal, collected: true } }

      streak += 1
      const stepped = multiplierFor(streak)
      if (stepped !== multiplier) {
        multiplier = stepped
        events.push({ type: 'multiplier_up', multiplier })
      }
    }

    // Scored once the kite is fully clear of the columns, so a gate can never be
    // banked on the same tick it kills you.
    if (!gate.passed && gate.x + GATE_WIDTH < KITE_X - KITE_RADIUS) {
      const points = gateAward(multiplier)
      score += points
      events.push({ type: 'gate_passed', gateId: gate.id, points })

      if (!gate.thermal.collected) {
        streak = 0
        multiplier = multiplierFor(streak)
        events.push({ type: 'streak_reset', gateId: gate.id })
      }
      gate = { ...gate, passed: true }
    }

    scored.push(gate)
  }

  // --- fatal collisions -----------------------------------------------------
  // Columns before the ground: a lower column reaches the ground line, so when
  // both are true the kite flew into the lines and then landed, in that order.
  let crashCause: CrashCause | null = null
  for (const gate of scored) {
    if (hitsGateColumns(kite, gate)) {
      crashCause = 'column'
      break
    }
  }
  if (crashCause === null && hasHitGround(kite)) crashCause = 'ground'
  if (crashCause !== null) events.push({ type: 'crashed', cause: crashCause, score })

  return {
    ...state,
    phase: crashCause === null ? 'playing' : 'gameover',
    rng,
    tick: state.tick + 1,
    elapsed,
    kite,
    // Gates are dropped once they are fully off the left edge. Everything still
    // on screen is kept, so the list is bounded by the field width over the
    // spawn interval, not by run length.
    gates: scored.filter((gate) => gate.x + GATE_WIDTH >= 0),
    nextGateId,
    spawnTimer,
    distance: state.distance + dx,
    score,
    streak,
    multiplier,
    crashCause,
    events: state.events.length === 0 ? events : [...state.events, ...events],
  }
}
