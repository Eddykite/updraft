/**
 * The UPDRAFT state contract (spec §2).
 *
 * This file is the interface between the three layers:
 *
 *   io/input.ts      produces InputState
 *   game/update.ts   step(state, input, dt) -> GameState
 *   render/*         reads GameState, never mutates it
 *   io/audio, io/storage  drain state.events after each step
 *
 * Everything is `readonly`. `step` returns a new state; it never mutates its
 * argument. That is what makes the determinism and replay tests in spec §3
 * possible, and the renderer safe to run against any state.
 */

import { createRng, type Rng } from './rng.js'
import {
  FIRST_GATE_DELAY,
  KITE_START_Y,
  MULTIPLIER_CAP,
  STREAK_PER_MULTIPLIER,
} from './constants.js'

/** The scene machine's state, owned by the simulation. app/scenes.ts reads it. */
export type Phase = 'title' | 'playing' | 'paused' | 'gameover'

/** What ended a run. `null` while alive. The kite never dies at the ceiling. */
export type CrashCause = 'ground' | 'column'

/**
 * The entire input surface of the game, produced by io/input.ts.
 *
 * `holding` is true while any key/pointer/touch that means "climb" is down
 * (multi-touch counts as held if at least one finger is down). `confirmPressed`
 * is an edge, true for exactly the step in which start/restart was pressed.
 */
export interface InputState {
  readonly holding: boolean
  readonly confirmPressed: boolean
}

/** Vertical state of the kite. Its x is fixed at KITE_X; collision is a circle of KITE_RADIUS. */
export interface Kite {
  readonly y: number
  readonly vy: number
}

/**
 * The updraft ring that leads a gate, sitting *outside* its gap (spec §2.2).
 *
 * It has no x of its own: it rides THERMAL_LEAD ahead of the column centre line,
 * at `collision.thermalX(gate)` = `gate.x - 29`, so the kite meets it before the
 * columns. `y` is absolute in field coordinates and is at least THERMAL_RADIUS
 * clear of the gap band, on the side the spawner drew.
 */
export interface Thermal {
  readonly y: number
  readonly radius: number
  readonly collected: boolean
}

/**
 * A power-line gate: two columns with a gap between them, plus one thermal.
 *
 * `x` is the left edge of the column pair and decreases as the world scrolls.
 * The gap spans [gapY, gapY + gapHeight]; the columns are everything else.
 */
export interface Gate {
  readonly id: number
  readonly x: number
  readonly gapY: number
  readonly gapHeight: number
  readonly thermal: Thermal
  /** Set once the gate's trailing edge is behind the kite and it has been scored. */
  readonly passed: boolean
}

/**
 * Side-effect channel. The simulation appends events during a step; the shell
 * drains them afterwards and turns them into sound and storage writes. The
 * simulation itself never makes a sound, writes storage, or touches a pixel.
 */
export type GameEvent =
  | { readonly type: 'run_started' }
  | { readonly type: 'gate_passed'; readonly gateId: number; readonly points: number }
  | { readonly type: 'thermal_collected'; readonly gateId: number; readonly points: number }
  /**
   * A gate went by with its ring untaken: the streak steps down by
   * STREAK_MISS_PENALTY, floored at 0. `streak` is the value *after* the step,
   * so the shell never has to recompute the rule to show it.
   *
   * Named for what it now is. v1's `streak_reset` was accurate when a miss cost
   * you everything; under the step-down rule a reset is only the special case
   * where the streak was already below 2.
   */
  | { readonly type: 'streak_dropped'; readonly gateId: number; readonly streak: number }
  | { readonly type: 'multiplier_up'; readonly multiplier: number }
  | { readonly type: 'crashed'; readonly cause: CrashCause; readonly score: number }

export interface GameState {
  readonly phase: Phase
  /** The seed this run was created from. Shown on the game-over screen so a bug report can carry it. */
  readonly seed: number
  /** Seeded PRNG state. Threaded through every draw; see game/rng.ts. */
  readonly rng: Rng
  /** Number of fixed steps executed in this run. */
  readonly tick: number
  /** Seconds elapsed in this run. Always tick * FIXED_DT; it drives the difficulty ramp. */
  readonly elapsed: number
  readonly kite: Kite
  /** Live gates, oldest (leftmost) first. Gates are dropped once fully off-screen. */
  readonly gates: readonly Gate[]
  /** Monotonic id source for new gates. */
  readonly nextGateId: number
  /** Seconds until the next gate spawns. */
  readonly spawnTimer: number
  /** Total logical px the world has scrolled in this run. */
  readonly distance: number
  readonly score: number
  /**
   * Collecting credit, in [0, STREAK_MAX]. +1 per ring taken, -2 per gate passed
   * without one. Not a run of consecutive collects any more — it is a running
   * balance, which is what makes the multiplier mean "you are taking more than
   * two thirds of the rings" rather than "you have not missed one yet".
   */
  readonly streak: number
  /** Derived: min(1 + floor(streak / 2), 5). Stored so the renderer need not recompute. */
  readonly multiplier: number
  readonly crashCause: CrashCause | null
  /** Drained by the shell after each step — see drainEvents. */
  readonly events: readonly GameEvent[]
}

/** Multiplier rule (spec §2). Exported because scoring, HUD and tests all need it. */
export function multiplierFor(streak: number): number {
  return Math.min(1 + Math.floor(streak / STREAK_PER_MULTIPLIER), MULTIPLIER_CAP)
}

/**
 * A fresh state at the title screen, deterministic in `seed`.
 *
 * The same seed plus the same input sequence always produces the same run — the
 * golden-replay test in spec §3 depends on exactly this.
 */
export function createInitialState(seed: number): GameState {
  return {
    phase: 'title',
    seed,
    rng: createRng(seed),
    tick: 0,
    elapsed: 0,
    kite: { y: KITE_START_Y, vy: 0 },
    gates: [],
    nextGateId: 0,
    spawnTimer: FIRST_GATE_DELAY,
    distance: 0,
    score: 0,
    streak: 0,
    multiplier: 1,
    crashCause: null,
    events: [],
  }
}

/**
 * Take the queued events and return a state with an empty queue.
 *
 * The shell calls this once after each batch of steps, plays/persists what it
 * got, and keeps the returned state. Events left undrained accumulate.
 */
export function drainEvents(state: GameState): [GameState, readonly GameEvent[]] {
  if (state.events.length === 0) return [state, []]
  return [{ ...state, events: [] }, state.events]
}

/**
 * Pause / resume. The shell calls these on visibilitychange or focus loss; the
 * simulation is simply not stepped while paused, so no time passes.
 */
export function pause(state: GameState): GameState {
  return state.phase === 'playing' ? { ...state, phase: 'paused' } : state
}

export function resume(state: GameState): GameState {
  return state.phase === 'paused' ? { ...state, phase: 'playing' } : state
}
