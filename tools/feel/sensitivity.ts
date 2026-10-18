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
 * ## The axis is integer, and that is the point
 *
 * This sweep used to run along `anticipation`, a fraction of the input queue the
 * player predicts, at 1.0 / 0.8 / 0.6 / 0.4 / 0.2 / 0. The GOK-14 review showed
 * that was an instrument measuring itself: the controller multiplies that
 * fraction by the queue length and rounds, so at 83 ms (5 frames in flight) the
 * fractions collapsed onto six reachable controllers, `0.7` and `0.8` were
 * byte-identical, and every "cliff" between adjacent rows was indistinguishable
 * from the resolution of the axis itself. It also silently coupled the two
 * columns: at 50 ms, 0.5 through 0.8 are one controller; at 116 ms they are
 * three.
 *
 * So the axis is now `unanticipatedFrames` — how many of the in-flight frames go
 * unpredicted — swept as the integer the controller actually responds to. Every
 * row is a distinct controller, adjacent rows differ by exactly one frame of
 * prediction, and a row means the same thing at every latency. It also makes the
 * resolution honest: at 83 ms there are six controllers and no more, so a
 * difficulty claim finer than one frame is not something this instrument can
 * make.
 *
 * `perception` is the gentler axis, not the dominant one — the file used to
 * claim otherwise. White noise in the player's read of its own altitude is
 * largely filtered by the kite's inertia before it reaches a bang-bang decision,
 * so at full prediction even +-32px leaves survival at 100%. Both columns are
 * kept because together they separate "sloppy hands" from "slow hands", but the
 * frames column is the one that bites.
 *
 * Latency is swept too, at fixed unanticipated frames, to show the decoupling:
 * what costs a player is the part of their lag they fail to predict, not the lag.
 */

import { latencyFrames, playRun, type Strategy } from './autopilot.js'

const SEEDS = Array.from({ length: 80 }, (_, i) => 1000 + i * 7)
/** Whole input-to-pixel chain for a typical mid-range phone, not reaction time. */
const LATENCY = 0.083
/** 0 = perfect prediction, latencyFrames(LATENCY) = none at all. Nothing in between exists. */
const UNANTICIPATED = Array.from({ length: latencyFrames(LATENCY) + 1 }, (_, i) => i)
const PERCEPTIONS = [0, 8, 16, 24, 32]
/** 0, 50, 83, 116, 150 ms — the spread of real phones. */
const LATENCIES = [0, 0.05, 0.083, 0.116, 0.15]

interface Cell {
  readonly median: string
  readonly p10: string
  readonly p90: string
  readonly past: string
  readonly deathsPer100Gates: string
}

function measure(
  strategy: Strategy,
  latency: number,
  unanticipatedFrames: number,
  perception: number,
): Cell {
  const results = SEEDS.map((seed) =>
    playRun(
      seed,
      {
        strategy,
        latency,
        deadZone: 8,
        unanticipatedFrames,
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
  const gates = results.reduce((a, r) => a + r.gatesPassed, 0)
  const deaths = results.filter((r) => r.crashCause !== null).length
  return {
    median: q(0.5),
    p10: q(0.1),
    p90: q(0.9),
    past: `${((100 * past) / results.length).toFixed(0)}%`.padStart(4),
    // Uncensored, so the rows that all reach the cutoff still say something.
    deathsPer100Gates: (gates === 0 ? 0 : (100 * deaths) / gates).toFixed(2).padStart(5),
  }
}

function line(prefix: string, cell: Cell): string {
  return [
    prefix,
    `median ${cell.median}s`,
    `p10 ${cell.p10}s`,
    `p90 ${cell.p90}s`,
    `>=120s ${cell.past}`,
    `deaths/100 gates ${cell.deathsPer100Gates}`,
  ].join('  ')
}

console.log(
  `Survival vs player imprecision — ${SEEDS.length} seeds, dead zone 8px, aim jitter +-10px ` +
    `(uniform half-width)\n`,
)

console.log(
  `At ${(LATENCY * 1000).toFixed(0)} ms latency, ${latencyFrames(LATENCY)} frames are in flight, ` +
    `so there are exactly ${UNANTICIPATED.length} controllers:\n`,
)
for (const strategy of ['safe', 'collector'] as const) {
  console.log(`${strategy}:`)
  for (const frames of UNANTICIPATED) {
    for (const perception of PERCEPTIONS) {
      const prefix = `unpredicted ${frames}/${latencyFrames(LATENCY)} frames  sight +-${String(perception).padStart(2)}px`
      console.log(`  ${line(prefix, measure(strategy, LATENCY, frames, perception))}`)
    }
  }
  console.log('')
}

console.log(
  'Latency at a fixed prediction gap — the two are independent once the axis is honest:\n',
)
for (const frames of [0, 1, 2]) {
  for (const latency of LATENCIES) {
    if (frames > latencyFrames(latency)) continue
    const prefix = `lag ${`${(latency * 1000).toFixed(0)}ms`.padStart(5)} (${latencyFrames(latency)} frames)  unpredicted ${frames}`
    console.log(`  ${line(prefix, measure('collector', latency, frames, 16))}`)
  }
  console.log('')
}
