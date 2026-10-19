/**
 * What does collecting a ring actually cost? The reference model of spec §2.2.
 *
 * This is the instrument behind the published cost table. It is not the
 * autopilot: the autopilot answers "what happens when someone plays", and a
 * controller of mine can flatter or libel the design. This answers the prior
 * question — what is the *best possible* play worth — from the geometry and the
 * physics alone, so the number is a floor on what a human pays rather than an
 * estimate of it.
 *
 * ## The model, exactly
 *
 * "Cheapest collecting line" means: the largest clearance a player could hold
 * at every gate of a collecting run, given that they collect every ring. It is a
 * continuous-control relaxation of the real simulation:
 *
 * - **Free hover.** The kite has no hover input, but chattering lift at 60 Hz
 *   approximates any acceleration in [-1400, +1500] to within 0.2 px, so the
 *   model gives the player one. Inward and outward accelerations differ by side,
 *   because the kite is not symmetric: coming back up is 1400 and coming back
 *   down is 1500. Both sides are evaluated and the worse one is reported, since
 *   a collector meets both over a run.
 * - **The speed clamp is exact** (560 px/s), as is the collect disc *including
 *   its horizontal window* — the model is free to take the ring early, while it
 *   is still ahead, which costs vertical depth and buys time.
 * - **The kite may arrive at the ring already moving back.** This is what makes
 *   the model generous; the stricter model that forbade it is where GOK-5's v1
 *   figure of 41% came from, and the comparison in the spec is like for like.
 * - **The dive has to fit in the field.** Arriving at the ring with inward speed
 *   means having turned around beyond it, and that turn has to happen above the
 *   fatal ground line (or below the ceiling, which is a clamp and simply stops
 *   the kite dead). The model takes the worst legal gap centre for each side, so
 *   the figure is one a collector can hold on every gate rather than on a lucky
 *   one.
 * - **Clearance is measured over the column traversal**, as the collision code
 *   measures it. Everything before that is the excursion being paid for.
 *
 * ## The one ambiguity, and why it is a flag rather than a choice
 *
 * The spec says the line must "stay inside the gap for the whole 70 px of column
 * traversal", which does not say whether traversal begins when the *kite's rim*
 * reaches the column or when its *centre* does. The two readings differ by one
 * kite radius of travel — 16 px, which at t = 0 is 89 ms and matters a great
 * deal. `rimEnters: true` is the strict reading and the default, because it is
 * the one the collision code actually enforces at the corner and the one that
 * reproduces the published table across the whole second ramp. See
 * `PUBLISHED_COST_TABLE` for where the two still disagree.
 */

import {
  CEILING_Y,
  GAP_Y_MAX_EDGE,
  GAP_Y_MIN,
  GATE_WIDTH,
  GRAVITY,
  GROUND_Y,
  KITE_RADIUS,
  NET_LIFT_ACCEL,
  THERMAL_LEAD,
  THERMAL_RADIUS,
  THERMAL_Y_MAX,
  THERMAL_Y_MIN,
  VY_CLAMP,
} from '../../src/game/constants.js'
import { gapHeight, scrollSpeed, thermalOutset } from '../../src/game/difficulty.js'

/** How close the kite's centre must come to the ring's to collect it. */
export const COLLECT_REACH = KITE_RADIUS + THERMAL_RADIUS

/** World px the ring leads the column's leading edge by: 64 - 35 = 29. */
const RING_LEAD_OF_EDGE = THERMAL_LEAD - GATE_WIDTH / 2

export interface CostModelOptions {
  /**
   * Does the gap constraint start when the kite's rim reaches the column, or
   * when its centre does? See the header. True is the strict reading.
   */
  readonly rimEnters?: boolean
  /** Integration step, seconds. */
  readonly dt?: number
  /** How many switch times to try for the bang-bang return. */
  readonly switchSamples?: number
}

export interface CostRow {
  readonly elapsed: number
  readonly gap: number
  /** Clearance a player who ignores the rings holds: h/2 - KITE_RADIUS. */
  readonly safeClearance: number
  /** Clearance the cheapest collecting line holds, on the worse of the two sides. */
  readonly collectingClearance: number
  /** What the ring costs, in px of clearance. */
  readonly cost: number
  /** That cost as a fraction of the safe margin. */
  readonly costFraction: number
}

