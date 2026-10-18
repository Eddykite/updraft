/**
 * Print the feel-tuning report. `pnpm feel`.
 *
 * Answers, over a fixed sweep of seeds so two runs of this script are
 * comparable:
 *
 *   1. Is a two-minute run reachable?     survival per profile
 *   2. Do thermals read as worth it?      safe vs collector vs greedy
 *   3. Where does the ramp actually bite? deaths bucketed by elapsed time
 *
 * Question 2 is the one that decides whether the risk layer exists, and the
 * decisive evidence for it is the geometry section at the bottom, which involves
 * no autopilot at all. It is not enough that thermals pay more — that is
 * arithmetic. The layer only works if taking one *costs* something, and the
 * honest measure of that cost is how much of your clearance to the columns you
 * give up by flying the ring's line instead of the gap's centre.
 *
 * See tools/feel/sensitivity.ts for the sweep that establishes the model player
 * is measuring UPDRAFT rather than its own stability.
 */

import { playRun, type PlayerProfile, type RunResult } from './autopilot.js'
import {
  bestAchievableCost,
  costAcrossTheRamp,
  sampleCourse,
  searchForRiskyPlacement,
} from './geometry.js'

const SEEDS = Array.from({ length: 200 }, (_, i) => 1000 + i * 7)
/** Runs are cut off here; the difficulty ramp has been frozen for 2.5x this long by then. */
const MAX_SECONDS = 240

/**
 * A competent player: leads the kite well but not perfectly, reads its altitude
 * to about half the kite's own diameter, and plays through a typical phone's
 * 83 ms of input-to-pixel lag. The sensitivity sweep shows survival is a smooth
 * function of both of those, so this point is a sample of a gentle surface
 * rather than a cherry-picked cell.
 */
const COMPETENT = {
  latency: 0.083,
  deadZone: 8,
  anticipation: 0.7,
  aimJitter: 10,
  perception: 16,
  riskTolerance: 34,
} as const

/** The same hands, playing badly: barely leading the kite, reading it poorly. */
const RUSTY = { ...COMPETENT, anticipation: 0.4, perception: 28, aimJitter: 18 } as const

const PROFILES: ReadonlyArray<readonly [string, PlayerProfile]> = [
  ['safe / expert', { ...COMPETENT, strategy: 'safe', anticipation: 1, perception: 0 }],
  ['safe / competent', { ...COMPETENT, strategy: 'safe' }],
  ['safe / rusty', { ...RUSTY, strategy: 'safe' }],
  ['collector / expert', { ...COMPETENT, strategy: 'collector', anticipation: 1, perception: 0 }],
  ['collector / competent', { ...COMPETENT, strategy: 'collector' }],
  ['collector / rusty', { ...RUSTY, strategy: 'collector' }],
  ['opportunist / competent', { ...COMPETENT, strategy: 'opportunist' }],
  ['greedy / competent', { ...COMPETENT, strategy: 'greedy' }],
]

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.floor(q * sorted.length))
  return sorted[index] as number
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length
}

function pct(n: number, total: number): string {
  return `${((100 * n) / total).toFixed(0)}%`
}

function summarise(label: string, results: readonly RunResult[]): void {
  const durations = [...results.map((r) => r.duration)].sort((a, b) => a - b)
  const pastTwoMinutes = results.filter((r) => r.duration >= 120).length
  const thermals = results.reduce((a, r) => a + r.thermalsCollected, 0)
  const gates = results.reduce((a, r) => a + r.gatesPassed, 0)

  console.log(
    [
      label.padEnd(24),
      `median ${quantile(durations, 0.5).toFixed(0).padStart(4)}s`,
      `p10 ${quantile(durations, 0.1).toFixed(0).padStart(3)}s`,
      `p90 ${quantile(durations, 0.9).toFixed(0).padStart(4)}s`,
      `>=120s ${pct(pastTwoMinutes, results.length).padStart(4)}`,
      `score ${Math.round(mean(results.map((r) => r.score)))
        .toString()
        .padStart(6)}`,
      `rings ${gates === 0 ? ' n/a' : pct(thermals, gates).padStart(4)} of gates`,
    ].join('  '),
  )
}

