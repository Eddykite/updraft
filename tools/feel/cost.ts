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
 * ## Two assumptions about the exit, not one, and they pull opposite ways
 *
 * The leg has to start somewhere, which means choosing both a **position** and
 * a **velocity** for the kite as it leaves the previous gap. Earlier versions
 * of this comment argued only the velocity, which is the half that makes the
 * gate look *harder*; the Engineering Lead caught that on GOK-25 and the
 * omission was load-bearing. Both are stated here now.
 *
 * **Velocity: vy = 0, the conservative half.** That is not a convenience — it
 * is the same assumption §2.3's own fairness bound is built on.
 * `maxCentreDelta = 0.5·reach(T)` is defined as the distance the kite can cover
 * *and settle within* T, i.e. at rest at both ends, so pricing the approach
 * from rest is pricing it against the same model that declared the gate legal.
 * A real collector can leave already moving outward, and every px/s of that
 * moves the published figure **up** — see `approachExitVelocity`.
 *
 * **Position: the previous gap's near edge, the generous half.** Hugging that
 * edge is zero clearance at the previous gate, so the figure below is the
 * clearance holdable *here* given none *there* — which the header's "at every
 * gate of a collecting run" does not license. `maxCentreDelta` is a statement
 * about what the spawner may do; it does not entitle the collector to clip the
 * previous gap's edge for free. The self-consistent figure — the largest C
 * holdable at every gate, i.e. exiting the previous gap C px inside its edge —
 * is `selfConsistentWorstGate` below, and it is **lower**.
 *
 * Neither half is a bound, so the published row is a point inside a band whose
 * width is set by the two of them. `selfConsistentWorstGate` prices them
 * together, which is the only combination that describes one actual collector.
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
 * Grid resolution.
 *
 * ## The whole error lives in `dt`, and it is one-sided
 *
 * The old default of `dt = 1/500` claimed "every row within 0.5 px" on the
 * strength of a convergence check that refined *both* knobs at once and ran
 * balanced mode only (GOK-25, finding 2). Refined one at a time, at t = 90 s in
 * worst-gate mode:
 *
 * - `switchSamples` 60 → 1600 at `dt = 1/4000`: **0.014 px**, and 60 / 120 / 240
 *   are identical to three decimals. The switch time is inert above ~60.
 * - `dt` 1/500 → 1/32000 at 60 samples: **0.78 px**, monotonically downward.
 *
 * The reason it is `dt` and the reason the bias has a sign are the same: the
 * column constraint and the held clearance are *sampled* on the dt grid, in
 * `flyReturn`'s loop, not solved. A coarse grid steps over near-misses, so it
 * reports lines that do not survive and clearances the line never actually
 * holds. Coarse is always optimistic, never pessimistic — which is the worst
 * direction for a number that is graded against a floor. Making the position
 * integration exact rather than Euler moves these rows by under 0.1 px, which
 * is the control that says it is the sampling and not the integration.
 *
 * ## Why 1/8000
 *
 * Against a 1/32000 reference, every published row of both tables lands within
 * **0.1 px**; 1/500 missed by up to 0.78, and 1/4000 is not reliably inside
 * 0.1 either. The claim is held by `the model itself` in tests/cost.test.ts,
 * which now refines `dt` alone and covers worst-gate mode, since that is the
 * mode with the pinned table. It uses `REFERENCE_DT` rather than 1/32000
 * because the two agree to 0.03 px everywhere and the test runs in CI under
 * coverage instrumentation.
 *
 * The residual ~0.03 px of non-monotone jitter at that grid is the 1 px `dx`
 * loop and the 96-sample switch bracket in `approachArrivalVelocity`, not `dt`.
 * It is why the tables are published to one decimal and pinned to 0.1 px rather
 * than quoted further.
 */
const DEFAULTS: Required<CostModelOptions> = {
  rimEnters: true,
  dt: 1 / 8000,
  switchSamples: 60,
  worstGate: false,
  towardDelta: null,
  approachExitVelocity: 0,
}

/**
 * The reference grid the default is measured against. Exported so the claim in
 * the comment above and the test that holds it cannot drift apart.
 */
export const REFERENCE_DT = 1 / 16000

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

/**
 * One checkpoint past the end of them, in the regime §2.4's "no top" argument
 * is actually about.
 *
 * The published checkpoints stop at t = 270 s, which is where the margin over
 * the reachability floor is thinnest *of the ones that are measured* — and it
 * keeps thinning after. `worstGateTowardDelta` is 0.000 px from t = 1200 s on,
 * so the course is motionless here and this one row stands for the whole rest
 * of the run, however long it is. See `ASYMPTOTIC_WORST_GATE`.
 */