/** Signed collision margin, mirroring collision.ts exactly. */
function columnMargin(gap: number, dx: number, offset: number): number {
  const toUpper = Math.hypot(dx, Math.max(0, offset + gap / 2))
  const toLower = Math.hypot(dx, Math.max(0, gap / 2 - offset))
  return Math.min(toUpper, toLower) - KITE_RADIUS
}

/** The legal band of gap centres at this difficulty, mirroring spawner.ts. */
export function centreBand(elapsed: number): readonly [number, number] {
  const h = gapHeight(elapsed)
  const outset = thermalOutset(elapsed)
  return [
    Math.max(GAP_Y_MIN + h / 2, THERMAL_Y_MIN + outset + h / 2),
    Math.min(GAP_Y_MAX_EDGE - h / 2, THERMAL_Y_MAX - outset - h / 2),
  ]
}

/**
 * Fly one return leg and report the clearance it holds through the traversal,
 * or null if the line clips a column anywhere.
 *
 * Offsets are measured from the gap centre, positive toward the ring. The
 * control is bang-bang with a single switch, which is the optimal shape here:
 * inward at full acceleration, then braking so as not to spear out of the far
 * side of the gap.
 */
function flyReturn(
  gap: number,
  speed: number,
  startOffset: number,
  startVelocity: number,
  secondsToColumn: number,
  inward: number,
  outward: number,
  switchAt: number,
  options: Required<CostModelOptions>,
): number | null {
  const safeHalfWidth = gap / 2 - KITE_RADIUS
  const total = secondsToColumn + GATE_WIDTH / speed
  let offset = startOffset
  let velocity = startVelocity
  let held = Infinity

  for (let s = 0; s < total; s += options.dt) {
    let dx = s < secondsToColumn ? speed * (secondsToColumn - s) : 0
    // The strict reading: the gap constraint bites from the moment the kite's
    // rim overlaps the column's x-span, not from when its centre does.
    if (options.rimEnters && dx < KITE_RADIUS) dx = 0

    if (columnMargin(gap, dx, offset) <= 0) return null
    if (dx === 0) held = Math.min(held, safeHalfWidth - Math.abs(offset))

    const a = s < switchAt ? -inward : outward
    velocity = Math.min(Math.max(velocity + a * options.dt, -VY_CLAMP), VY_CLAMP)
    offset += velocity * options.dt
    // Settle rather than bounce straight back out of the far side.
    if (velocity > 0 && offset <= 0) velocity = 0
  }
  return held
}

/** The best clearance a collector can hold at this difficulty, on one side. */
function bestOnSide(
  elapsed: number,
  ringBelow: boolean,
  options: Required<CostModelOptions>,
): number {
  const gap = gapHeight(elapsed)
  const speed = scrollSpeed(elapsed)
  const ringOffset = gap / 2 + thermalOutset(elapsed)
  // Coming back toward the centre is a climb when the ring is below and a fall
  // when it is above; the dive out is braked by the other one.
  const inward = ringBelow ? NET_LIFT_ACCEL : GRAVITY
  const outward = ringBelow ? GRAVITY : NET_LIFT_ACCEL
  // The worst legal gate for this side: the one that puts the ring closest to
  // the field edge the dive runs toward.
  const [low, high] = centreBand(elapsed)
  const centre = ringBelow ? high : low

  let best = -Infinity
  for (let dx = 0; dx <= COLLECT_REACH; dx += 1) {
    // Taking the ring `dx` px early costs depth and buys time.
    const slack = Math.sqrt(Math.max(0, COLLECT_REACH * COLLECT_REACH - dx * dx))
    const startOffset = ringOffset - slack
    const secondsToColumn = (dx + RING_LEAD_OF_EDGE) / speed

    // Arriving already moving back means having turned around beyond here, and
    // that turn has to fit between this point and the ground (or the ceiling,
    // which clamps the kite rather than killing it — either way it is the limit
    // on how much inward speed the dive can carry out of the turn).
    const absolute = ringBelow ? centre + startOffset : centre - startOffset
    const room = ringBelow ? GROUND_Y - KITE_RADIUS - absolute : absolute - CEILING_Y
    if (room < 0) continue
    // Maximum inward speed dominates: any excess can be braked off later, and
    // being further in is never worse, so there is nothing to sweep here.
    const startVelocity = -Math.min(VY_CLAMP, Math.sqrt(2 * outward * room))

    const total = secondsToColumn + GATE_WIDTH / speed
    for (let k = 0; k <= options.switchSamples; k += 1) {
      const held = flyReturn(
        gap,
        speed,
        startOffset,
        startVelocity,
        secondsToColumn,
        inward,
        outward,
        (k / options.switchSamples) * total,
        options,
      )
      if (held !== null && held > best) best = held
    }
  }
  return best
}