function deathHistogram(results: readonly RunResult[]): void {
  const buckets = [0, 15, 30, 45, 60, 90, 120, 180, MAX_SECONDS]
  const crashes = results.filter((r) => r.crashCause !== null)
  const counts = buckets.slice(0, -1).map((low, i) => {
    const high = buckets[i + 1] as number
    return crashes.filter((r) => r.duration >= low && r.duration < high).length
  })
  const widest = Math.max(1, ...counts)
  buckets.slice(0, -1).forEach((low, i) => {
    const high = buckets[i + 1] as number
    const n = counts[i] as number
    console.log(
      `  ${`${low}-${high}s`.padStart(9)}  ${'#'.repeat(Math.round((28 * n) / widest)).padEnd(28)} ${n}`,
    )
  })
  const column = crashes.filter((r) => r.crashCause === 'column').length
  console.log(`  cause: column ${column}, ground ${crashes.length - column}`)
  console.log(`  survived the ${MAX_SECONDS}s cutoff: ${results.length - crashes.length}`)
}

console.log(`UPDRAFT feel report — ${SEEDS.length} seeds, cutoff ${MAX_SECONDS}s\n`)

const byLabel = new Map<string, readonly RunResult[]>()
for (const [label, profile] of PROFILES) {
  const results = SEEDS.map((seed) => playRun(seed, profile, MAX_SECONDS))
  byLabel.set(label, results)
  summarise(label, results)
}

const at = (label: string): readonly RunResult[] => byLabel.get(label) ?? []

console.log('\nWhere runs end (collector / competent):')
deathHistogram(at('collector / competent'))

console.log('\nRisk/reward — is a thermal a decision or a formality?')
const opportunist = at('opportunist / competent')
const opportunistGates = opportunist.reduce((a, r) => a + r.gatesPassed, 0)
const opportunistRings = opportunist.reduce((a, r) => a + r.thermalsCollected, 0)
console.log(
  `  A player who takes a ring only when it leaves ${COMPETENT.riskTolerance}px of clearance\n` +
    `  still collects ${pct(opportunistRings, opportunistGates)} of them.`,
)
const safeLife = mean(at('safe / competent').map((r) => r.duration))
const collectorLife = mean(at('collector / competent').map((r) => r.duration))
const safeScore = mean(at('safe / competent').map((r) => r.score))
const collectorScore = mean(at('collector / competent').map((r) => r.score))
console.log(
  `  Taking every ring on its cheapest line costs ${(safeLife - collectorLife).toFixed(1)}s of life` +
    ` and pays ${(collectorScore / Math.max(1, safeScore)).toFixed(2)}x the score.`,
)
const greedyLife = mean(at('greedy / competent').map((r) => r.duration))
console.log(
  `  Aiming at the ring's centre rather than its nearest edge costs ${(collectorLife - greedyLife).toFixed(0)}s` +
    ` — a lower bound,\n  since the collector is censored at the ${MAX_SECONDS}s cutoff. That gap is the one real skill` +
    `\n  in the reward layer, and it is the skill of not over-committing to a bonus you were\n` +
    `  already going to get.`,
)

console.log('\nCourse geometry — no autopilot involved:')
console.log(costAcrossTheRamp())

const course = SEEDS.slice(0, 50).flatMap((seed) => sampleCourse(seed, 180))
const free = course.filter((g) => g.marginCost <= 0).length
console.log(
  `\n  Over ${course.length} spawned gates: the gap's own centre line already collects the ring on\n` +
    `  ${pct(free, course.length)} of them, and the average margin given up across all of them is ` +
    `${mean(course.map((g) => g.marginCost)).toFixed(1)}px\n  out of ${mean(course.map((g) => g.clearanceOnCentre)).toFixed(1)}px available.`,
)

const search = searchForRiskyPlacement()
console.log(
  `\n  Can retuning fix it? Swept ${search.tested.toLocaleString()} (gap, ring radius, position) combinations:\n` +
    `  ${search.risky} admit a ring that cannot be collected from a surviving altitude at all.`,
)
const achievable = bestAchievableCost()
console.log(
  `  Relaxing that to merely *expensive*, at the ${achievable.gap.toFixed(0)}px endgame gap ` +
    `(${achievable.marginOnCentre.toFixed(0)}px of margin on the centre line):\n` +
    `    keeping THERMAL_RADIUS at ${22}: best cost ${achievable.atCurrentRadius.cost.toFixed(0)}px, ` +
    `at inset ${achievable.atCurrentRadius.inset} (ring ${achievable.atCurrentRadius.ringToColumn}px off the column)\n` +
    `    free to shrink the ring: best cost ${achievable.best.cost.toFixed(0)}px, at radius ` +
    `${achievable.best.radius} / inset ${achievable.best.inset} (ring ${achievable.best.ringToColumn}px off the column)`,
)
