/**
 * Gate and thermal generation, and the reachability invariant (spec §2).
 *
 * The fairness rule. With net acceleration a = NET_LIFT_ACCEL (1400) and speed
 * clamp vmax = VY_CLAMP (560), the distance the kite can cover *and settle at*
 * within the inter-gate time T is
 *
 *   reach(T)          = (vmax² >= a·T·vmax/2) ? a·T²/4 : vmax·T - vmax²/a
 *   maxCentreDelta(T) = clamp(REACH_HEADROOM · reach(T), 120, 420)
 *
 * The spawner must never place consecutive gap centres further apart than
 * `maxCentreDelta`. The 0.5 headroom is deliberate: a course that is only just
 * flyable is not fun. A property test over 10,000 seeds asserts this invariant,
 * plus that every gap sits inside field bounds and every thermal sits strictly
 * *outside* its gap (spec §3, revised) — that test is what protects us against
 * "unwinnable run" bug reports.
 *
 * `T` is taken as `spawnInterval(elapsed)` — the interval at the moment the
 * *later* gate is created. Because the interval only ever shrinks, that is the
 * conservative choice: the player always has at least that long between the two
 * gaps arriving.
 *
 * Note what the fairness rule is about and what it is not. It is about the
 * *gaps*: a course must be flyable by a player who ignores every ring. Rings are
 * optional by construction, so a ring the player cannot safely reach is a ring
 * they decline, not an unwinnable run. That separation is what lets the reward
 * layer carry real risk without the course ever becoming unfair.
 *
 * ## Where a ring goes, and why it costs something
 *
 * A ring rides THERMAL_LEAD_X px *ahead* of its gate, in the open air, at an
 * altitude THERMAL_OUTSIDE_OFFSET px beyond one edge of the gap — an altitude the
 * column will be occupying by the time the gate arrives. So the player meets the
 * ring first, leaves the line for it, and has THERMAL_LEAD_X px of travel to get
 * back before the columns.
 *
 * The cost is exact and difficulty-independent. Writing Rk for KITE_RADIUS, Rt for
 * THERMAL_RADIUS, Q for THERMAL_OUTSIDE_OFFSET and h for the gap height:
 *
 *   safe band      |y - centre| <= h/2 - Rk
 *   collects       |y - thermal.y| <= Rt + Rk,  thermal.y = centre ± (h/2 + Q)
 *   nearest line   |y - centre| = h/2 + Q - (Rt + Rk)
 *
 * so the nearest collecting altitude sits outside the safe band by exactly
 * `Q - Rt` px, for every gap height, at every point on the difficulty ramp. The
 * `h/2` cancels. That is the dual of the old placement's problem: when the ring
 * was strictly *inside* the gap the same algebra guaranteed a safe collecting
 * altitude always existed, which is why no retune of the old inset could have
 * produced a risk layer. One inequality decides which regime we are in — Q > Rt —
 * and tests/playable.test.ts sweeps it in both directions.
 *
 * ## Why THERMAL_LEAD_X is bounded on both sides
 *
 * The ring must sit in genuine open air: a player reaching for it must not be
 * inside *any* column's x-range while they do it, or the excursion would be
 * instant death rather than a risk. The kite is a circle of Rk at KITE_X and can
 * touch the ring from `Rt + Rk` away, so with L = THERMAL_LEAD_X and S the
 * distance between consecutive gates' leading edges:
 *
 *   own gate       L > (Rt + Rk) + Rk            = 54 px
 *   previous gate  L < S - GATE_WIDTH - (Rt + Rk) - Rk
 *
 * One Rk in each, not two: the ring enters reach at `Rt + Rk` from KITE_X and the
 * column has to clear the near side of the kite, which is Rk from its centre. The
 * `2·Rk` below is a different quantity — that one spans both sides of the kite.
 *
 * S is the distance scrolled in one spawn interval, `speed(p)·interval(p)` =
 * 288 + 258p - 168p², minimised at p = 0, less at most one frame of spawn jitter:
 * 288 - 420/60 = 281 px. So L < 157, and L = 110 leaves 47 px of headroom there.
 * Both inequalities are asserted from these constants in tests/spawner.test.ts,
 * so a retune that walks L through a bound fails there rather than silently
 * eating the margin.
 *
 * That headroom is spent by anything that tightens gate spacing, and the ramp is
 * the thing that would: S is *not* monotonic in p. It peaks at p = 0.77 (387 px)
 * and is already falling by p = 1 (378 px), so a post-ramp curve that keeps
 * feeding an unclamped p into the current speed/interval pair shrinks S from both
 * ends at once. The bound on L = 110 is reached at p = 1.70, and `interval(p)`
 * hits zero at p = 2.29. Whoever writes that curve owns this coupling: either
 * keep S above 234 px, or move L down with it. tests/playable.test.ts checks the
 * real simulation, but only over the ramp as it is clamped today.
 *
 * Within that window L splits a fixed budget — the open air between two gates is
 * `S - GATE_WIDTH - 2·Rk` px however L is chosen — between going out to the ring
 * and getting back. 110 favours the way back slightly, which is the leg with no
 * second chances: miss the approach and you lose a ring, miss the recovery and
 * you lose the run.
 *
 * ## Which side the ring hangs off
 *
 * The side the kite is *coming from* — the edge facing the previous gap's centre.
 * This was measured rather than assumed, and it is the difference between a
 * mechanic and a punishment. Hanging the ring off the far edge instead makes the
 * trip cost the gap-to-gap move plus the excursion, in the shorter of the two
 * legs: a model player that took every one of those rings died 82 times per 100
 * gates, against 7 for the near edge. Rings nobody can take are not a decision,
 * they are bait, and the whole point of the revision was to stop shipping a
 * thermal that is never a decision.
 *
 * On the near edge every ring is attemptable and the risk is where it should be:
 * in the overshoot and the climb out. The RNG still picks when two consecutive
 * gaps are exactly level, which is the one case with no side to come from.
 */

