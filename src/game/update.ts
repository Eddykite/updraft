/* eslint-disable @typescript-eslint/no-unused-vars -- contract stub; remove when implemented */
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
 * Responsibilities, in order, once implemented:
 *   1. phase transitions (title/gameover + confirmPressed -> a fresh playing run)
 *   2. integrate the kite (physics.ts), clamp velocity, soft-clamp the ceiling
 *   3. scroll and spawn gates (difficulty.ts, spawner.ts)
 *   4. collisions (collision.ts): thermals collected, columns and ground fatal
 *   5. scoring and streak (scoring.ts)
 *   6. append any GameEvents for the shell to drain
 *
 * @throws until the simulation task lands.
 */

import type { GameState, InputState } from './state.js'

export function step(state: GameState, input: InputState, dt: number): GameState {
  throw new Error('not implemented')
}
