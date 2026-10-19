/**
 * Gate and thermal generation, the reachability invariant, and the side/centre
 * rule (spec §2.3).
 *
 * The fairness rule. With net acceleration a = NET_LIFT_ACCEL (1400) and speed
 * clamp vmax = VY_CLAMP (560), the distance the kite can cover *and settle at*
 * within the inter-gate time T is
 *
 *   reach(T)          = (vmax² >= a·T·vmax/2) ? a·T²/4 : vmax·T - vmax²/a
 *   maxCentreDelta(T) = clamp(REACH_HEADROOM · reach(T), 60, 420)
 *
 * The spawner must never place consecutive gap centres further apart than
 * `maxCentreDelta`. The 0.5 headroom is deliberate: a course that is only just
 * flyable is not fun. See MAX_CENTRE_DELTA_MIN on why that lower clamp is 60 and
 * not v1's 120 — at 120 it would have started *overriding* the formula from
 * about t = 124 s under the new ramp, which is the one way a guard can become
 * the bug it was guarding against.
 *
 * **What is new in v2: the ring and the course compete for the same vertical
 * budget.** Between two gates the kite has `reach(T)` of settled travel. The
 * course asks for some of it (the change in gap centre); a collecting line asks
 * for the rest (out to the ring and back). On a gate where the centre jumps a
 * long way *toward* the ring, both bills come due at once: the previous gap sat
 * on the far side, so the course move and the detour add rather than cancel,
 * and the ring stops being takeable at any survivable clearance — fake in the
 * other direction, which the brief rules out as firmly as making it free. So
 * the gap may move away from the ring's side freely, and *toward* it by at most
 * 30·(1 - q) px.
 *
 * The side itself stays a fair coin and so does the direction, so the course is
 * unbiased over a run and half of all gates are "tight" (flat approach,
 * expensive ring) while half are "swinging" (a big course move, cheap ring).
 * That 50/50 is by construction, at every difficulty.
 *
 * **What is new in v2.1: the away-magnitude is drawn from `[q·cap, cap]`** —
 * see `magnitudeFloor`. The caps and the draw order are unchanged, and the rule
 * is exactly inert for all `t <= 90`. It exists because the fairness derivation
 * in §2.4 is done for the hardest legal gate and the generator was almost never
 * building one.
 *
 * A property test over 10,000 seeds asserts all of it, plus that the gap sits
 * inside the field, that every ring's disc lies entirely outside its gap band,
 * that the gap's centre line never collects, that the ring clears both columns
 * by 7 px, and that its centre stays inside [72, 872] (spec §3). That test is
 * what protects us against "unwinnable run" bug reports in both directions.
 *
 * `T` is taken as `spawnInterval(elapsed)` — the interval at the moment the
 * *later* gate is created. Because the interval only ever shrinks, that is the
 * conservative choice: the player always has at least that long between the two
 * gaps arriving.
 */

import {
  GAP_Y_MAX_EDGE,
  GAP_Y_MIN,
  GATE_SPAWN_X,
  MAX_CENTRE_DELTA_MAX,
  MAX_CENTRE_DELTA_MIN,
  NET_LIFT_ACCEL,
  REACH_HEADROOM,
  THERMAL_RADIUS,
  THERMAL_TOWARD_DELTA,
  THERMAL_Y_MAX,
  THERMAL_Y_MIN,
  VY_CLAMP,
} from './constants.js'
import { gapHeight, secondProgress, spawnInterval, thermalOutset } from './difficulty.js'
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

/**
 * How far the gap centre may move *toward* the ring's side at this difficulty.
 *
 * 30 px for the whole of phase 1, shrinking to 0 as phase 2 tightens — by the
 * endgame a gate that carries a ring below you cannot also drop beneath you.
 */
export function thermalTowardDelta(elapsed: number): number {
  return THERMAL_TOWARD_DELTA * (1 - secondProgress(elapsed))
}

/**
 * The low end of the magnitude draw, in px (spec §2.3, the magnitude rule).
 *
 * An away-move is drawn from `[q·cap, cap]` rather than `[0, cap]`, so the
 * typical gate closes on the hardest legal one as phase 2 tightens and reaches
 * it only in the limit. A toward-move is unchanged: `[0, capToward]`.
 *
 * **Inert for the whole of phase 1**, because `q` is 0 for all `t <= 90` — which
 * is why the teaching ramp, the cost table of §2.2 and the golden replay are
 * untouched by this rule. That inertness is asserted directly, both here in
 * tests/spawner.test.ts and by the golden replay continuing to pass unchanged;
 * a v2.1 golden that *did* move would mean the rule had leaked into phase 1.
 *
 * Why it is free: `capAway` **is** the fairness bound — it is the reachability
 * limit `maxCentreDelta(T)`, and §2.4's interval floor is derived for exactly
 * that gate. Drawing from `[q·cap, cap] ⊂ [0, cap]` therefore cannot produce a
 * gate that was not already legal and already reachable. No constant moves.
 *
 * Why it was needed: with the magnitude uniform on `[0, cap]` the mean move is
 * `cap/2`, which peaks the kite at 238 px/s instead of the 336 px/s the gap
 * floor was derived against — so the whole fairness derivation was being done
 * for a gate the generator almost never built.
 */
