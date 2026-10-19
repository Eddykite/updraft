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
 * ## The ambiguity that was, and the ruling that closed it
 *
 * v2's prose said the line must "stay inside the gap for the whole 70 px of
 * column traversal", which did not say whether traversal begins when the
 * *kite's rim* reaches the column or when its *centre* does. The two readings
 * differ by one kite radius of travel — 16 px, which at t = 0 is 89 ms and
 * matters a great deal — and v2's published numbers sat *between* them, so
 * neither reading produced them. That is how the phase-1 error survived review.
 *
 * **v2.1 rules it rim, not centre** (GOK-22): it is what collision.ts enforces
 * at the corner, and the only reading under which the second ramp reproduces.
 * So `rimEnters: true` is no longer a defensible default among two, it is the
 * model. The loose reading stays reachable as an option purely so that
 * tests/cost.test.ts can keep asserting the table is *not* it.
 *
 * ## Two gates, not one
 *
 * `collectingCost(t)` prices a typical gate — spec §2.2's table. `worstGate`
 * prices the hardest legal one — §2.3's. They are the same number until the
 * inter-gate interval gets short enough for the approach to cost something,
 * which is to say until phase 2.
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
import { gapHeight, scrollSpeed, spawnInterval, thermalOutset } from '../../src/game/difficulty.js'
import { maxCentreDelta, thermalTowardDelta } from '../../src/game/spawner.js'

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
  /**
   * Worst-gate mode (spec §2.3): price the ring on the hardest legal gate at
   * this difficulty rather than on a gate whose approach is free.
   *
   * The balanced model above asks only "can the kite hold the gap once it has
   * taken the ring", and grants it any inward arrival speed the field has room
   * for. That silently assumes the approach was free. On the worst legal gate
   * it is not: the gap centre has moved `min(capAway, 30·(1 - q))` px *toward*
   * the ring since the previous gate, so the kite comes out of the previous gap
   * that much further from the ring and has one inter-gate leg to cover the
   * difference, dive out, and turn back.
   *
   * See `approachArrivalVelocity` for the leg and for the one assumption in it.
   */
  readonly worstGate?: boolean
  /**
   * Override the centre move used by `worstGate`. Only for decomposing the
   * worst-gate figure into "the approach is priced at all" and "the gate is the
   * hardest legal one"; the published row leaves this alone.
   */
  readonly towardDelta?: number | null
  /**
   * Outward velocity the kite is allowed to carry out of the previous gap, in
   * px/s. Zero is the default and the §2.3-consistent choice — see
   * `approachArrivalVelocity`. Nonzero is for the sensitivity sweep that says
   * how much the published worst-gate row depends on that assumption.
   */
  readonly approachExitVelocity?: number
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

/**
 * How far the gap centre may move *toward* the ring in one gate, at this
 * difficulty — the worst legal gate of spec §2.3. Mirrors spawner.ts.
 */
export function worstGateTowardDelta(elapsed: number): number {
  return Math.min(maxCentreDelta(spawnInterval(elapsed)), thermalTowardDelta(elapsed))
}

/**
 * The most inward-moving velocity the kite can have as it reaches the collect
 * point, given that it had to come from the previous gap.
 *
 * Offsets are this gate's, positive toward the ring. The previous gap's centre
 * sat `towardDelta` px on the far side of this one, so the most favourable
 * legal place to leave it is hugging its near edge, at
 * `-towardDelta + (gap/2 - KITE_RADIUS)`.
 *
 * **The one assumption: the kite leaves that edge settled, at vy = 0.** That is
 * not a convenience — it is the same assumption §2.3's own fairness bound is
 * built on. `maxCentreDelta = 0.5·reach(T)` is defined as the distance the kite
 * can cover *and settle within* T, i.e. at rest at both ends, so pricing the
 * approach from rest is pricing it against the same model that declared the
 * gate legal in the first place.
 *
 * Maximising inward speed at a fixed point and a fixed time is a bang-bang
 * problem with a single switch — out at full acceleration, then back — and the
 * arrival constraint pins the switch, so there is nothing to sweep: the final
 * offset is monotone in the switch time and a bisection finds it.
 *
 * @returns the signed arrival velocity (negative is inward), or null if the
 *          collect point cannot be reached from the previous gap at all.
 */
