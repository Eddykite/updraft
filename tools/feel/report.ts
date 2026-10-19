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
 * Two disciplines this file learned the hard way, in the GOK-14 review:
 *
 *   - **Durations can still be censored, and censoring is still reported.** Under
 *     v1 the ramp froze at 90s, so a player alive then was alive forever and
 *     MAX_SECONDS was the only thing making a run finite — which made any
 *     difference of means exactly zero by construction. v2's ramp has no top, so
 *     a censored run now means something has gone wrong with the difficulty
 *     curve rather than with the harness. Comparisons are still reported as a
 *     rate per unit of exposure — deaths per 100 gates — which censoring does not
 *     touch, with durations kept as a description of the profile.
 *   - **A knob that is a step function gets reported as a step**, not sampled at
 *     one point and quoted as if it were a measurement. See the opportunist.
 *
 * See tools/feel/sensitivity.ts for the sweep that establishes the model player
 * is measuring UPDRAFT rather than its own stability.
 */

import { latencyFrames, playRun, type PlayerProfile, type RunResult } from './autopilot.js'
import { centreLineMissAcrossTheRamp, sampleCourse, searchForFreeCollect } from './geometry.js'
import { formatCostTable, formatWorstGateTable } from './cost.js'

const SEEDS = Array.from({ length: 200 }, (_, i) => 1000 + i * 7)
/**
 * The ceiling a run is allowed to reach, not a cutoff it is expected to.
 *
 * v1 cut runs off at 240 s, which was the harness rather than the game — and
 * once the course froze at 90 s it became the only thing making any duration
 * finite, so every number computed from a duration was really a number about the
 * cutoff (GOK-14). Spec v2 deletes it: the course now keeps tightening forever,
 * so a run ends because the course got you, and 600 s is here only to bound the
 * report's own runtime.
 *
 * v2.1: reaching it is a finding at COMPETENT and RUSTY, and the *expected*
 * result at EXPERT — see `censoringReport` for why those are different
 * questions rather than the same one asked twice.
 */
const MAX_SECONDS = 600
/** Whole input-to-pixel chain for a typical mid-range phone, not reaction time. */
const LATENCY = 0.083

/**
 * A competent player: leads the kite well but not perfectly — one of the five
 * in-flight frames at 83ms goes unpredicted — reads its altitude to about half
 * the kite's own diameter, and plays through a typical phone's lag.
 *
 * `unanticipatedFrames: 1` is the whole-frame neighbour of the old
 * `anticipation: 0.7`, which rounded to the same four-of-five prediction. It is
 * expressed in frames now because frames are the only thing the controller can
 * actually do; see the sweep.
 */
const COMPETENT = {
  latency: LATENCY,
  deadZone: 8,
  unanticipatedFrames: 1,
  aimJitter: 10,
  perception: 16,
  riskTolerance: 0,
} as const

/** The same hands, playing badly: barely leading the kite, reading it poorly. */
const RUSTY = { ...COMPETENT, unanticipatedFrames: 3, perception: 28, aimJitter: 18 } as const

const PROFILES: ReadonlyArray<readonly [string, PlayerProfile]> = [
  ['safe / expert', { ...COMPETENT, strategy: 'safe', unanticipatedFrames: 0, perception: 0 }],
  ['safe / competent', { ...COMPETENT, strategy: 'safe' }],
  ['safe / rusty', { ...RUSTY, strategy: 'safe' }],
  [
    'collector / expert',
    { ...COMPETENT, strategy: 'collector', unanticipatedFrames: 0, perception: 0 },
  ],
  ['collector / competent', { ...COMPETENT, strategy: 'collector' }],
  ['collector / rusty', { ...RUSTY, strategy: 'collector' }],
  ['greedy / competent', { ...COMPETENT, strategy: 'greedy' }],
  ['greedy / rusty', { ...RUSTY, strategy: 'greedy' }],
  // Three points on a dial, not two sides of a step. Under v1 the clearance
  // left by the cheapest collecting line was a constant, so the opportunist was
  // a step function of its own tolerance and quoting a number from it quoted an
  // identity (GOK-14). In v2 affordability depends on the gap height and the
  // scroll speed, both of which move continuously, so this axis means
  // something — and these three rows are what it means.
  ['opportunist / 16px', { ...COMPETENT, strategy: 'opportunist', riskTolerance: 16 }],
  ['opportunist / 19px', { ...COMPETENT, strategy: 'opportunist', riskTolerance: 19 }],
  ['opportunist / 20px', { ...COMPETENT, strategy: 'opportunist', riskTolerance: 20 }],
  ['opportunist / 24px', { ...COMPETENT, strategy: 'opportunist', riskTolerance: 24 }],
]

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.floor(q * sorted.length))
  return sorted[index] as number
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length
}

function sum(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0)
}

function pct(n: number, total: number): string {
  return total === 0 ? ' n/a' : `${((100 * n) / total).toFixed(0)}%`
}

