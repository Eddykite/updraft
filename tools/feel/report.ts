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
 *   - **Durations here are censored.** The ramp freezes at 90s, so a player who
 *     is alive then is alive forever and MAX_SECONDS is the only thing making
 *     their run finite. At the competent operating point every single run is
 *     censored, which makes any difference of means exactly zero by
 *     construction. Anything comparing two strategies is therefore reported as a
 *     rate per unit of exposure — deaths per 100 gates — which censoring does not
 *     touch, with durations kept only as a description of the profile.
 *   - **A knob that is a step function gets reported as a step**, not sampled at
 *     one point and quoted as if it were a measurement. See the opportunist.
 *
 * See tools/feel/sensitivity.ts for the sweep that establishes the model player
 * is measuring UPDRAFT rather than its own stability.
 */

import {
  latencyFrames,
  playRun,
  safetyMargin,
  type PlayerProfile,
  type RunResult,
} from './autopilot.js'
import {
  costAcrossTheRamp,
  roundTrip,
  DIP_DEPTHS,
  sampleCourse,
  searchForFreeCollect,
} from './geometry.js'
import { DIFFICULTY_RAMP_SECONDS } from '../../src/game/constants.js'

const SEEDS = Array.from({ length: 200 }, (_, i) => 1000 + i * 7)
/** Runs are cut off here; the difficulty ramp has been frozen for 2.5x this long by then. */
const MAX_SECONDS = 240
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

/** Tolerances for the opportunist, in px of spare reach demanded at both ends. */
const NERVES = [0, 20, 40] as const

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
  // The two ways to get the dip wrong, kept as profiles so "the depth matters" is
  // measured rather than asserted — both bracket the collector's line.
  ['skimmer / competent', { ...COMPETENT, strategy: 'skimmer' }],
  ['greedy / competent', { ...COMPETENT, strategy: 'greedy' }],
  ['greedy / rusty', { ...RUSTY, strategy: 'greedy' }],
  ...NERVES.map(
    (nerve) =>
      [
        `opportunist +${nerve}px`,
        { ...COMPETENT, strategy: 'opportunist', riskTolerance: nerve },
      ] as const,
  ),
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

console.log(
  `UPDRAFT feel report — ${SEEDS.length} seeds, cutoff ${MAX_SECONDS}s, ` +
    `${(LATENCY * 1000).toFixed(0)} ms latency (${latencyFrames(LATENCY)} frames in flight)\n`,
)

const byLabel = new Map<string, readonly RunResult[]>()
for (const [label, profile] of PROFILES) {
  const results = SEEDS.map((seed) => playRun(seed, profile, MAX_SECONDS))
  byLabel.set(label, results)
  summarise(label, results)
}

const at = (label: string): readonly RunResult[] => byLabel.get(label) ?? []

console.log('\nDurations above are censored at the cutoff — compare profiles on this instead:\n')
rateTable(
  PROFILES.map(([label]) => label),
  at,
)

console.log('\nWhere runs end (collector / competent):')
deathHistogram(at('collector / competent'))

console.log('\nRisk/reward — is a thermal a decision or a formality?')
const declineRate = (label: string): string => {
  const results = at(label)
  const offered = sum(results.map((r) => r.ringsOffered))
  return pct(sum(results.map((r) => r.ringsDeclined)), offered)
}
console.log(
  `  A player who demands spare reach before committing now declines some rings and\n` +
    `  takes others on the same run — the climb out of the dip is fixed by the ramp, but\n` +
    `  the approach depends on where the previous gap left them:\n` +
    NERVES.map(
      (n) =>
        `    +${String(n).padStart(2)}px of nerve: declines ${declineRate(`opportunist +${n}px`)} of the rings it is offered`,
    ).join('\n') +
    `\n  Under the old placement every one of those rows would have read 0% or 100%: the\n` +
    `  quantity being tested was a constant, so the profile was a step function of its own\n` +
    `  definition and quoting a number from inside one band was quoting an identity.`,
)

const safe = at('safe / competent')
const collector = at('collector / competent')
const pointsPerGate = (results: readonly RunResult[]): number =>
  sum(results.map((r) => r.score)) / Math.max(1, sum(results.map((r) => r.gatesPassed)))
const ringRate = (results: readonly RunResult[]): number => {
  const gates = sum(results.map((r) => r.gatesPassed))
  return gates === 0 ? 0 : (100 * sum(results.map((r) => r.thermalsTakenOnPassedGates))) / gates
}
const medianOf = (label: string): number =>
  quantile(
    [...at(label).map((r) => r.duration)].sort((a, b) => a - b),
    0.5,
  )