function approachArrivalVelocity(
  gap: number,
  startOffset: number,
  towardDelta: number,
  secondsAvailable: number,
  inward: number,
  outward: number,
  maxOutward: number,
  dt: number,
  exitVelocity: number,
): number | null {
  if (secondsAvailable <= 0) return null
  const from = -towardDelta + (gap / 2 - KITE_RADIUS)

  const fly = (switchAt: number): readonly [number, number] => {
    let offset = from
    let velocity = exitVelocity
    for (let s = 0; s < secondsAvailable; s += dt) {
      const a = s < switchAt ? outward : -inward
      velocity = Math.min(Math.max(velocity + a * dt, -VY_CLAMP), VY_CLAMP)
      offset += velocity * dt
      // The dive still has to fit in the field.
      if (offset > maxOutward) {
        offset = maxOutward
        if (velocity > 0) velocity = 0
      }
    }
    return [offset, velocity]
  }

  // From rest the final offset is monotone in the switch time, so one bisection
  // would do. It is *not* monotone once the kite is allowed to leave the
  // previous gap already moving — a long coast can clear `startOffset` and come
  // back inside it — and that case is exactly the sensitivity sweep. So bracket
  // every sign change rather than assuming there is one.
  const samples = 96
  let best: number | null = null
  let previous = fly(0)
  for (let i = 1; i <= samples; i += 1) {
    const at = (i / samples) * secondsAvailable
    const current = fly(at)
    const crosses =
      (previous[0] - startOffset) * (current[0] - startOffset) <= 0 &&
      !(previous[0] === current[0] && previous[0] !== startOffset)
    if (crosses) {
      let lo = ((i - 1) / samples) * secondsAvailable
      let hi = at
      const rising = current[0] >= previous[0]
      let arrival = current[1]
      for (let k = 0; k < 40; k += 1) {
        const mid = (lo + hi) / 2
        const [offset, velocity] = fly(mid)
        arrival = velocity
        if (offset < startOffset === rising) lo = mid
        else hi = mid
      }
      if (best === null || arrival < best) best = arrival
    }
    previous = current
  }
  // Never reaches the collect point on any switch time: unreachable from the
  // previous gap on this line.
  return best
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
    let startVelocity = -Math.min(VY_CLAMP, Math.sqrt(2 * outward * room))

    if (options.worstGate) {
      // On the worst legal gate the approach is not free: the kite has one
      // inter-gate leg to get from the previous gap out to here, and whatever
      // inward speed that leg can deliver is the ceiling on the arrival. The
      // leg runs from the previous gate's trailing edge to the collect point.
      const spacing = speed * spawnInterval(elapsed)
      const secondsAvailable = (spacing - GATE_WIDTH - RING_LEAD_OF_EDGE - dx) / speed
      const arrival = approachArrivalVelocity(
        gap,
        startOffset,
        options.towardDelta ?? worstGateTowardDelta(elapsed),
        secondsAvailable,
        inward,
        outward,
        startOffset + room,
        options.dt,
        options.approachExitVelocity,
      )
      // Unreachable from the previous gap on this line — try taking the ring
      // at a different point in its collect window.
      if (arrival === null) continue
      // Less negative is less inward: the approach can only ever cost speed.
      startVelocity = Math.max(startVelocity, arrival)
    }

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
const DEFAULTS: Required<CostModelOptions> = {
  rimEnters: true,
  dt: 1 / 500,
  switchSamples: 60,
  worstGate: false,
  towardDelta: null,
  approachExitVelocity: 0,
}

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
 * The collecting-line clearances published in spec §2.2.
 *
 * **The whole table now reproduces** (v2.1). The second ramp always did, to the
 * spec's own ±2 px. The three phase-1 rows did not — they were published as
 * 79 / 64 / 50 px and this model gives 63.6 / 48.6 / 41.5 — and the ruling on
 * GOK-22 was that the model is the contract and the hand-derived row was wrong:
 * v2's phase-1 clearances were very nearly linear in t (≈ 79 - 0.5t), the
 * signature of an interpolation between endpoints, and the t = 0 figure was not
 * merely unmatched but *unreachable*, since the speed clamp alone caps the
 * holdable clearance there at 72.6 px however the control is chosen.
 *
 * Traversal is ruled **rim, not centre** — what collision.ts enforces, and the
 * only reading under which the second ramp reproduces at all. That ambiguity is
 * what produced the original error, so `the loose reading is not this table` is
 * kept as a test rather than as a note here.
 *
 * Phase 1 is the regime where `E(t)` is above its floor, which is the one
 * structural difference between the two halves of the table and the reason the
 * hand derivation had to treat it specially.
 */
export const PUBLISHED_COST_TABLE: Readonly<Record<number, number>> = {
  0: 63.6,
  30: 48.6,
  60: 41.5,
  90: 34,
  150: 25,
  210: 21,
  270: 19,
}

/**
 * The clearance a collector can hold on the **worst legal gate** at each
 * difficulty — spec §2.3, re-derived here after v2.1 struck the three phase-1
 * cells as impossible (72 px on the worst gate at t = 0 exceeded the 63.6 px
 * this model gives on the best one).
 *
 * These are this model's output at `worstGate: true`, i.e. the published row is
 * the instrument's, exactly as §2.2's now is.
 *
 * **Phase 1 re-derives to the best-gate figure**, because the approach there is
 * genuinely free: at t = 0 the gates are 288 px apart at 180 px/s, so the kite
 * has 0.84 s to absorb a 30 px course move that costs it nothing. The worst gate
 * and the best gate are the same gate until the interval starts to bite.
 *
 * **Phase 2 is 6-7 px tighter than v2.1's standing cells** (21.3 / 16.0 / 14.1 /
 * 13.4 against 28 / 22 / 19 / 19). Those cells were checked for consistency only
 * against `worst <= best`, which they pass; they were never re-derived. Reported
 * on GOK-17 rather than edited into the spec here — see `requiredFloor`, which
 * is the part that is an acceptance criterion.
 */
export const WORST_GATE_TABLE: Readonly<Record<number, number>> = {
  0: 63.6,
  30: 48.6,
  60: 41.5,
  90: 21.3,
  150: 16.0,
  210: 14.1,
  270: 13.4,
}

/**
 * The clearance the worst legal gate must leave for the ring to count as
 * reachable: `max(12, 25% of the safe margin)` (spec §2.3).
 *
 * **This is an acceptance criterion, not a prediction.** A cell landing under
 * its floor is a reachability failure and goes back to the CTO rather than
 * being absorbed into a constant here.
 */
export function requiredFloor(elapsed: number): number {
  return Math.max(12, 0.25 * (gapHeight(elapsed) / 2 - KITE_RADIUS))
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
    '  The cost of a ring on a typical gate, from the reference model of spec §2.2.',
    '',
    ...rows,
    '',
    '  The last column is this model minus the published table. Since v2.1 the',
    '  published table *is* this model, so every row reproduces; the phase-1 rows',
    '  were corrected on GOK-22 rather than the model being bent to match them.',
  ].join('\n')
}