import {
  CEILING_Y,
  GAP_Y_MAX_EDGE,
  GAP_Y_MIN,
  GATE_SPAWN_X,
  GROUND_Y,
  MAX_CENTRE_DELTA_MAX,
  MAX_CENTRE_DELTA_MIN,
  NET_LIFT_ACCEL,
  REACH_HEADROOM,
  THERMAL_OUTSIDE_OFFSET,
  THERMAL_RADIUS,
  VY_CLAMP,
} from './constants.js'
import { gapHeight, spawnInterval } from './difficulty.js'
import type { Gate } from './state.js'
import { nextBool, nextRange, type Rng } from './rng.js'

/** Vertical distance the kite can cover and settle within time T, in px. Pure maths. */
export function reach(seconds: number): number {
  if (seconds <= 0) return 0
  const a = NET_LIFT_ACCEL
  const vmax = VY_CLAMP
  // Triangular profile (never reaches the speed clamp) vs trapezoidal (does).
  return vmax * vmax >= (a * seconds * vmax) / 2
    ? (a * seconds * seconds) / 4
    : vmax * seconds - (vmax * vmax) / a
}

/** The clamped limit on the change in gap centre between consecutive gates, in px. */
export function maxCentreDelta(seconds: number): number {
  const raw = REACH_HEADROOM * reach(seconds)
  return Math.min(Math.max(raw, MAX_CENTRE_DELTA_MIN), MAX_CENTRE_DELTA_MAX)
}

/** The y of the middle of a gate's gap. */
export function gapCentre(gate: Gate): number {
  return gate.gapY + gate.gapHeight / 2
}

/** Lowest gap centre that keeps the whole gap inside the field, for this gap height. */
export function minCentre(height: number): number {
  return GAP_Y_MIN + height / 2
}

/** Highest gap centre that keeps the whole gap inside the field, for this gap height. */
export function maxCentre(height: number): number {
  return GAP_Y_MAX_EDGE - height / 2
}

/** Lowest ring centre that keeps the whole ring in open air below the ceiling. */
export const THERMAL_Y_MIN = CEILING_Y + THERMAL_RADIUS
/** Highest ring centre that keeps the whole ring in open air above the ground. */
export const THERMAL_Y_MAX = GROUND_Y - THERMAL_RADIUS

/**
 * Which side of the gap the ring hangs off: the one the kite is coming from.
 * The RNG only breaks the tie when the two gaps are exactly level.
 */
export function approachesFromBelow(
  previousCentre: number | null,
  centre: number,
  fallback: boolean,
): boolean {
  if (previousCentre === null || previousCentre === centre) return fallback
  return previousCentre > centre
}

/**
 * The ring's altitude: `THERMAL_OUTSIDE_OFFSET` px beyond one edge of the gap,
 * on the side the kite is coming from — unless that side would put it outside
 * the field, in which case it goes on the other side.
 *
 * The flip is never ambiguous, because both sides can only fail at once when
 *
 *   centre - h/2 - Q < THERMAL_Y_MIN  and  centre + h/2 + Q > THERMAL_Y_MAX
 *
 * which needs `THERMAL_Y_MAX - THERMAL_Y_MIN < h + 2Q`, i.e. 856 < h + 120. The
 * widest gap the ramp ever produces is 260. The sweep in tests/spawner.test.ts
 * checks every (h, centre) the game can reach rather than taking my word for it.
 */
export function thermalY(centre: number, height: number, below: boolean): number {
  const offset = height / 2 + THERMAL_OUTSIDE_OFFSET
  const preferred = below ? centre + offset : centre - offset
  const inField = preferred >= THERMAL_Y_MIN && preferred <= THERMAL_Y_MAX
  return inField ? preferred : centre + (below ? -offset : offset)
}

/**
 * Generate the next gate.
 *
 * @param rng            generator state; thread the returned one through
 * @param id             id for the new gate
 * @param elapsed        run time, drives gap height and spawn interval
 * @param previousCentre gap centre of the previous gate, or null for the first gate
 */
export function spawnGate(
  rng: Rng,
  id: number,
  elapsed: number,
  previousCentre: number | null,
): [Rng, Gate] {
  const height = gapHeight(elapsed)
  const floor = minCentre(height)
  const ceiling = maxCentre(height)

  let low = floor
  let high = ceiling
  if (previousCentre !== null) {
    const delta = maxCentreDelta(spawnInterval(elapsed))
    low = Math.max(low, previousCentre - delta)
    high = Math.min(high, previousCentre + delta)
    if (low > high) {
      // Only reachable if a caller hands us a previous centre that is already
      // outside the legal band for this gap height. Field bounds win — place the
      // gap as close to the previous centre as the field allows, which is still
      // the most reachable gate available.
      low = high = Math.min(Math.max(previousCentre, floor), ceiling)
    }
  }

  const [afterCentre, centre] = nextRange(rng, low, high)
  const [afterSide, below] = nextBool(afterCentre)

  return [
    afterSide,
    {
      id,
      x: GATE_SPAWN_X,
      gapY: centre - height / 2,
      gapHeight: height,
      thermal: {
        y: thermalY(centre, height, approachesFromBelow(previousCentre, centre, below)),
        radius: THERMAL_RADIUS,
        collected: false,
      },
      passed: false,
    },
  ]
}