console.log(
  `\n  Does the dip depth matter? Three fixed lines, from the ring's centre out to the\n` +
    `  edge of the collect band:\n` +
    `    skimmer (touches from the edge of the band) takes ${ringRate(at('skimmer / competent')).toFixed(0)}% of rings, median ${medianOf('skimmer / competent').toFixed(0)}s\n` +
    `    collector (best depth)                        takes ${ringRate(collector).toFixed(0)}% of rings, median ${medianOf('collector / competent').toFixed(0)}s\n` +
    `    greedy (commits to the ring's centre)         takes ${ringRate(at('greedy / competent')).toFixed(0)}% of rings, median ${medianOf('greedy / competent').toFixed(0)}s\n` +
    `  and the safe line, which never leaves the gap, takes ${ringRate(safe).toFixed(0)}%.\n` +
    `  Only the shallow end is punished, and it is punished twice: the skimmer touches the\n` +
    `  ring only at the instant it is level with the kite, so it drops two rings in five, and\n` +
    `  it still dies more often because that late contact leaves it the least room to climb\n` +
    `  out. Between the ring's centre and half way there is nothing to choose — which is\n` +
    `  worth saying plainly, because the opposite was the tidier story.`,
)
console.log(
  `\n  What it pays, per gate flown rather than per run (runs are censored, gates are not):\n` +
    `  safe ${pointsPerGate(safe).toFixed(1)} points/gate vs collector ${pointsPerGate(collector).toFixed(1)}` +
    ` — ${(pointsPerGate(collector) / Math.max(0.001, pointsPerGate(safe))).toFixed(2)}x.\n` +
    `  The multiplier is why the ratio is not 1.5x: the streak runs on consecutive rings, so\n` +
    `  a player who never leaves the safe line is stuck at 1x for an entire run.\n` +
    `\n  And yet the safe line still wins on total score, which is the finding that matters:\n` +
    `  safe ${(sum(safe.map((r) => r.score)) / safe.length).toFixed(0)} points per run against collector ${(sum(collector.map((r) => r.score)) / collector.length).toFixed(0)}. Per *second* the collector is far\n` +
    `  ahead (${(sum(collector.map((r) => r.score)) / sum(collector.map((r) => r.duration))).toFixed(1)} vs ${(sum(safe.map((r) => r.score)) / sum(safe.map((r) => r.duration))).toFixed(1)} points/s), and it loses only because a safe run has no end:\n` +
    `  the ramp freezes at ${DIFFICULTY_RAMP_SECONDS}s and the frozen course is flyable forever, so the safe line's\n` +
    `  score is bounded by the player's patience and nothing else. No risk/reward layer can\n` +
    `  be rational against an unbounded run — that is arithmetic, not tuning, and it is the\n` +
    `  difficulty-ceiling question on GOK-5, not the thermals one.`,
)

console.log('\nCourse geometry — no autopilot involved:')
console.log(costAcrossTheRamp())

const course = SEEDS.slice(0, 50).flatMap((seed) => sampleCourse(seed, 180))
const free = course.filter((g) => g.freeCollect > 0).length
console.log(
  `\n  Over ${course.length} spawned gates: the number on which some already-safe altitude collects\n` +
    `  the ring is ${free}, and the average excursion past the safe band is ` +
    `${mean(course.map((g) => g.excursion)).toFixed(1)}px\n  against ${mean(course.map((g) => g.clearanceOnCentre)).toFixed(1)}px of clearance on the centre line.`,
)

console.log(
  `\n  The three lines, at maximum difficulty — the budget is the open air between two\n` +
    `  gates, ${roundTrip(DIFFICULTY_RAMP_SECONDS, DIP_DEPTHS.collector).spacing.toFixed(0)}px of it, and THERMAL_LEAD_X decides how it splits:\n` +
    (['greedy', 'collector', 'skimmer'] as const)
      .map((k) => {
        const t = roundTrip(DIFFICULTY_RAMP_SECONDS, DIP_DEPTHS[k])
        return (
          `    ${k.padEnd(9)} dip ${DIP_DEPTHS[k].toFixed(0).padStart(2)}px short of the ring: ` +
          `${t.travel.toFixed(0)}px each way, slack ${t.slack.toFixed(0).padStart(4)}px, ` +
          `contact window ${t.contactWindow.toFixed(0)}px of scroll`
        )
      })
      .join('\n') +
    `\n  Conservative — it throws away the speed the kite carries through the dip — so read it\n` +
    `  as the shape of the trade, not as the exact width of the window.`,
)

console.log(
  `\n  How much of the above is the model player's own caution? The lean toward the next\n` +
    `  ring stops this far short of the column, and it is most of the approach:\n` +
    [4, 12, safetyMargin({ ...COMPETENT, strategy: 'collector' }), 30, 45]
      .map((margin) => {
        const runs = SEEDS.map((seed) =>
          playRun(seed, { ...COMPETENT, strategy: 'collector', leanMargin: margin }, MAX_SECONDS),
        )
        const gates = sum(runs.map((r) => r.gatesPassed))
        const deaths = runs.filter((r) => r.crashCause !== null).length
        const taken = sum(runs.map((r) => r.thermalsTakenOnPassedGates))
        return (
          `    lean margin ${margin.toFixed(0).padStart(2)}px: ` +
          `deaths per 100 gates ${((100 * deaths) / Math.max(1, gates)).toFixed(2).padStart(6)}, ` +
          `rings ${pct(taken, gates).padStart(4)} of gates`
        )
      })
      .join('\n') +
    `\n  The derived margin is the middle row. The trend is the honest reading: the cost of a\n` +
    `  ring is partly the player's own caution, and a bolder line buys rings at a price.`,
)

const search = searchForFreeCollect()
console.log(
  `\n  Is the mechanic an accident of today's constants? Swept ${search.tested.toLocaleString()} (gap, ring radius,\n` +
    `  offset) combinations across both sides of the threshold:\n` +
    `    ring inside the gap  (offset <= radius): ${search.riskyInside} of them deny a safe collecting altitude\n` +
    `    ring outside the gap (offset >  radius): ${search.freeOutside} of them allow one\n` +
    `  So the layer turns on one inequality, THERMAL_OUTSIDE_OFFSET > THERMAL_RADIUS, and on\n` +
    `  nothing else — not on the gap height, not on where we are on the ramp.`,
)