export const ASYMPTOTE_CHECKPOINT = 1800

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
 *
 * ## What the converged grid changed (GOK-25, finding 2 and finding 5)
 *
 * These stay as the numbers **spec §2.2 publishes**, deltas and all. They are
 * not refreshed from the model here, because two of the three phase-1 cells the
 * CTO ruled in on GOK-22 were this model's output on a grid that is now known
 * to have been 0.4-0.7 px optimistic, and correcting a spec table is the CTO's
 * call, not a quiet edit in a tool. `PHASE_2_SHORTFALL` below records the gap.
 *
 * The one that matters: on the converged grid **t = 90 misses by 2.01 px**, so
 * §2.2's phase-2 row no longer reproduces to its own stated ±2 px. That row is
 * hand-derived — it is the half of §2.2 that GOK-22 did *not* rule on — and it
 * now fails the same way phase 1 did.
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
 * This model minus `PUBLISHED_COST_TABLE`, on the converged grid.
 *
 * Pinned rather than described, so that the one cell outside §2.2's own ±2 px
 * tolerance cannot quietly become two. Negative is the spec claiming the
 * collecting line holds more clearance than it can.
 *
 * This is the same scaffolding GOK-22 asked me to delete, back for a different
 * reason: not an ambiguity in the prose this time, but a shortfall only a
 * converged instrument can see. It goes away when §2.2 is corrected, the way
 * phase 1's did.
 */
export const PHASE_2_SHORTFALL: Readonly<Record<number, number>> = {
  0: -0.73,
  30: -0.48,
  60: -0.42,
  90: -2.01,
  150: -0.15,
  210: 0.76,
  270: 1.22,
}

/**
 * The clearance a collector can hold on the **worst legal gate** at each
 * difficulty — spec §2.3, re-derived here after v2.1 struck the three phase-1
 * cells as impossible (72 px on the worst gate at t = 0 exceeded the 63.6 px
 * this model gives on the best one).
 *
 * These are this model's output at `worstGate: true` — unlike §2.2's row they
 * have never been in the spec, so they track the instrument rather than
 * recording a claim about it, and the converged grid moves them.
 *
 * **Phase 1 re-derives to the best-gate figure**, because the approach there is
 * genuinely free: at t = 0 the gates are 288 px apart at 180 px/s, so the kite
 * has 0.84 s to absorb a 30 px course move that costs it nothing. The worst gate
 * and the best gate are the same gate until the interval starts to bite.
 *
 * **Phase 2 is 7-8 px tighter than v2.1's standing cells** (20.5 / 15.5 / 13.7 /
 * 12.9 against 28 / 22 / 19 / 19). Those cells were checked for consistency only
 * against `worst <= best`, which they pass; they were never re-derived. Reported
 * on GOK-17 rather than edited into the spec here — see `requiredFloor`, which
 * is the part that is an acceptance criterion.
 *
 * **These were 63.6 / 48.6 / 41.5 / 21.3 / 16.0 / 14.1 / 13.4 one commit ago**,
 * on `dt = 1/500`. Every cell moved down, because a coarse grid steps over
 * near-misses and reports lines the kite cannot actually fly. The figure that
 * mattered is the endgame one: 13.4 against a floor of 12.0 read as 1.4 px of
 * margin, and the converged value of 12.9 is 0.9. See `requiredFloor` and
 * `ASYMPTOTIC_WORST_GATE`.
 */
export const WORST_GATE_TABLE: Readonly<Record<number, number>> = {
  0: 62.9,
  30: 48.0,
  60: 41.1,
  90: 20.5,
  150: 15.5,
  210: 13.7,
  270: 12.9,
}

/**
 * The worst-gate clearance out past the end of the published table, where the
 * course has reached its floors and stops changing — `toward` is 0.000 px from
 * t = 1200 s on, so this is the whole rest of the run.
 *
 * **It is the thinnest the acceptance criterion ever gets: 12.2 against a floor
 * of 12.0.** The table stops at t = 270 s and §2.4's whole argument is that the
 * ramp has no top, so seven checkpoints could not see the regime the argument
 * is about (GOK-25, finding 3). On the old `dt = 1/500` grid this read 13.0 —
 * a margin of 1.0 px where the true one is 0.2, overstating it five-fold.
 *
 * It still clears. It clears by less than the width of the kite's outline, and
 * that is a fact about the design rather than about the instrument, so it is
 * pinned here and reported rather than left at the end of a sweep nobody runs.
 */
export const ASYMPTOTIC_WORST_GATE = 12.2

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