function summarise(label: string, results: readonly RunResult[]): void {
  const durations = [...results.map((r) => r.duration)].sort((a, b) => a - b)
  const pastTwoMinutes = results.filter((r) => r.duration >= 120).length
  const censored = results.filter((r) => r.censored).length
  const gates = sum(results.map((r) => r.gatesPassed))
  // Rings taken on gates that are fully behind the kite, against those gates.
  // Using total collections here is what used to print "rings 101% of gates".
  const taken = sum(results.map((r) => r.thermalsTakenOnPassedGates))

  console.log(
    [
      label.padEnd(24),
      `median ${quantile(durations, 0.5).toFixed(0).padStart(4)}s`,
      `p10 ${quantile(durations, 0.1).toFixed(0).padStart(3)}s`,
      `p90 ${quantile(durations, 0.9).toFixed(0).padStart(4)}s`,
      `>=120s ${pct(pastTwoMinutes, results.length).padStart(4)}`,
      `cut off ${pct(censored, results.length).padStart(4)}`,
      `rings ${pct(taken, gates).padStart(4)} of gates`,
    ].join('  '),
  )
}

/**
 * Deaths per 100 gates passed: the metric the cutoff cannot eat.
 *
 * A run that reaches MAX_SECONDS contributes its gates as exposure and no death,
 * which is the right handling of a censored observation — unlike a mean duration,
 * where it contributes a number invented by the cutoff. When a profile records no
 * deaths at all, the rule of three gives the 95% upper bound (3/n events), so
 * "we saw nothing" is reported with the precision it actually has.
 */
function rateTable(labels: readonly string[], at: (label: string) => readonly RunResult[]): void {
  console.log(
    `  ${'profile'.padEnd(24)} ${'gates'.padStart(7)} ${'deaths'.padStart(7)}  deaths per 100 gates`,
  )
  for (const label of labels) {
    const results = at(label)
    const gates = sum(results.map((r) => r.gatesPassed))
    const deaths = results.filter((r) => r.crashCause !== null).length
    const rate =
      deaths === 0
        ? gates === 0
          ? 'n/a'
          : `0  (95% upper bound ${((100 * 3) / gates).toFixed(2)})`
        : ((100 * deaths) / gates).toFixed(2)
    console.log(
      `  ${label.padEnd(24)} ${gates.toString().padStart(7)} ${deaths.toString().padStart(7)}  ${rate}`,
    )
  }
}

function deathHistogram(results: readonly RunResult[]): void {
  const buckets = [0, 15, 30, 45, 60, 90, 120, 180, 240, 300, MAX_SECONDS]
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
  console.log(`  still alive at ${MAX_SECONDS}s: ${results.length - crashes.length}`)
}

/**
 * Spec §3 measurement 1, as v2.1 rewrites it.
 *
 * v2 asserted that *no run reaches 600 s at any modelled skill*. That was
 * unsatisfiable rather than unmet, and the GOK-22 ruling says why: a fair
 * course is one every legal gate can be answered on, so a controller whose own
 * error is under the margin clears all of them, forever. Chasing the assertion
 * would have bought an openly unfair game and still not bought the assertion —
 * the gap floor has to fall from 110 px to 70 px before an expert run ends at
 * all, against a derived fairness requirement of 99.3 px.
 *
 * So the criterion applies to COMPETENT and RUSTY, where censoring is a
 * statement about the course against a player's error rate. **EXPERT is a
 * control, not a criterion.** An exactly-predicting, exactly-perceiving
 * controller surviving indefinitely is the signature of a fair course; the
 * assertion on it runs in one direction only, and if it ever *stops* reaching
 * the ceiling then a floor has been broken and that goes back to the CTO.
 */
const CENSORING_LIMIT = 0.15

function censoringReport(
  criteria: readonly string[],
  controls: readonly string[],
  at: (label: string) => readonly RunResult[],
): void {
  console.log('  criterion — at most 15% of runs may reach the ceiling:')
  for (const label of criteria) {
    const results = at(label)
    const censored = results.filter((r) => r.censored).length
    const share = results.length === 0 ? 0 : censored / results.length
    console.log(
      `  ${label.padEnd(24)} ${pct(censored, results.length).padStart(5)} censored   ` +
        `${share <= CENSORING_LIMIT ? 'pass' : 'MISS'}`,
    )
  }
  console.log('\n  control — reported, never asserted downward (see above):')
  for (const label of controls) {
    const results = at(label)
    const censored = results.filter((r) => r.censored).length
    console.log(
      `  ${label.padEnd(24)} ${pct(censored, results.length).padStart(5)} censored   ` +
        `${censored > 0 ? 'floors intact' : 'A FLOOR HAS BROKEN — back to the CTO'}`,
    )
  }
}

