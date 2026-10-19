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
 * ## Three questions, not one
 *
 * `collectingCost(t)` prices a typical gate — spec §2.2's table, and the only
 * one of the three that is a published figure. `worstGate` prices the hardest
 * legal one; they are the same number until the inter-gate interval gets short
 * enough for the approach to cost something, which is to say until phase 2.
 *
 * `selfConsistentWorstGate(t)` is §2.3's, and the difference between it and
 * `worstGate` is the whole of the v2.2 ruling. Pricing the leg from the
 * previous gap means choosing a position *and* a velocity for the kite as it
 * leaves, and `worstGate` fixes both by hand, in opposite directions. The
 * criterion is about the **self-consistent collector**: the exit state is an
 * output of the definition, so it is a joint fixed point in (position,
 * velocity) over the worst legal *sequence* of sides. §2.3's whole worst-gate
 * row is struck until that lands, and `NEAR_EDGE_WORST_GATE` is kept only as
 * the provenance of the strike.
 *
 * ## Numbers copied out of the spec carry the revision they came from
 *
 * `PUBLISHED_COST_TABLE` is a transcription of a table that lives in a document
 * this repo cannot read. On GOK-27 it was a revision stale and every test
 * passed, because they all compared the model to the transcription and nothing
 * compared the transcription to the spec. It now carries
 * `PUBLISHED_COST_TABLE_REVISION`, graded against tools/spec-revision.ts.
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
import { SPEC_REVISION_SHORT, SPEC_VERSION } from '../spec-revision.js'

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
   * **This is the collector spec v2.2 strikes**, not the one §2.3 is about: it
   * hands the kite the previous gap's near edge, at rest. See
   * `approachArrivalVelocity` for the leg and both assumptions in it, and
   * `selfConsistentWorstGate` for the collector that replaces it.
   */
  readonly worstGate?: boolean
  /**
   * Override the centre move used by `worstGate`. Only for decomposing the
   * worst-gate figure into "the approach is priced at all" and "the gate is the
   * hardest legal one"; the published row leaves this alone.
   */
  readonly towardDelta?: number | null
  /**
   * Outward velocity the kite is handed as it leaves the previous gap, in px/s.
   * Only the hand-fixed collector behind `NEAR_EDGE_WORST_GATE` uses it; the
   * self-consistent one derives its own, which is the whole point of it.
   */
  readonly approachExitVelocity?: number
  /**
   * The search grids the self-consistent cycle uses, which are coarser than the
   * published tables' because it nests an orbit iteration and a bisection
   * inside them. `CYCLE_GRID` is the default; raising any of these to the
   * published model's own resolution is what `the cycle's own grids are inert`
   * in tests/cost.test.ts does.
   */
  readonly cycleGrid?: CycleGrid
}