export function magnitudeFloor(elapsed: number, toward: boolean, cap: number): number {
  return toward ? 0 : secondProgress(elapsed) * cap
}

/** The y of the middle of a gate's gap. */
export function gapCentre(gate: Gate): number {
  return gate.gapY + gate.gapHeight / 2
}

/**
 * Lowest gap centre that keeps both the gap and *either* possible ring inside
 * the field, for this gap height and outset.
 *
 * Lemma (spec §2.3): the band [minCentre, maxCentre] is non-empty iff
 * `h + 2E <= 800`. The maximum of `h + 2E` over the whole ramp is 260 + 152 =
 * 412, at t = 0, and it decreases from there — so the band is never empty, by a
 * factor of two, and the ring's side can stay a fair coin at every difficulty.
 */
export function minCentre(height: number, outset: number): number {
  return Math.max(GAP_Y_MIN + height / 2, THERMAL_Y_MIN + outset + height / 2)
}

/** Highest gap centre that keeps both the gap and either possible ring inside the field. */
export function maxCentre(height: number, outset: number): number {
  return Math.min(GAP_Y_MAX_EDGE - height / 2, THERMAL_Y_MAX - outset - height / 2)
}

/**
 * Generate the next gate.
 *
 * **The RNG draw order is load-bearing for the golden replay, so it is specified
 * rather than left to the implementation** (spec §2.3): side, then direction,
 * then magnitude. Reordering these is a gameplay change and will fail
 * tests/determinism.test.ts, which is the intended behaviour.
 *
 * @param rng            generator state; thread the returned one through
 * @param id             id for the new gate
 * @param elapsed        run time, drives gap height, outset and spawn interval
 * @param previousCentre gap centre of the previous gate, or null for the first gate
 */
export function spawnGate(
  rng: Rng,
  id: number,
  elapsed: number,
  previousCentre: number | null,
): [Rng, Gate] {
  const height = gapHeight(elapsed)
  const outset = thermalOutset(elapsed)
  const low = minCentre(height, outset)
  const high = maxCentre(height, outset)

  // Draw 1: which side of the gap the ring sits on. A fair coin, always, so the
  // course has no vertical bias over a run.
  const [afterSide, below] = nextBool(rng)
  const u = below ? 1 : -1

  let next: Rng
  let centre: number
  if (previousCentre === null) {
    // First gate of a run: nothing to be reachable from, so the whole legal band
    // is in play.
    ;[next, centre] = nextRange(afterSide, low, high)
  } else {
    const capAway = maxCentreDelta(spawnInterval(elapsed))
    const capToward = Math.min(capAway, thermalTowardDelta(elapsed))
    // Draw 2: direction, relative to the ring's side. Also a fair coin, which is
    // what makes exactly half the gates tight and half of them swinging.
    const [afterToward, toward] = nextBool(afterSide)
    // Draw 3: magnitude, inside whichever cap this direction earns. The range's
    // *low* end is the v2.1 magnitude rule — zero for a toward-move and for the
    // whole of phase 1, rising to the cap itself as phase 2 tightens. The draw
    // order is unchanged; only this range moves.
    const cap = toward ? capToward : capAway
    const [afterMag, magnitude] = nextRange(afterToward, magnitudeFloor(elapsed, toward, cap), cap)
    next = afterMag
    // Clamping into the legal band can only *shorten* a move, so it can never
    // violate the reachability cap — which is why field bounds and reachability
    // cannot fight here the way they could in v1.
    const moved = previousCentre + (toward ? 1 : -1) * u * magnitude
    centre = Math.min(Math.max(moved, low), high)
  }

  return [
    next,
    {
      id,
      x: GATE_SPAWN_X,
      gapY: centre - height / 2,
      gapHeight: height,
      thermal: {
        // Outside the gap band, by at least THERMAL_RADIUS. This is the
        // invariant that replaces v1's "strictly inside its gap".
        y: centre + u * (height / 2 + outset),
        radius: THERMAL_RADIUS,
        collected: false,
      },
      passed: false,
    },
  ]
}
