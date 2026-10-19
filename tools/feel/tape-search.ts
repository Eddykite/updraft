/**
 * Re-derive the browser suite's input tape against the real simulation.
 *
 * `e2e/game.ts` flies an open-loop schedule so that the game-over screenshot
 * shows a game someone played rather than a card reading zero. The tape is a
 * property of the *course*, so every gameplay constant that moves invalidates
 * it — and the only symptom of a rotten tape is quietly worse deploy evidence,
 * which is exactly the kind of failure nobody notices.
 *
 * So the tape is not hand-tuned, it is searched: hill-climb the phase durations
 * against `step()` on the seed the browser uses, scoring each candidate by its
 * **worst** outcome under a one-sided delay of up to +50 ms per phase. One-sided
 * because a CDP round trip only ever makes a phase longer, never shorter.
 *
 * Run with `pnpm feel:tape`. It prints a tape to paste into e2e/game.ts; the
 * test in tests/playable.test.ts then holds whatever is pasted to the same bar,
 * on patterns the search never saw.
 */

import { FIXED_DT } from '../../src/game/constants.js'
import { createInitialState } from '../../src/game/state.js'
import { step } from '../../src/game/update.js'

/** Deterministic PRNG, so a search run is reproducible. */
function mulberry(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Fly one tape on one jitter pattern and report the score it ends on. */
export function flyTape(
  seed: number,
  tape: readonly number[],
  delayPerPhaseMs: number,
  rand: () => number,
): number {
  let state = step(createInitialState(seed), { holding: false, confirmPressed: true }, FIXED_DT)
  let edge = 0
  const edges = tape.map((duration) => (edge += duration + delayPerPhaseMs * rand()))
  const total = edges[edges.length - 1] as number

  // An explicit frame budget rather than a loop that trusts its own exit
  // condition: a synchronous hang is the one failure a test runner cannot
  // report, and this file is imported by the suite.
  const budget = Math.ceil((total / 1000 / FIXED_DT) * 2) + 600
  let frames = 0
  while (state.phase === 'playing' && state.elapsed * 1000 < total) {
    if (++frames > budget) throw new Error('flyTape exceeded its frame budget')
    const ms = state.elapsed * 1000
    let i = 0
    while (i < edges.length && ms >= (edges[i] as number)) i += 1
    state = step(state, { holding: i % 2 === 0, confirmPressed: false }, FIXED_DT)
  }
  return state.score
}

export interface TapeQuality {
  /** Score with no delay at all — the bar the first browser assertion sets. */
  readonly clean: number
  /** The worst score across the jittered replays. The bar that actually matters. */
  readonly worst: number
  /** How many of them scored anything. */
  readonly scoring: number
  readonly samples: number
  readonly mean: number
}

/** How good a tape is, across `samples` jittered replays plus the clean one. */
export function measureTape(seed: number, tape: readonly number[], samples = 120): TapeQuality {
  const clean = flyTape(seed, tape, 0, () => 0)
  let worst = Infinity
  let scoring = 0
  let total = 0
  for (let i = 0; i < samples; i += 1) {
    const score = flyTape(seed, tape, 50, mulberry(i * 7919 + 1))
    worst = Math.min(worst, score)
    total += score
    if (score > 0) scoring += 1
  }
  return { clean, worst, scoring, samples, mean: total / samples }
}

/**
 * A single number to climb.
 *
 * It has to be graded, not pass/fail. The obvious objective — the worst score
 * across the jittered replays — is zero for almost every tape, so the search
 * sees a flat landscape and never takes a first step. (That is not hypothetical:
 * it is what the first attempt at this did, reporting the starting tape as the
 * best of three runs because every candidate tied at zero.) Counting how many
 * replays score at all gives the climb a gradient to follow long before any tape
 * clears the real bar.
 */
function quality(q: TapeQuality): number {
  return (
    (q.clean > 0 ? 1e9 : 0) + (q.worst > 0 ? 1e8 : 0) + q.scoring * 1e4 + q.worst * 100 + q.mean
  )
}

/** Hill-climb a tape's phase durations, starting from `start`. */
export function searchTape(
  seed: number,
  start: readonly number[],
  iterations = 4_000,
  searchSeed = 1,
): { tape: number[]; quality: TapeQuality } {
  const random = mulberry(searchSeed)
  let best = [...start]
  let bestQuality = measureTape(seed, best)

  for (let i = 0; i < iterations; i += 1) {
    const candidate = [...best]
    // Perturb one phase, by less as the search settles.
    const index = Math.floor(random() * candidate.length)
    const spread = 160 * (1 - i / iterations) + 12
    const moved = Math.round((candidate[index] as number) + (random() * 2 - 1) * spread)
    candidate[index] = Math.min(900, Math.max(60, moved))
    const measured = measureTape(seed, candidate)
    if (quality(measured) > quality(bestQuality)) {
      best = candidate
      bestQuality = measured
    }
  }
  return { tape: best, quality: bestQuality }
}

// --- entry point -------------------------------------------------------------
// Run with `pnpm feel:tape`. Prints a tape to paste into e2e/game.ts.

const START = [831, 389, 851, 498, 301, 536, 542, 516, 402]
const SEED = 20261018

const best = [1, 2, 3].reduce(
  (carry, searchSeed) => {
    const found = searchTape(SEED, START, 2_500, searchSeed)
    return found.quality.worst > carry.quality.worst ? found : carry
  },
  { tape: [...START], quality: measureTape(SEED, START) },
)

const unseen = measureTape(SEED, best.tape, 200)
console.log(`seed ${SEED}`)
console.log(`tape  ${JSON.stringify(best.tape)}`)
console.log(
  `clean ${unseen.clean} points; worst ${unseen.worst} across ${unseen.samples} unseen jitter ` +
    `patterns; ${unseen.scoring}/${unseen.samples} scored; mean ${unseen.mean.toFixed(1)}`,
)
console.log('\nPaste the tape into SCORING_TAPE in e2e/game.ts.')