/**
 * The largest clearance a collector can hold at **every** gate of a run on the
 * worst legal course — the header's own words, taken literally.
 *
 * `WORST_GATE_TABLE` is not that number. It lets the kite leave the previous
 * gap hugging the near edge, i.e. holding nothing there, in order to hold its
 * figure here (see `approachArrivalVelocity`). Asking for the same C at both
 * ends makes it a fixed point: `towardDelta` feeds nothing but the exit
 * position, so `towardDelta = worstGateTowardDelta(t) + C` *is* "leave the
 * previous gap C px inside its near edge", and the C that reproduces itself is
 * the self-consistent one.
 *
 * The map is flat and then falls off a cliff — the approach is free until the
 * kite has to start that much further back — so `f(C) - C` is decreasing with
 * exactly one root, bracketed by `[0, f(0)]`. Regula falsi with the Illinois
 * correction finds it in five or six evaluations; plain damped iteration took
 * nearly thirty on the flat part, and each one is a full model evaluation.
 *
 * **At `exitVelocity = 0` this goes under the floor at t = 210 and t = 270**
 * (11.8 and 11.2 against 12.0). It is not a FAIL of the acceptance criterion as
 * written, because the criterion is written against `WORST_GATE_TABLE` and
 * because the two exit assumptions are not independent: a collector that holds
 * C at the previous gate is also *moving* as it leaves, and ~100 px/s restores
 * every cell. But the two readings straddle the floor, and which one the spec
 * means is the CTO's call rather than mine — GOK-17.
 */
export function selfConsistentWorstGate(elapsed: number, options: CostModelOptions = {}): number {
  const base = worstGateTowardDelta(elapsed)
  const at = (towardDelta: number | null): number =>
    collectingCost(elapsed, { ...options, worstGate: true, towardDelta }).collectingClearance

  // g(C) = f(C) - C, decreasing, with g(0) > 0 and g(f(0)) <= 0.
  let lo = 0
  let gLo = at(base) - lo
  let hi = gLo
  let gHi = at(base + hi) - hi
  if (gLo <= 0) return lo
  if (gHi >= 0) return hi

  let c = hi
  // 0.05 px, on the residual *or* on the bracket. Half the precision these
  // tables are published to, and about the size of the grid's own jitter —
  // which is why the bracket test has to be there too: near the root `g`
  // wobbles by more than any residual bar worth setting, so a residual-only
  // stop runs every iteration and each one is a full model evaluation.
  for (let i = 0; i < 20; i += 1) {
    c = (lo * gHi - hi * gLo) / (gHi - gLo)
    const g = at(base + c) - c
    if (Math.abs(g) < 0.05 || hi - lo < 0.05) return c
    if (g > 0) {
      lo = c
      gLo = g
      // Illinois: halve the stale end's weight so the bracket cannot stall on
      // the flat half of the map.
      gHi /= 2
    } else {
      hi = c
      gHi = g
      gLo /= 2
    }
  }
  return c
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
    '  The last column is this model minus the published table. The phase-1 cells',
    '  were corrected to it on GOK-22; the phase-2 cells never were, and on the',
    '  converged grid t = 90 s now misses §2.2’s own ±2 px by 0.01. Reported on',
    '  GOK-17, not absorbed here — the spec is the CTO’s to correct.',
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
  const rows = [...COST_CHECKPOINTS, ASYMPTOTE_CHECKPOINT].map((elapsed) => {
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
      `spec ${(WORST_GATE_TABLE[elapsed]?.toFixed(1) ?? '—').padStart(5)}px`,
    ].join('  ')
  })
  // The exit-position assumption, priced at the two cells where it reaches the
  // floor. Each one is a fixed point over the whole model, so this is the most
  // of it the report can afford; `the exit assumptions straddle the floor` in
  // tests/cost.test.ts carries the rest.
  const straddle = [210, 270].map((elapsed) => {
    const floor = requiredFloor(elapsed)
    const settled = selfConsistentWorstGate(elapsed, options)
    const moving = selfConsistentWorstGate(elapsed, { ...options, approachExitVelocity: 100 })
    return [
      `  t=${`${elapsed}s`.padStart(5)}`,
      `published ${(WORST_GATE_TABLE[elapsed] ?? NaN).toFixed(1).padStart(5)}px`,
      `self-consistent, exit vy=0   ${settled.toFixed(1).padStart(5)}px`,
      settled >= floor ? 'ok  ' : 'under',
      `exit vy=100 ${moving.toFixed(1).padStart(5)}px`,
      moving >= floor ? 'ok' : 'under',
    ].join('  ')
  })

  return [
    '  And on the worst legal gate — the largest move toward the ring (spec §2.3).',
    '',
    ...rows,
    '',
    '  `floor` is max(12, 25% of the safe margin) and is an acceptance criterion,',
    '  not a prediction. Phase 1 re-derives to the best-gate figure: the approach',
    '  is free while the gates are 1.6 s apart. Phase 2 comes out 7-8 px under the',
    '  cells v2.1 left standing, which were never re-derived — reported on GOK-17.',
    `  The last row is past the end of the published table, at t = ${ASYMPTOTE_CHECKPOINT} s, where`,
    '  the course has reached its floors: it is the thinnest the criterion gets.',
    '',
    '  The published row assumes the kite leaves the previous gap at rest and',
    '  hugging its near edge — holding nothing there to hold this. Asking for the',
    '  same clearance at both gates is a fixed point, and it straddles the floor:',
    '',
    ...straddle,
    '',
    '  Neither reading is a bound. Which one §2.3 means is the CTO’s call — GOK-17.',
  ].join('\n')
}