/**
 * The worst-legal-gate table of spec §2.3, against the floor it has to clear.
 *
 * The `floor` column is the acceptance criterion: a `FAIL` here is a
 * reachability failure — a ring that cannot be taken without dying, which is as
 * broken as one that is free — and it goes back to the CTO.
 */
export function formatWorstGateTable(options: CostModelOptions = {}): string {
  const rows = COST_CHECKPOINTS.map((elapsed) => {
    const best = collectingCost(elapsed, options)
    const worst = collectingCost(elapsed, { ...options, worstGate: true })
    const floor = requiredFloor(elapsed)
    return [
      `  t=${`${elapsed}s`.padStart(5)}`,
      `toward ${worstGateTowardDelta(elapsed).toFixed(1).padStart(5)}px`,
      `best gate ${best.collectingClearance.toFixed(1).padStart(5)}px`,
      `worst gate ${worst.collectingClearance.toFixed(1).padStart(5)}px`,
      `floor ${floor.toFixed(1).padStart(5)}px`,
      worst.collectingClearance >= floor ? 'ok  ' : 'FAIL',
      `spec ${String(WORST_GATE_TABLE[elapsed] ?? '?').padStart(5)}px`,
    ].join('  ')
  })
  return [
    '  And on the worst legal gate — the largest move toward the ring (spec §2.3).',
    '',
    ...rows,
    '',
    '  `floor` is max(12, 25% of the safe margin) and is an acceptance criterion,',
    '  not a prediction. Phase 1 re-derives to the best-gate figure: the approach',
    '  is free while the gates are 1.6 s apart. Phase 2 comes out 6-7 px under the',
    '  cells v2.1 left standing, which were never re-derived — reported on GOK-17.',
  ].join('\n')
}
