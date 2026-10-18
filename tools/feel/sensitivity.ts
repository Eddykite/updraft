/**
 * How steeply does survival fall off with player imprecision? `pnpm feel:sweep`.
 *
 * This exists to keep the main report honest. If the model player dies quickly,
 * there are two possible explanations — the game is too hard, or the controller
 * is marginal — and the summary numbers alone cannot tell them apart. A sweep
 * can: a game whose difficulty is *fair* degrades gradually as the player gets
 * sloppier, while a controller sitting on its own stability edge falls off a
 * cliff between two adjacent rows. Both failure modes were real here, and both
 * were found by this file rather than by the summary.
 *
 * `perception` is the honest difficulty axis. Latency is not: a player who
 * predicts their own lag perfectly pays nothing for it in a deterministic game,
 * so sweeping latency at anticipation 1.0 produces a flat 100% and tells you
 * nothing. The two columns here are the two things a human actually gets wrong
 * — how well they lead the kite, and how precisely they can see where it is.
 */

import { playRun, type Strategy } from './autopilot.js'

const SEEDS = Array.from({ length: 80 }, (_, i) => 1000 + i * 7)
/** Whole input-to-pixel chain for a typical mid-range phone, not reaction time. */
const LATENCY = 0.083
const ANTICIPATIONS = [1, 0.8, 0.6, 0.4, 0.2, 0]
const PERCEPTIONS = [0, 8, 16, 24, 32]

function row(strategy: Strategy, anticipation: number, perception: number): string {
  const results = SEEDS.map((seed) =>
    playRun(
      seed,
      {
        strategy,
        latency: LATENCY,
        deadZone: 8,
        anticipation,
        aimJitter: 10,
        perception,
        riskTolerance: 0,
      },
      240,
    ),
  )
  const sorted = results.map((r) => r.duration).sort((a, b) => a - b)
  const q = (p: number): string =>
    (sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] as number)
      .toFixed(0)
      .padStart(4)
  const past = results.filter((r) => r.duration >= 120).length
  return [
    `lead ${anticipation.toFixed(1)}`,
    `sight +-${String(perception).padStart(2)}px`,
    `median ${q(0.5)}s`,
    `p10 ${q(0.1)}s`,
    `p90 ${q(0.9)}s`,
    `>=120s ${`${((100 * past) / results.length).toFixed(0)}%`.padStart(4)}`,
  ].join('  ')
}

console.log(
  `Survival vs player imprecision — ${SEEDS.length} seeds, ` +
    `${(LATENCY * 1000).toFixed(0)} ms latency, dead zone 8px, aim jitter +-10px\n`,
)
for (const strategy of ['safe', 'collector'] as const) {
  console.log(`${strategy}:`)
  for (const anticipation of ANTICIPATIONS) {
    for (const perception of PERCEPTIONS)
      console.log(`  ${row(strategy, anticipation, perception)}`)
  }
  console.log('')
}
