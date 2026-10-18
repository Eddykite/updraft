/**
 * Flying `e2e/game.ts`'s open-loop input tape in the simulation.
 *
 * Two callers share this on purpose. `tape-search.ts` uses it to *derive* a
 * tape, and tests/playable.test.ts uses it to check the tape still scores — so
 * the thing the search optimises and the thing the test guards are the same
 * function rather than two copies that can drift apart. They did drift once: the
 * tape outlived the course it was found on (GOK-5's thermal revision) and the
 * only symptom was a game-over screenshot reading zero.
 */

import { FIXED_DT } from '../../src/game/constants.js'
import { createInitialState } from '../../src/game/state.js'
import { step } from '../../src/game/update.js'

/** Deterministic PRNG, so anything built on this has exactly one outcome. */
export function mulberry(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Fly one tape and return the score it ends on.
 *
 * Phases alternate hold / release, starting held. `delayPerPhaseMs` is the
 * one-sided slop a real browser adds: a CDP round trip can only ever make a
 * phase longer, never shorter, so the delay is added rather than centred.
 */
export function flyTape(
  tape: readonly number[],
  seed: number,
  delayPerPhaseMs: number,
  rand: () => number,
): number {
  let state = step(createInitialState(seed), { holding: false, confirmPressed: true }, FIXED_DT)
  let edge = 0
  const edges = tape.map((duration) => (edge += duration + delayPerPhaseMs * rand()))
  const total = edges[edges.length - 1] ?? 0

  while (state.phase === 'playing' && state.elapsed * 1000 < total) {
    const ms = state.elapsed * 1000
    let i = 0
    while (i < edges.length && ms >= (edges[i] as number)) i += 1
    state = step(state, { holding: i % 2 === 0, confirmPressed: false }, FIXED_DT)
  }
  return state.score
}

/**
 * The score a tape is guaranteed to beat: the lowest it reaches over a spread of
 * delay patterns. A tape is only useful if its *worst* case scores, so this is
 * what both the search and the test look at.
 */
export function worstCase(tape: readonly number[], seed: number, samples = 120): number {
  let lowest = flyTape(tape, seed, 0, () => 0)
  for (let i = 0; i < samples; i += 1) {
    lowest = Math.min(lowest, flyTape(tape, seed, 50, mulberry(i * 7919 + 1)))
  }
  return lowest
}