console.log(
  `UPDRAFT feel report — ${SEEDS.length} seeds, ceiling ${MAX_SECONDS}s, ` +
    `${(LATENCY * 1000).toFixed(0)} ms latency (${latencyFrames(LATENCY)} frames in flight)\n`,
)

const byLabel = new Map<string, readonly RunResult[]>()
for (const [label, profile] of PROFILES) {
  const results = SEEDS.map((seed) => playRun(seed, profile, MAX_SECONDS))
  byLabel.set(label, results)
  summarise(label, results)
}

const at = (label: string): readonly RunResult[] => byLabel.get(label) ?? []

console.log(
  '\nDurations above may be censored at the ceiling — compare profiles on this instead:\n',
)
rateTable(
  PROFILES.map(([label]) => label),
  at,
)

console.log('\nDoes the course bound a run? — spec §3 measurement 1, as v2.1 rewrites it:\n')
censoringReport(
  ['safe / competent', 'safe / rusty', 'collector / competent', 'collector / rusty'],
  ['safe / expert', 'collector / expert'],
  at,
)

console.log('\nWhere runs end (collector / competent):')
deathHistogram(at('collector / competent'))

console.log('\nRisk/reward — is a thermal a decision or a formality?')
console.log(
  `  The three opportunist rows above are the answer. Collecting is a detour outside the\n` +
    `  safe corridor and back, so how much of it a player takes depends on how much margin\n` +
    `  they insist on keeping — which is a dial, and the rows show it moving. Under v1 this\n` +
    `  was a step function and any number quoted from it was an identity rather than a\n` +
    `  measurement.`,
)

const safe = at('safe / competent')
const collector = at('collector / competent')
const pointsPerGate = (results: readonly RunResult[]): number =>
  sum(results.map((r) => r.score)) / Math.max(1, sum(results.map((r) => r.gatesPassed)))
const ringRate = (results: readonly RunResult[]): number => {
  const gates = sum(results.map((r) => r.gatesPassed))
  return gates === 0 ? 0 : (100 * sum(results.map((r) => r.thermalsTakenOnPassedGates))) / gates
}
console.log(
  `\n  How much of the ring rate is bought by aiming for rings at all:\n` +
    `  the safe line takes ${ringRate(safe).toFixed(0)}% of them without trying, the collector ${ringRate(collector).toFixed(0)}%, and a\n` +
    `  frame-perfect collector still only ${ringRate(at('collector / expert')).toFixed(0)}%. That shortfall is not caution and not\n` +
    `  reachability — greedy, which aims at the ring's centre, takes ${ringRate(at('greedy / competent')).toFixed(0)}% of the rings on\n` +
    `  the gates it survives. It is that the collector flies the far edge of the collect\n` +
    `  band, where any arrival error at all drops the ring. Greedy pays for its 100% by\n` +
    `  dying at a median of ${quantile(
      [...at('greedy / competent').map((r) => r.duration)].sort((a, b) => a - b),
      0.5,
    ).toFixed(0)}s.`,
)
console.log(
  `\n  What it pays, per gate flown rather than per run (runs are censored, gates are not):\n` +
    `  safe ${pointsPerGate(safe).toFixed(1)} points/gate vs collector ${pointsPerGate(collector).toFixed(1)}` +
    ` — ${(pointsPerGate(collector) / Math.max(0.001, pointsPerGate(safe))).toFixed(2)}x.\n` +
    `  What it costs is in the rate table, and at the competent operating point it is not\n` +
    `  distinguishable from zero. The one real cost in the reward layer is over-committing:\n` +
    `  compare greedy, which aims at the ring's centre instead of its nearest edge.`,
)

console.log('\nCourse geometry — no autopilot involved:')
console.log(centreLineMissAcrossTheRamp())

const course = SEEDS.slice(0, 50).flatMap((seed) => sampleCourse(seed, 240))
const free = course.filter((g) => g.freeCollect > 1e-9).length
console.log(
  `\n  Over ${course.length} spawned gates: the gap's own centre line collects the ring on\n` +
    `  ${pct(free, course.length)} of them (it was 65% under v1, and 100% past t=77s), and the\n` +
    `  average excursion a collector has to make outside the safe band is ` +
    `${mean(course.map((g) => g.excursion)).toFixed(1)}px\n  against ${mean(course.map((g) => g.clearanceOnCentre)).toFixed(1)}px of margin on the centre line.`,
)

const search = searchForFreeCollect()
console.log(
  `\n  Is it fixable by retuning, in either direction? Swept ${search.tested.toLocaleString()} (gap, ring\n` +
    `  radius, outset) combinations with the outset at or above the radius:\n` +
    `  ${search.free} admit a surviving altitude that also collects. The tightest case in the sweep\n` +
    `  leaves ${search.tightest.toFixed(0)}px — a touch at the E = THERMAL_RADIUS boundary, which is the invariant.`,
)

console.log('\nWhat a ring costs — the reference model of spec §2.2:')
console.log(formatCostTable())
console.log('')
console.log(formatWorstGateTable())