/**
 * Grid resolution. Measured against a 1/4000 s, 400-sample reference: these
 * settings land every row within 0.5 px of it for a quarter of the work, which
 * matters because this table is computed in CI under coverage instrumentation.
 * `the model itself` in tests/cost.test.ts is what holds that claim.
 */
const DEFAULTS: Required<CostModelOptions> = { rimEnters: true, dt: 1 / 500, switchSamples: 60 }

/** What a ring costs at this difficulty, under the reference model. */
export function collectingCost(elapsed: number, options: CostModelOptions = {}): CostRow {
  const settings = { ...DEFAULTS, ...options }
  const gap = gapHeight(elapsed)
  const safeClearance = gap / 2 - KITE_RADIUS
  // A collector meets both sides over a run, so the holdable figure is the
  // worse of the two.
  const collectingClearance = Math.min(
    bestOnSide(elapsed, true, settings),
    bestOnSide(elapsed, false, settings),
  )
  const cost = safeClearance - collectingClearance
  return {
    elapsed,
    gap,
    safeClearance,
    collectingClearance,
    cost,
    costFraction: cost / safeClearance,
  }
}

/** The checkpoints the spec publishes. */
export const COST_CHECKPOINTS = [0, 30, 60, 90, 150, 210, 270] as const

export function costTable(options: CostModelOptions = {}): CostRow[] {
  return COST_CHECKPOINTS.map((t) => collectingCost(t, options))
}

/**
 * The collecting-line clearances published in spec §2.2, for comparison.
 *
 * **These are not all reproducible, and the discrepancy is reported on GOK-17
 * rather than tuned away.** Under the strict traversal reading this model
 * reproduces every row of the second ramp — t = 90, 150, 210 and 270 — to within
 * 2 px. The three phase-1 rows come out 8 to 16 px *tighter* than published,
 * i.e. the model says the early detour costs more than the table claims.
 *
 * The published 79 px at t = 0 is not merely unmatched, it is unreachable: with
 * the ring 206 px from the gap centre, the shallowest collecting altitude 168 px
 * out, and 13 px of world travel before the rim constraint bites, the speed
 * clamp alone caps the holdable clearance at 72.6 px however the control is
 * chosen. Under the loose reading the same three rows come out 9 to 15 px
 * *looser* than published instead. So no single reading of the model's own prose
 * produces the published phase-1 numbers, which is why this is a question for
 * the CTO and not a constant for this task to move.
 *
 * Phase 1 is also the regime where `E(t)` is above its floor, which is the only
 * structural difference between the two halves of the table.
 */
export const PUBLISHED_COST_TABLE: Readonly<Record<number, number>> = {
  0: 79,
  30: 64,
  60: 50,
  90: 34,
  150: 25,
  210: 21,
  270: 19,
}

/** Human-readable table, for `pnpm feel`. */
export function formatCostTable(options: CostModelOptions = {}): string {
  const rows = costTable(options).map((row) => {
    const published = PUBLISHED_COST_TABLE[row.elapsed] as number
    const delta = row.collectingClearance - published
    return [
      `  t=${`${row.elapsed}s`.padStart(5)}`,
      `gap ${row.gap.toFixed(0).padStart(3)}px`,
      `safe ${row.safeClearance.toFixed(0).padStart(3)}px`,
      `collecting ${row.collectingClearance.toFixed(1).padStart(5)}px`,
      `cost ${row.cost.toFixed(1).padStart(5)}px`,
      `(${(100 * row.costFraction).toFixed(0).padStart(3)}% of margin)`,
      `spec ${String(published).padStart(3)}px`,
      `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}`,
    ].join('  ')
  })
  return [
    '  The cost of a ring, from the reference model of spec §2.2.',
    '',
    ...rows,
    '',
    '  The last column is this model minus the published table. The second ramp',
    '  reproduces; the three phase-1 rows do not, under either reading of the',
    '  traversal window. Reported on GOK-17 — not tuned away.',
  ].join('\n')
}