/** Resolutions the cycle may trade for time. See each constant for the claim. */
export interface CycleGrid {
  /** px step of the collect-window sweep; the published tables use 1. */
  readonly dxStep: number
  /** Integration step of the approach leg; the return leg always uses `dt`. */
  readonly approachDt: number
  /** Switch times tried on the return leg; the published tables use 60. */
  readonly switchSamples: number
  /** Sign-change brackets in the approach solve; the published tables use 96. */
  readonly approachBrackets: number
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
 * Where a line leaves a gate: its state at the end of the column traversal,
 * which is where the next gate's approach leg begins.
 *
 * Offsets are in that gate's own frame — measured from its gap centre, positive
 * toward *its* ring — and so is the velocity, so a positive velocity is one
 * carrying the kite on out past the ring it has just taken. See
 * `selfConsistentWorstGate`, which is the only thing that reads it: for the
 * published tables the exit state is an output nobody looks at, and for the
 * self-consistent collector it is the whole cycle variable.
 */
export interface ExitState {
  readonly offset: number
  readonly velocity: number
}

interface ReturnLeg {
  /** Clearance held through the traversal. */
  readonly held: number
  readonly exit: ExitState
}

/**
 * Fly one return leg and report the clearance it holds through the traversal
 * and the state it leaves in, or null if the line clips a column anywhere.
 *
 * Offsets are measured from the gap centre, positive toward the ring. The
 * control is bang-bang with a single switch, which is the optimal shape for the
 * clearance alone: inward at full acceleration, then braking so as not to spear
 * out of the far side of the gap.
 *
 * ## The third phase, and why the published model did not need one
 *
 * The free-hover relaxation of §2.2 grants the kite any acceleration in
 * `[-1400, +1500]`, so zero is available and a coast is a legal line — the
 * two-phase family simply cannot express one. The published tables do not need
 * it: a coast buys no clearance. What it buys is a *choice of exit velocity*,
 * and that is the quantity `selfConsistentWorstGate` derives rather than
 * assumes, so the cycle needs it and nothing else does.
 *
 * `control` selects between the two. `'settle'` is the published control
 * exactly as it was: brake, and when the kite crosses the gap centre still
 * moving back out, stop it there. That rule is itself a hover, chosen for it by
 * the model rather than by the line — and it is *why* the published model could
 * never report a nonzero exit velocity, because it pins the kite the first time
 * it tries to leave. `'release'` drops it and coasts from `releaseAt` instead,
 * which lets a line brake, push back out, and leave moving.
 */
type ReturnControl = 'settle' | 'release'

function flyReturn(
  gap: number,
  speed: number,
  startOffset: number,
  startVelocity: number,
  secondsToColumn: number,
  inward: number,
  outward: number,
  switchAt: number,
  control: ReturnControl,
  releaseAt: number,
  options: Required<CostModelOptions>,
): ReturnLeg | null {
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

    const a = s < switchAt ? -inward : s < releaseAt ? outward : 0
    velocity = Math.min(Math.max(velocity + a * options.dt, -VY_CLAMP), VY_CLAMP)
    offset += velocity * options.dt
    // Settle rather than bounce straight back out of the far side.
    if (control === 'settle' && velocity > 0 && offset <= 0) velocity = 0
  }
  return { held, exit: { offset, velocity } }
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
 * Offsets are this gate's, positive toward the ring, and `from`/`exitVelocity`
 * are the state the kite left the previous gap in, already carried into this
 * gate's frame — see `entryToThisFrame`, which does the carrying.
 *
 * ## Where that state comes from, and the ruling that settled it
 *
 * The leg has to start somewhere, which means choosing both a **position** and
 * a **velocity** for the kite as it leaves the previous gap, and the
 * re-derivation this function was written for fixed them by hand in opposite
 * directions:
 *
 * - **Position: the previous gap's near edge.** Generous — hugging that edge is
 *   holding *nothing* at the previous gate in order to hold a figure here.
 *   Settled against, on GOK-27: §2.2's own words, "at every gate of a
 *   collecting run", "indefinitely", "the balanced optimum", do not license it.
 * - **Velocity: `vy = 0`.** Conservative, and *also* not licensed.
 *   `maxCentreDelta = 0.5·reach(T)` is rest-to-rest, but that is the bound on
 *   what the **spawner** may legally build; it is not a description of the line
 *   the collector flies. A collector that holds clearance at the previous gate
 *   is still moving as it leaves it, and how fast is a property of its own
 *   periodic trajectory.
 *
 * `NEAR_EDGE_WORST_GATE` is what that pair produces, and spec v2.2 strikes it: a
 * number fixed by hand at both ends is a point inside a band, not an answer.
 * **The criterion is about the self-consistent collector, and the exit state is
 * an output of that definition rather than an input to it** — which is
 * `selfConsistentWorstGate` below, the joint fixed point in (position,
 * velocity). This function is the leg it iterates on; the hand-fixed pair
 * survives only as `NEAR_EDGE_WORST_GATE`'s provenance and the sensitivity sweep.
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
  startOffset: number,
  from: number,
  secondsAvailable: number,
  inward: number,
  outward: number,
  maxOutward: number,
  dt: number,
  exitVelocity: number,
  brackets: number,
): number | null {
  if (secondsAvailable <= 0) return null

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
  const samples = brackets
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

/**
 * One gate of a self-consistent cycle: where the kite came from, and where the
 * side of the *next* gate's ring will be relative to this one's.
 *
 * `from` is the previous gate's exit state **in the previous gate's own frame**;
 * `entrySameSide` says whether that frame shares this gate's sign. `nextSameSide`
 * is the same question looking forward, and it is what makes an exit state good
 * or bad — see `legMerit`.
 */
interface CycleEntry {
  readonly from: ExitState
  readonly entrySameSide: boolean
  readonly nextSameSide: boolean
  /**
   * The clearance the cycle is currently being tested at. A line that holds
   * this much is a candidate however much more it could have held, which is
   * what lets the collector spend surplus clearance at one gate on an exit it
   * can repeat at the next. It is *fixed* for the whole solve of one target —
   * letting it track the best line found so far makes the map non-monotone and
   * the iteration walks off the orbit.
   */
  readonly target: number
  /**
   * Which edge of the legal centre band the gap sits at. A single-side course
   * marches the centre to the edge nearest its ring and stays there; an
   * alternating one has to pick, because one centre has to serve both gates.
   */
  readonly centreLow: boolean
}

/**
 * Carry the previous gate's exit state into this gate's frame.
 *
 * Offsets at gate *n* are measured from its gap centre, positive toward *its*
 * ring; write `u(n) = +1` when that ring is below. The worst legal gate moves
 * the centre `towardDelta` px toward this gate's ring, so
 * `centre(n) = centre(n-1) + u(n)·towardDelta`, and a point at offset `o` in
 * frame `n-1` is at `u(n)·u(n-1)·o - towardDelta` in frame `n`. Velocities
 * carry the same sign flip and no shift.
 *
 * The published worst-gate row is the special case `σ = +1`, `o = gap/2 -
 * KITE_RADIUS` (the near edge), `vy = 0`.
 */
function entryToThisFrame(exit: ExitState, sameSide: boolean, towardDelta: number): ExitState {
  const sigma = sameSide ? 1 : -1
  return { offset: sigma * exit.offset - towardDelta, velocity: sigma * exit.velocity }
}

/** Everything about the *next* gate that ranks this gate's exit states. */
interface NextGate {
  readonly sameSide: boolean
  /** Seconds from this gate's trailing edge to the next gate's collect point. */
  readonly seconds: number
  /** The offset the next approach has to reach, in the next gate's frame. */
  readonly collectAt: number
  readonly inward: number
  readonly outward: number
}

/**
 * What the next gate actually cares about in an exit state, as one number: the
 * inward speed the approach leg could still arrive with, negated so that larger
 * is better.
 *
 * The obvious proxy — "further out and moving outward is better", i.e.
 * `offset + velocity·T` — is monotone in both axes and therefore wrong at the
 * end that matters. Too much outward speed is not a head start, it is an
 * overshoot the leg has no time to undo: a line leaving at 440 px/s cannot be
 * back at the collect point half a second later at all, and ranking by that
 * proxy picks exactly those lines and then finds the next gate unreachable.
 *
 * So rank by the closed form of the leg instead. Out at full acceleration for
 * `τ`, then back: the end offset is monotone in `τ` and quadratic, so it
 * inverts, and the arrival velocity is monotone in `τ` too, which means the
 * *earliest* feasible turn is the fastest arrival. Feasibility is the whole
 * point — `τ = 0` already overshooting the collect point is the overshoot case,
 * and it ranks last rather than first.
 *
 * It ignores the ground, the ceiling and the speed clamp, which the flown leg
 * in `approachArrivalVelocity` does not. That is deliberate: this ranks
 * candidate exits, and the line itself is still simulated in full.
 */
function legMerit(exit: ExitState, next: NextGate): number {
  const sigma = next.sameSide ? 1 : -1
  const offset = sigma * exit.offset
  const velocity = sigma * exit.velocity
  const { seconds: t, collectAt, inward, outward } = next

  // Reachable-at-T window: brake the whole way, or push out the whole way.
  const earliest = offset + velocity * t - 0.5 * inward * t * t
  const latest = offset + velocity * t + 0.5 * outward * t * t
  if (earliest > collectAt || latest < collectAt) return -Infinity

  // (aOut + aIn)/2·τ² - (aOut + aIn)·T·τ - (earliest - collectAt) = 0.
  const a = (outward + inward) / 2
  const b = (outward + inward) * t
  const c = earliest - collectAt
  const tau = (b - Math.sqrt(Math.max(0, b * b + 4 * a * c))) / (2 * a)
  return -(velocity + outward * tau - inward * (t - tau))
}

/** What one gate of the model yields: the clearance held, and where it leaves. */
interface GateResult {
  /** The most any line could hold here, from the state the kite arrived in. */
  readonly clearance: number
  /** The exit of the line the cycle actually flies — see `CycleEntry.target`. */
  readonly exit: ExitState
}

/**
 * How much clearance a cycling line may give up at a gate in exchange for a
 * better exit from it — 0.05 px, which is the grid's own jitter and half the
 * precision these tables are published to.
 *
 * It is a *tolerance*, not a trade: it says the model cannot tell two lines
 * this close apart on clearance, so among them it takes the one that leaves
 * best. Widening it would start selling clearance, which is the quantity under
 * test.
 */
const EXIT_TIE = 0.05

/** The best clearance a collector can hold at this difficulty, on one side. */
function bestOnSide(
  elapsed: number,
  ringBelow: boolean,
  options: Required<CostModelOptions>,
  cycle: CycleEntry | null = null,
): GateResult | null {
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
  const centre = (cycle === null ? ringBelow : !cycle.centreLow) ? high : low

  const spacing = speed * spawnInterval(elapsed)
  const towardDelta = options.towardDelta ?? worstGateTowardDelta(elapsed)
  const entry =
    cycle === null ? null : entryToThisFrame(cycle.from, cycle.entrySameSide, towardDelta)
  // The next gate, which is what makes an exit state good or bad. Its leg is
  // the full one, i.e. the `dx = 0` approach; which `dx` the next gate ends up
  // choosing is a second-order effect on a ranking.
  const nextBelow = cycle === null ? ringBelow : cycle.nextSameSide === ringBelow
  const next: NextGate = {
    sameSide: cycle?.nextSameSide ?? true,
    seconds: (spacing - GATE_WIDTH - RING_LEAD_OF_EDGE) / speed,
    collectAt: ringOffset - COLLECT_REACH,
    inward: nextBelow ? NET_LIFT_ACCEL : GRAVITY,
    outward: nextBelow ? GRAVITY : NET_LIFT_ACCEL,
  }

  // Candidate lines, kept only when a cycle is being solved: the exit is chosen
  // after the fact, among the lines that hold what the cycle is being tested at.
  const heldOf: number[] = []
  const exitOf: ExitState[] = []
  const dxStep = cycle === null ? 1 : options.cycleGrid.dxStep

  let best = -Infinity
  for (let dx = 0; dx <= COLLECT_REACH; dx += dxStep) {
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

    if (options.worstGate || cycle !== null) {
      // On the worst legal gate the approach is not free: the kite has one
      // inter-gate leg to get from the previous gap out to here, and whatever
      // inward speed that leg can deliver is the ceiling on the arrival. The
      // leg runs from the previous gate's trailing edge to the collect point.
      const secondsAvailable = (spacing - GATE_WIDTH - RING_LEAD_OF_EDGE - dx) / speed
      const arrival = approachArrivalVelocity(
        startOffset,
        entry === null ? -towardDelta + (gap / 2 - KITE_RADIUS) : entry.offset,
        secondsAvailable,
        inward,
        outward,
        startOffset + room,
        cycle === null ? options.dt : Math.max(options.dt, options.cycleGrid.approachDt),
        entry === null ? options.approachExitVelocity : entry.velocity,
        cycle === null ? 96 : options.cycleGrid.approachBrackets,
      )
      // Unreachable from the previous gap on this line — try taking the ring
      // at a different point in its collect window.
      if (arrival === null) continue
      // Less negative is less inward: the approach can only ever cost speed.
      startVelocity = Math.max(startVelocity, arrival)
    }

    const total = secondsToColumn + GATE_WIDTH / speed
    const switches = cycle === null ? options.switchSamples : options.cycleGrid.switchSamples
    for (let k = 0; k <= switches; k += 1) {
      const switchAt = (k / switches) * total
      for (const [control, fraction] of cycle === null ? PUBLISHED_CONTROLS : CYCLE_CONTROLS) {
        const leg = flyReturn(
          gap,
          speed,
          startOffset,
          startVelocity,
          secondsToColumn,
          inward,
          outward,
          switchAt,
          control,
          fraction * total,
          options,
        )
        if (leg === null) continue
        if (leg.held > best) best = leg.held
        if (cycle !== null) {
          heldOf.push(leg.held)
          exitOf.push(leg.exit)
        }
      }
    }
  }
  if (best === -Infinity) return null
  if (cycle === null) return { clearance: best, exit: { offset: 0, velocity: 0 } }

  // The cycle is allowed to give up clearance down to the figure it is being
  // tested at — and no further — in exchange for a better exit. That is not a
  // concession: the quantity under test is the clearance held at *every* gate,
  // so a line that holds exactly the target here and leaves in a state it can
  // repeat is worth strictly more than one that holds a tenth more here and
  // cannot repeat anything.
  const bar = cycle.target - EXIT_TIE
  let bestExit: ExitState | null = null
  let bestMerit = -Infinity
  for (let i = 0; i < heldOf.length; i += 1) {
    if ((heldOf[i] as number) < bar) continue
    const merit = legMerit(exitOf[i] as ExitState, next)
    if (merit > bestMerit) {
      bestMerit = merit
      bestExit = exitOf[i] as ExitState
    }
  }
  if (bestExit === null) return null
  return { clearance: best, exit: bestExit }
}

/** The published tables' control: brake, and settle at the centre. */
const PUBLISHED_CONTROLS: readonly (readonly [ReturnControl, number])[] = [['settle', Infinity]]

/**
 * The grids the cycle searches on, and the one it does not.
 *
 * The published tables sweep the collect window at 1 px, try 60 switch times,
 * bracket the approach solve at 96 samples, and integrate everything at `dt`.
 * The cycle nests an orbit iteration and a bisection inside all of that, so at
 * the published resolutions one checkpoint is several minutes. These are the
 * four it trades, and `the cycle's own grids are inert` in tests/cost.test.ts
 * is the control that says the trade is free at the precision the figure is
 * reported to.
 *
 * `approachDt` is the one worth arguing about, and it is the one that buys the
 * most. §2.2's grid box is about *sampling a constraint*: the column margin and
 * the held clearance are tested on the grid rather than solved, so a coarse
 * grid steps over near-misses and reports lines that do not survive. That is
 * the return leg. The approach leg carries no constraint — it is a smooth
 * integration whose only output is one arrival velocity — and the return leg
 * stays at `dt` regardless.
 */
export const CYCLE_GRID: CycleGrid = {
  dxStep: 2,
  approachDt: 1 / 2000,
  switchSamples: 30,
  approachBrackets: 48,
}

/**
 * The controls a cycling line may choose between: the published one, plus
 * brake-and-push-back-out released at a grid of times.
 *
 * The release grid is coarse on purpose. It picks an exit *velocity*, which the
 * next gate then has half a second to act on, and `legMerit` ranks those to
 * first order — so resolving it finer than the 0.05 px the fixed point settles
 * to buys nothing. Late releases are the interesting ones, which is where the
 * grid is dense.
 */
const CYCLE_CONTROLS: readonly (readonly [ReturnControl, number])[] = [
  ['settle', Infinity],
  ['release', 0.55],
  ['release', 0.75],
  ['release', 0.875],
  ['release', 0.95],
  ['release', Infinity],
]

/**
 * Grid resolution — two knobs, converged to different degrees, with opposite
 * biases. Refine them **one at a time, each against its own bar**; refining
 * both together is what hid a 0.78 px error for a revision, and the reason it
 * hid it is in the second half of this comment.
 *
 * ## `dt`: converged at 1/8000, and its error is one-sided *optimistic*
 *
 * The old default of `dt = 1/500` claimed "every row within 0.5 px" on the
 * strength of a convergence check that refined both knobs at once and ran
 * balanced mode only (GOK-25, finding 2). Refined alone, at t = 90 s in
 * worst-gate mode, `dt` 1/500 → 1/32000 moves the row by **0.78 px**,
 * monotonically downward.
 *
 * The reason the bias has a sign: the column constraint and the held clearance
 * are *sampled* on the dt grid, in `flyReturn`'s loop, not solved. A coarse
 * grid steps over near-misses, so it reports lines that do not survive and
 * clearances the line never actually holds. Coarse is always optimistic, never
 * pessimistic — the worst direction for a number graded against a floor. Making
 * the position integration exact rather than Euler moves these rows by under
 * 0.1 px, which is the control that says it is the sampling and not the
 * integration.
 *
 * Against a 1/32000 reference, every published row of both tables lands within
 * **0.1 px** at 1/8000; 1/500 missed by up to 0.78, and 1/4000 is not reliably
 * inside 0.1 either. `the model itself` in tests/cost.test.ts holds the claim,
 * refining `dt` alone and covering worst-gate mode. It uses `REFERENCE_DT`
 * rather than 1/32000 because the two agree to 0.03 px everywhere and it runs
 * in CI under coverage instrumentation.
 *
 * ## `switchSamples`: **not** converged at 60, and its error is *pessimistic*
 *
 * This corrects the paragraph that used to stand here, and §2.2's grid box with
 * it (GOK-26). Both said the switch time was "inert above ~60" and therefore
 * that `dt` was the whole claim. Both measured it in **worst-gate mode at
 * `dt = 1/4000`** — which is the one configuration in which it is true. At the
 * shipped `dt`, refining `switchSamples` alone:
 *
 * | t | 0 | 30 | 60 | 90 | 150 | 210 | 270 | 1800 |
 * | --- | --- | --- | --- | --- | --- | --- | --- | --- |
 * | balanced, 60 | 62.869 | 48.118 | 41.081 | 31.992 | 24.853 | 21.755 | 20.215 | 18.696 |
 * | balanced, 7680 | 63.265 | 48.154 | 41.274 | 32.044 | 24.982 | 21.887 | 20.373 | 18.907 |
 * | Δ | +0.396 | +0.037 | +0.193 | +0.052 | +0.129 | +0.132 | +0.158 | +0.211 |
 * | worst gate, Δ | +0.086 | +0.111 | +0.193 | **0** | **0** | **0** | **0** | **0** |
 *
 * 7680 is the limit to 0.005 px — 3840 → 7680 moves one cell, by 0.0034. The
 * smallest grid clearing a 0.1 px bar against it is **240** (worst cell 0.075);
 * 480 gives 0.037 and 960 gives 0.018, which is where `dt`'s own residual sits.
 *
 * **The sign is provable rather than measured.** `bestOnSide` takes a `max`
 * over `switchAt = k / switchSamples`, and the grids nest — `{k/60} ⊂ {k/120} ⊂
 * {k/240} ⊂ …` — so a finer grid maximises over a superset and the reported
 * clearance can only rise. Coarse `switchSamples` is therefore **pessimistic**,
 * the opposite sign to `dt`. Refining the two together partly cancels them,
 * which is a second and independent reason the old check looked settled, and it
 * is why refining `dt` alone now *overstates* how converged the instrument is.
 *
 * It also means a doubling that changes nothing is not evidence of anything: a
 * superset can fail to beat its subset and then beat it at the next doubling,
 * which is exactly what the balanced row does between 120 and 960.
 *
 * ## What it moves, and what it provably does not
 *
 * **Not the floors.** Worst-gate `t ≥ 90` is *bit-identical* from 60 through
 * 1920 — every cell §2.3's verdict is graded on, including the 12.2432
 * near-edge ceiling the self-consistent bisection brackets against. Neither is
 * the derived row: `worstCycle(1800)` reports 8.486 px at
 * `cycleGrid.switchSamples` of 30, 60, 120 and 240 alike. GOK-27's straddle and
 * break-evens are untouched.
 *
 * **It does move the published §2.2 row**, by up to 0.40 px at t = 0. Seven of
 * its eight decimals change and six move by more than the 0.1 px `dt` is held
 * to: on a converged switch grid §2.2 reads **63.3 / 48.2 / 41.3 / 32.0 / 25.0
 * / 21.9 / 20.4 / 18.9**. Every one is still inside §2.2's own ±2 px — so that
 * pin would not have caught this and nothing ruled on the published numbers is
 * disturbed — but the published decimals are not the converged ones.
 *
 * ## Why 60 is still what ships
 *
 * Because §2.2's table **is** this model's output on this grid — the document
 * says to regenerate it from here rather than edit it by hand — so raising the
 * knob rewrites seven published decimals. §3's rule is that *a change that
 * moves a published cell is a spec revision, not a retune*; it is written about
 * `dt` because the grid box believed this knob inert, and it applies to
 * whichever knob does the moving. Raising it here while `PUBLISHED_COST_TABLE`
 * still holds v2.2's cells would manufacture the exact failure this file now
 * guards against: a transcription that no longer matches the grid it was
 * published on, under a revision guard reading green because the revision has
 * not moved.
 *
 * So the grid moves when §2.2 moves, in one diff. Open with the CTO on GOK-28.
 * `is not converged in the switch grid, and that is confined to §2.2` in
 * tests/cost.test.ts pins both halves meanwhile, so neither the inertness nor
 * the sensitivity can drift unnoticed.
 *
 * The residual ~0.03 px of non-monotone jitter at this grid is the 1 px `dx`
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
  cycleGrid: CYCLE_GRID,
}

/**
 * The reference grid the default is measured against. Exported so the claim in
 * the comment above and the test that holds it cannot drift apart.
 */
export const REFERENCE_DT = 1 / 16000

/**
 * The switch grid `DEFAULTS.switchSamples` is measured against — and, unlike
 * `REFERENCE_DT`, the default **does not clear it** in balanced mode. That is
 * the finding, not an oversight; see the comment above.
 *
 * It is a bar rather than a converged value: the figure is still creeping
 * upward at 1920, so refining to this does not produce the converged table, it
 * only demonstrates that 60 is not it. Eight times the default is enough for
 * both halves of the claim — the balanced row moves by 0.37 px at t = 0, and
 * worst-gate `t ≥ 90` is identical to the last bit — and cheap enough to assert
 * in CI, which 1920 is not.
 */
export const SWITCH_REFERENCE = 480

/** What a ring costs at this difficulty, under the reference model. */
export function collectingCost(elapsed: number, options: CostModelOptions = {}): CostRow {
  const settings = { ...DEFAULTS, ...options }
  const gap = gapHeight(elapsed)
  const safeClearance = gap / 2 - KITE_RADIUS
  // A collector meets both sides over a run, so the holdable figure is the
  // worse of the two.
  const collectingClearance = Math.min(
    bestOnSide(elapsed, true, settings)?.clearance ?? -Infinity,
    bestOnSide(elapsed, false, settings)?.clearance ?? -Infinity,
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
 * of the run, however long it is — and it is a published cell of §2.2's own
 * table, the one it writes as `→ ∞`.
 */
export const ASYMPTOTE_CHECKPOINT = 1800

export function costTable(options: CostModelOptions = {}): CostRow[] {
  return PUBLISHED_CHECKPOINTS.map((t) => collectingCost(t, options))
}

/**
 * The revision of GOK-2's `spec` document that `PUBLISHED_COST_TABLE` below was
 * transcribed from.
 *
 * ## Why this exists (spec §2.2 and §3, new in v2.2)
 *
 * The transcription below is a *copy* of a table that lives somewhere else. On
 * GOK-27 that copy was found to be a full revision behind the document, and all
 * 23 tests passed anyway — because every assertion compared the model to the
 * copy and nothing compared the copy to the spec. The one mechanism meant to
 * catch a hand-edited table was the mechanism that hid one, and it reported a
 * 2.01 px shortfall against a cell the spec had already superseded.
 *
 * So the copy carries the revision it came from, and `the published table is
 * not a revision stale` in tests/cost.test.ts asserts that revision against
 * `SPEC_REVISION` — the single repo-wide record of which revision of the spec
 * this tree is written against. The guard is the *pair*: bumping
 * `SPEC_REVISION` when the document moves turns this file red until the table
 * is re-read off the new revision and this constant is bumped with it. Updating
 * one without the other is what fails, which is exactly the failure that went
 * unnoticed.
 *
 * It cannot verify the document from CI — nothing in this repo can reach
 * Paperclip — so what it buys is that a stale copy fails *loudly at the moment
 * the spec moves* rather than silently forever. Re-read §2.2's table by hand
 * when you bump it; that read is the verification.
 */
export const PUBLISHED_COST_TABLE_REVISION = '1983e25b-d61a-45a9-bbf6-2393282b6cd8'

/**
 * The collecting-line clearances published in spec §2.2, as of the revision
 * named above.
 *
 * **The whole table reproduces**, to within the rounding of its own published
 * precision — every cell is this model's own output on the published grid, and
 * the largest residual is 0.05 px. There is no shortfall to record; the
 * `PHASE_2_SHORTFALL` constant that used to sit here was pinning the staleness
 * of the copy, not a property of the design, and it is gone.
 *
 * The three phase-1 rows were corrected in v2.1 — v2 published 79 / 64 / 50 px
 * and the model said 63.6 / 48.6 / 41.5 — on the ruling that the instrument is
 * the contract and the hand-derived row was wrong: v2's phase-1 clearances were
 * very nearly linear in t (≈ 79 - 0.5t), the signature of an interpolation
 * between endpoints, and the t = 0 figure was not merely unmatched but
 * *unreachable*, since the speed clamp alone caps the holdable clearance there
 * at 72.6 px however the control is chosen. v2.2 then republished the whole
 * table on the converged grid, which moved every cell down by 0.1-0.7 px.
 *
 * Traversal is ruled **rim, not centre** — what collision.ts enforces, and the
 * only reading under which the second ramp reproduces at all. That ambiguity is
 * what produced the original error, so `the loose reading is not this table` is
 * kept as a test rather than as a note here.
 *
 * The last row is §2.2's `→ ∞` cell. It is a published cell like any other and
 * is transcribed here as `ASYMPTOTE_CHECKPOINT`, because the course is at its
 * floors from t = 1200 s and the limit is therefore a state the run actually
 * occupies rather than one it approaches.
 */
export const PUBLISHED_COST_TABLE: Readonly<Record<number, number>> = {
  0: 62.9,
  30: 48.1,
  60: 41.1,
  90: 32.0,
  150: 24.9,
  210: 21.8,
  270: 20.2,
  [ASYMPTOTE_CHECKPOINT]: 18.7,
}

/** Every checkpoint §2.2 publishes a cell for, the `→ ∞` one included. */
export const PUBLISHED_CHECKPOINTS = [...COST_CHECKPOINTS, ASYMPTOTE_CHECKPOINT] as const

/**
 * The clearance a collector holds on the worst legal gate **when it is handed
 * the previous gap's near edge, at rest** — spec §2.3's struck row.
 *
 * **This is not a published figure and must not be used as one.** v2.2 strikes
 * §2.3's whole worst-gate row, and the ruling on GOK-27 is explicit that this
 * table is not its replacement: it is measured on a collector the spec does not
 * mean. The name says near edge rather than worst gate for that reason.
 *
 * It is kept for three jobs, all of them about provenance rather than about the
 * design. It is the number the spec's own "what is at stake" table quotes as
 * *the struck row*, so the instrument has to still produce it. It is the
 * ceiling the self-consistent bisection brackets against, since a collector
 * made to hold its own clearance at the previous gate cannot beat one handed
 * that gap's edge for free. And it is the subject of `the coarse grid errs
 * optimistically` in tests/cost.test.ts, which is what the ±0.78 px claim in
 * §2.2's grid box rests on.
 *
 * Phase 1 re-derives to the best-gate figure, and that is a finding rather than
 * a rounding artefact: at t = 0 the gates are 288 px apart at 180 px/s, so the
 * kite has 0.84 s in which a 30 px course move costs it nothing at all. The
 * worst gate and the best gate are the same gate until the interval bites.
 */
export const NEAR_EDGE_WORST_GATE: Readonly<Record<number, number>> = {
  0: 62.9,
  30: 48.0,
  60: 41.1,
  90: 20.5,
  150: 15.5,
  210: 13.7,
  270: 12.9,
  [ASYMPTOTE_CHECKPOINT]: 12.2,
}

/**
 * **The derived §2.3 row: the self-consistent collector on the worst legal
 * course.** `selfConsistentWorstGate` is what produces it.
 *
 * This is the figure spec v2.2's ruling asks for and the one §2.3's verdict is
 * waiting on. The exit state is an output of the definition rather than an
 * input to it, so neither of the struck row's two hand-fixed assumptions
 * survives: the kite leaves the previous gap holding the same clearance it
 * claims here, at whatever velocity its own periodic line gives it, and the
 * figure has to hold on the worst legal *sequence* of sides rather than the
 * worst single gate.
 *
 * ## The verdict is a reachability failure, from t = 150 s on
 *
 * | t | near edge, `vy = 0` | self-consistent | floor | |
 * | --- | --- | --- | --- | --- |
 * | 0 | 62.9 | 50.7 | 28.5 | ok |
 * | 30 | 48.0 | 39.5 | 23.9 | ok |
 * | 60 | 41.1 | 25.1 | 19.3 | ok |
 * | 90 | 20.5 | 15.2 | 14.8 | ok, by 0.4 px |
 * | 150 | 15.5 | 11.0 | 12.3 | **1.3 px under** |
 * | 210 | 13.7 | 9.5 | 12.0 | **2.5 px under** |
 * | 270 | 12.9 | 8.9 | 12.0 | **3.1 px under** |
 * | → ∞ | 12.2 | 8.5 | 12.0 | **3.5 px under** |
 *
 * The asymptote is the cell that decides it, and it is not a limit: the course
 * is at its floors from t = 1200 s, so it is every gate of the rest of a run of
 * any length. See `ASYMPTOTE_CHECKPOINT`.
 *
 * ## The exit velocity came out small, and that is the finding
 *
 * §2.3's "what is at stake" table prices the struck row against an assumed exit
 * velocity and notes that the asymptotic cell needs **84.4 px/s** to reach its
 * floor — which is why "~100 px/s restores every cell" could not be left as a
 * hand-picked number. Derived, the orbit's exit velocity is **under 40 px/s in
 * magnitude at every checkpoint**, and at the asymptote — the cell that decides
 * this — it is *inward*, around -20 px/s. It is not a near miss on 84.4.
 *
 * The reason is structural rather than numerical. A line that leaves fast is a
 * line that spent its column traversal accelerating back out of the gap, and
 * the clearance that costs is the clearance under test. The two assumptions
 * were never independent, and pricing them together does not land between them
 * — it lands below both. The same thing happens on the position axis: §2.3's
 * estimate of the self-consistent figure assumed the kite leaves *at* the
 * clearance boundary, `safeHalfWidth - C` toward the ring, and the orbit does
 * not get there either. At t = 90 the derived exit is 26.5 px out where that
 * assumption would put it at 41.8, which is most of the 2.0 px between §2.3's
 * 17.2 and the 15.2 here.
 *
 * ## Two places this is stricter than it has to be, both named
 *
 * **The centre is pinned at the band edge and the course still moves toward the
 * ring.** The binding courses are single-sided, so the gap centre marches to
 * the edge of its legal band and stops — at which point it cannot keep moving
 * `worstGateTowardDelta` toward the ring every gate, which this model charges
 * it for anyway. The charge is 30 px while `t <= 90` and decays with the second
 * ramp: 15 at t = 150, 7.5 at 210, 3.75 at 270, and **0.000 from t = 1200 s**.
 * So it does not touch the asymptotic cell at all, and that is the cell the
 * verdict turns on.
 *
 * **The orbit's exit is chosen by a ranking rather than by search.** Among the
 * lines that hold the figure under test, `legMerit` picks the one whose exit
 * the next approach can do most with, using the closed form of the leg rather
 * than flying it. A true joint optimisation over the pair could only find a
 * better orbit, never a worse one, so this errs low. `the cycle's own grids are
 * inert` bounds the search resolution at 0.3 px; the ranking is not bounded and
 * is the honest soft spot in the derivation.
 *
 * ## What this is not
 *
 * It is not a retune and nothing moves on it. The GOK-22 fence holds while
 * §2.3 is open: a cell under its floor is a reachability failure and the remedy
 * is a design change argued on its merits — `E(t)`'s phase-2 floor, the
 * `30·(1 - q)` toward cap, or the 110 px gap floor — decided as a spec
 * revision. Reported on GOK-28 and GOK-17.
 */
export const SELF_CONSISTENT_WORST_GATE: Readonly<Record<number, number>> = {
  0: 50.7,
  30: 39.5,
  60: 25.1,
  90: 15.2,
  150: 11.0,
  210: 9.5,
  270: 8.9,
  [ASYMPTOTE_CHECKPOINT]: 8.5,
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

/**
 * The side sequences a sustained clearance has to survive.
 *
 * The spawner draws the side of each ring as a fair coin, so over a run of any
 * length every finite pattern occurs, and a clearance that must hold *at every
 * gate* has to survive the worst **sequence**, not the worst single gate
 * (§2.3). Among infinite sequences the binding ones are the periodic
 * extremes — a run of identical sides, and a strict alternation — because
 * every other pattern is built out of those two transitions and so is bounded
 * below by the worse of them.
 *
 * The two single-side patterns are listed separately because the kite is not
 * symmetric: coming back up is 1400 and coming back down is 1500.
 */
const COURSES: readonly Course[] = [
  { sides: [true], centreLow: false },
  { sides: [false], centreLow: true },
  { sides: [true, false], centreLow: false },
  { sides: [true, false], centreLow: true },
]

/** A course the derived figure has to survive: a side pattern and a centre. */
interface Course {
  /** Is each gate's ring below its gap? The pattern repeats forever. */
  readonly sides: readonly boolean[]
  /** Which edge of the legal centre band the gap sits at. */
  readonly centreLow: boolean
}

/** A solved cycle: what it holds, and the periodic orbit it holds it with. */
export interface SelfConsistentCycle {
  /** The clearance held at every gate of the cycle. */
  readonly clearance: number
  /** The course that produced it. */
  readonly course: Course
  /** The periodic exit state, in the frame of the last gate of the pattern. */
  readonly exit: ExitState
  /** Could the ring be collected on this course at all, at any clearance? */
  readonly collectable: boolean
  /** Did the root-find settle inside its tolerance? */
  readonly converged: boolean
}

/**
 * Fly the course at a fixed target clearance and report whether it closes into
 * a periodic orbit that holds it.
 *
 * Every gate must hold the target; a gate that cannot is not a cheaper gate, it
 * is a refutation of the target, and the course fails there. That crispness is
 * what makes the iteration behave: an earlier version let a gate that missed
 * the target fall back to its own best line instead, and the orbit then
 * alternated forever between a line that holds a lot and leaves badly and a
 * line that holds the target and leaves well, converging to neither.
 *
 * With the target fixed, the per-gate choice is one consistent rule and the
 * orbit settles in two or three rounds from a warm start.
 */
function flyCourse(
  elapsed: number,
  course: Course,
  target: number,
  settings: Required<CostModelOptions>,
  start: ExitState,
): { exit: ExitState; headroom: number } | null {
  const { sides } = course
  let exit = start
  let last = 0

  for (let round = 0; round < CYCLE_ROUNDS; round += 1) {
    let state = exit
    let headroom = Infinity
    for (let i = 0; i < sides.length; i += 1) {
      const side = sides[i] as boolean
      const previous = sides[(i + sides.length - 1) % sides.length] as boolean
      const next = sides[(i + 1) % sides.length] as boolean
      const result = bestOnSide(elapsed, side, settings, {
        from: state,
        entrySameSide: previous === side,
        nextSameSide: next === side,
        target,
        centreLow: course.centreLow,
      })
      // Either no line reaches this gate's ring from there at all, or none of
      // the ones that do hold the target. Both refute the target.
      if (result === null) return null
      headroom = Math.min(headroom, result.clearance - target)
      state = result.exit
    }
    const settled =
      Math.abs(state.offset - exit.offset) < ORBIT_TOLERANCE.offset &&
      Math.abs(state.velocity - exit.velocity) < ORBIT_TOLERANCE.velocity
    exit = state
    last = headroom
    if (settled) return { exit, headroom }
  }
  // It never settled to a point, but it did fly `CYCLE_ROUNDS` gates in a row
  // holding the target without the state running away — the control grid is
  // discrete, so an orbit can amble around its fixed point rather than sit on
  // it. Drift that matters shows up as a gate that cannot hold the target,
  // which is a null above: at this difficulty a target 0.2 px too high walks
  // the exit state out by a pixel a round and fails inside five.
  return { exit, headroom: last }
}

/** How many times the orbit is iterated before a target is called unreachable. */
const CYCLE_ROUNDS = 4

/**
 * How closely the orbit has to repeat before it counts as closed.
 *
 * Not to machine precision, and not to the 0.05 px the clearance is bisected
 * to: the control grid is discrete, so a settled orbit does not sit still — it
 * ambles around a point by a fraction of a pixel as the best line flips between
 * neighbouring release times. Half a pixel of position and 5 px/s of velocity
 * is inside that amble and well inside anything that moves the clearance the
 * orbit holds, which is the quantity being reported.
 */
const ORBIT_TOLERANCE = { offset: 0.3, velocity: 3 }

/**
 * Where the orbit iteration is started from.
 *
 * Three canonical exits rather than one, because the natural guess is not
 * natural on every course. "Hugging the previous gap's near edge" is the struck
 * row's own assumption and the right end of the map to come down from on a
 * course whose rings are all on one side — but on an alternating course that
 * same state is on the far side of the gap from the next ring, and at t = 0 it
 * is not merely a bad start, it is 144 px of frame shift that no leg can close.
 * An iteration started there reports the course unflyable when it is not.
 *
 * So the orbit is established from whichever of the three closes best, and the
 * bisection warm-starts from it after that.
 */
function orbitStarts(gap: number): readonly ExitState[] {
  const edge = gap / 2 - KITE_RADIUS
  return [
    { offset: edge, velocity: 0 },
    { offset: 0, velocity: 0 },
    { offset: -edge, velocity: 0 },
  ]
}

/**
 * Solve one course to the largest clearance it can sustain.
 *
 * The question "can this course be flown indefinitely holding C" is monotone in
 * C — an orbit holding C holds every smaller figure, by the same line — so the
 * answer is a single threshold and bisection finds it. There is no continuous
 * residual to run a secant on instead: what the iteration returns is an orbit
 * or nothing, and the clearance a *failed* target happened to reach on the way
 * is not a measurement of anything.
 *
 * Each probe is warm-started from the last orbit known to close, which is the
 * nearest point on the map and keeps the round count down. The bracket's top is
 * the figure the struck row reports, since a collector that has to hold its own
 * clearance at the previous gate cannot beat one handed that gap's near edge
 * for free.
 */
function solveCourse(
  elapsed: number,
  course: Course,
  settings: Required<CostModelOptions>,
  ceiling: number,
): SelfConsistentCycle {
  const gap = gapHeight(elapsed)
  let warm: ExitState | null = null
  let exit: ExitState = { offset: 0, velocity: 0 }

  // Establish the orbit from the first start that closes at all.
  for (const start of orbitStarts(gap)) {
    const orbit = flyCourse(elapsed, course, 0, settings, start)
    if (orbit === null) continue
    warm = orbit.exit
    exit = orbit.exit
    break
  }
  // The ring cannot be collected on this course at all, at any clearance. That
  // is a stronger statement than a thin one and is reported as its own thing.
  if (warm === null) {
    return { clearance: 0, course, exit, collectable: false, converged: true }
  }

  const closes = (target: number): boolean => {
    const orbit = flyCourse(elapsed, course, target, settings, warm as ExitState)
    if (orbit === null) return false
    warm = orbit.exit
    exit = orbit.exit
    return true
  }

  let lo = 0
  let hi = ceiling + 0.1
  // 0.1 px, or 1% where the figure is large enough that 0.1 is noise — seven
  // bisection steps either way, each one a full orbit. The cells this criterion
  // turns on are the small ones.
  const tolerance = Math.max(0.1, 0.01 * hi)
  while (hi - lo > tolerance) {
    const mid = (lo + hi) / 2
    if (closes(mid)) lo = mid
    else hi = mid
  }
  return {
    clearance: lo,
    course,
    exit,
    collectable: true,
    converged: true,
  }
}

/**
 * The largest clearance a collector can hold at **every** gate of a run on the
 * worst legal course — §2.3's criterion, as spec v2.2 defines it.
 *
 * ## What this is, and what `NEAR_EDGE_WORST_GATE` was
 *
 * The struck row fixed the kite's state as it left the previous gap by hand, at
 * both ends and in opposite directions: at the previous gap's **near edge**
 * (generous — that is holding nothing there in order to hold a figure here) and
 * **at rest** (conservative — rest-to-rest is the bound on what the spawner may
 * legally build, not a description of the line the collector flies). The ruling
 * on GOK-27 is that **the exit state is an output of the definition rather than
 * an input to it**: the criterion is about the self-consistent collector, so
 * the exit state of gate *n* has to equal that of gate *n − 1*, and the figure
 * is whatever that joint fixed point in (position, velocity) turns out to be.
 *
 * ## The fixed point
 *
 * The cycle variable is the kite's state at the end of a gate's column
 * traversal, `(offset, velocity)` in that gate's own frame, which is exactly
 * where the next gate's approach leg begins. One iteration carries it into the
 * next gate's frame (`entryToThisFrame`) and flies the approach and the return
 * under the unchanged model constraints — the rim reading, the full 70 px of
 * traversal, the speed clamp, and the worst legal gate on both sides.
 *
 * Self-consistency in **position** then needs no solving at all: the clearance
 * is the minimum of `safeHalfWidth - |offset|` over the traversal and the exit
 * is a point of that traversal, so a line that holds C *leaves* at least C
 * inside the edge by construction. That is the half the old scaffold was
 * root-finding by hand, and it was right to.
 *
 * Self-consistency in **velocity** is the new half, and it needs two things the
 * published model does not have. The control has to be able to express the
 * choice — see `flyReturn`'s release phase, and note that the published
 * control's settle rule *pins the kite the first time it tries to leave*, which
 * is why that model could never have reported anything but `vy = 0`. And the
 * line has to be chosen for what it sustains rather than for what it holds
 * once: among the lines that hold the figure under test, the cycle takes the
 * one that leaves best (`legMerit`). The exit velocity is then read off the
 * orbit — derived, not picked.
 *
 * ## The worst sequence, not the worst gate
 *
 * The side is a fair coin, so over a run of any length every pattern occurs and
 * the figure has to survive the worst legal **sequence** — see `COURSES`. The
 * binding patterns are the periodic extremes, a run of identical sides and a
 * strict alternation, since every other pattern is built from those two
 * transitions. Alternation is the hard one: the kite's exit from one gate is on
 * the far side of the gap from the next gate's ring, so it pays the full width
 * of the gap on top of the detour. An alternating course also has to pick one
 * gap centre to serve both sides, which a single-side course does not, so both
 * edges of the legal band are tried.
 */
export function selfConsistentWorstGate(elapsed: number, options: CostModelOptions = {}): number {
  return worstCycle(elapsed, options).clearance
}

/** The same derivation, with the orbit and the course it came from. */
export function worstCycle(elapsed: number, options: CostModelOptions = {}): SelfConsistentCycle {
  const settings = { ...DEFAULTS, ...options, worstGate: true }
  // The struck row is a ceiling on this: a collector that has to hold its own
  // figure at the previous gate cannot beat one handed that gate's near edge
  // for free. It is the bracket's top end, not an assumption of the solve.
  const ceiling = collectingCost(elapsed, { ...options, worstGate: true }).collectingClearance
  let worst: SelfConsistentCycle | null = null
  for (const course of COURSES) {
    const cycle = solveCourse(elapsed, course, settings, ceiling)
    if (worst === null || cycle.clearance < worst.clearance) worst = cycle
  }
  return worst as SelfConsistentCycle
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
      `spec ${published.toFixed(1).padStart(4)}px`,
      `${delta >= 0 ? '+' : ''}${delta.toFixed(2)}`,
    ].join('  ')
  })
  const worst = Math.max(
    ...costTable(options).map((row) =>
      Math.abs(row.collectingClearance - (PUBLISHED_COST_TABLE[row.elapsed] as number)),
    ),
  )
  return [
    `  The cost of a ring on a typical gate, from the reference model of spec §2.2`,
    `  (${SPEC_VERSION}, revision ${SPEC_REVISION_SHORT}).`,
    '',
    ...rows,
    '',
    '  The last column is this model minus the published table. Every cell of that',
    '  table is this model’s own output on the published grid, so the column is a',
    `  transcription check and nothing else: the largest residual is ${worst.toFixed(2)} px,`,
    '  which is the rounding of the one decimal §2.2 publishes to.',
    '',
    '  There is no §2.2 shortfall. The 2.01 px this report used to claim at t = 90 s',
    '  was measured against a copy of the table that was a revision stale, not',
    '  against the spec — GOK-27. The copy now carries its revision and a test',
    '  grades it against tools/spec-revision.ts.',
  ].join('\n')
}

/** How a course prints: `BA@hi` is "below, then above, gap at the band's top". */
function courseLabel(course: Course): string {
  return `${course.sides.map((below) => (below ? 'B' : 'A')).join('')}@${course.centreLow ? 'lo' : 'hi'}`
}

/**
 * Spec §2.3's reachability criterion: the collector it is about, the collector
 * its struck row was measured on, and the floor both are graded against.
 *
 * The `floor` column is the acceptance criterion: a cell under it is a
 * reachability failure — a ring that cannot be taken without dying, which is as
 * broken as one that is free — and it goes back to the CTO rather than being
 * absorbed into a constant here.
 *
 * The self-consistent row is printed from `SELF_CONSISTENT_WORST_GATE` rather
 * than derived, because deriving the eight cells is about a quarter of an hour
 * and `pnpm feel` is a report people run. `pnpm feel:reach` derives them; the
 * suite re-derives the two the verdict turns on.
 */
export function formatWorstGateTable(options: CostModelOptions = {}): string {
  const rows = PUBLISHED_CHECKPOINTS.map((elapsed) => {
    const best = collectingCost(elapsed, options)
    const near = collectingCost(elapsed, { ...options, worstGate: true })
    const floor = requiredFloor(elapsed)
    return [
      `  t=${`${elapsed}s`.padStart(5)}`,
      `toward ${worstGateTowardDelta(elapsed).toFixed(1).padStart(5)}px`,
      `best gate ${best.collectingClearance.toFixed(1).padStart(5)}px`,
      `near edge ${near.collectingClearance.toFixed(1).padStart(5)}px`,
      `floor ${floor.toFixed(1).padStart(5)}px`,
      `struck ${(NEAR_EDGE_WORST_GATE[elapsed]?.toFixed(1) ?? '—').padStart(5)}px`,
    ].join('  ')
  })

  return [
    '  The worst legal gate — spec §2.3, whose whole row v2.2 strikes.',
    '',
    ...rows,
    '',
    '  `near edge` is the collector the struck row was measured on: handed the',
    '  previous gap’s near edge, at rest. It is reproduced so the strike can be',
    '  checked, and it is **not a published figure**. Phase 1 re-derives to the',
    '  best-gate figure because the approach there really is free — 0.84 s to',
    '  absorb a 30 px course move.',
    '',
    '  And the collector §2.3 is about: exit position *and* velocity an output of',
    '  a joint fixed point, over the worst legal sequence of sides. `pnpm',
    '  feel:reach` re-derives these; here they are read from the pinned row.',
    '',
    ...formatSelfConsistentRows(),
    '',
    '  `floor` is max(12, 25% of the safe margin) and is an acceptance criterion,',
    '  not a prediction. A FAIL is a reachability failure and goes to the CTO —',
    `  GOK-17. The t = ${ASYMPTOTE_CHECKPOINT} s row is not a limit: the course is at its floors`,
    '  from t = 1200 s, so it is every gate for the rest of a run of any length.',
  ].join('\n')
}

/** The derived §2.3 row against its floor, from the pinned constant. */
function formatSelfConsistentRows(): string[] {
  return PUBLISHED_CHECKPOINTS.map((elapsed) => {
    const derived = SELF_CONSISTENT_WORST_GATE[elapsed] as number
    const floor = requiredFloor(elapsed)
    return [
      `  t=${`${elapsed}s`.padStart(5)}`,
      `self-consistent ${derived.toFixed(1).padStart(5)}px`,
      `floor ${floor.toFixed(1).padStart(5)}px`,
      derived >= floor ? 'ok  ' : 'FAIL',
      `margin ${(derived - floor >= 0 ? '+' : '') + (derived - floor).toFixed(1)}px`,
    ].join('  ')
  })
}

/**
 * Derive the §2.3 row from scratch, printing each cell as it lands. `pnpm
 * feel:reach`.
 *
 * This is the slow one — a few minutes a checkpoint in phase 1 — which is why
 * it is its own command and why `formatWorstGateTable` prints the pinned row
 * instead. Running it is how `SELF_CONSISTENT_WORST_GATE` gets updated, and the
 * two cells the verdict turns on are re-derived by the suite on every push.
 */
export function deriveSelfConsistentRow(
  options: CostModelOptions = {},
  log: (line: string) => void = console.log,
): void {
  log('  Deriving §2.3 — the self-consistent collector on the worst legal course.')
  log('')
  for (const elapsed of PUBLISHED_CHECKPOINTS) {
    const started = Date.now()
    const cycle = worstCycle(elapsed, options)
    const floor = requiredFloor(elapsed)
    log(
      [
        `  t=${`${elapsed}s`.padStart(5)}`,
        `self-consistent ${cycle.clearance.toFixed(2).padStart(6)}px`,
        `exit (${cycle.exit.offset.toFixed(1).padStart(6)}px, ${cycle.exit.velocity.toFixed(0).padStart(5)}px/s)`,
        `floor ${floor.toFixed(1).padStart(5)}px`,
        cycle.clearance >= floor ? 'ok  ' : 'FAIL',
        `worst course ${courseLabel(cycle.course).padEnd(7)}`,
        cycle.collectable ? '' : '(ring uncollectable on it)',
        `pinned ${(SELF_CONSISTENT_WORST_GATE[elapsed] as number).toFixed(1)}px`,
        `${((Date.now() - started) / 1000).toFixed(0)}s`,
      ].join('  '),
    )
  }
  log('')
  log('  A cell crossing its floor in either direction is a change of verdict and')
  log('  goes to the CTO. Update SELF_CONSISTENT_WORST_GATE from this run.')
}
