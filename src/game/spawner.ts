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
 * inside its gap (spec §3) — that test is what protects us against "unwinnable
 * run" bug reports.
 *
 * `T` is taken as `spawnInterval(elapsed)` — the interval at the moment the
 * *later* gate is created. Because the interval only ever shrinks, that is the
 * conservative choice: the player always has at least that long between the two
 * gaps arriving.
 */

import {
  FIELD_WIDTH,
  GAP_Y_MAX_EDGE,
  GAP_Y_MIN,
  MAX_CENTRE_DELTA_MAX,
  MAX_CENTRE_DELTA_MIN,
  NET_LIFT_ACCEL,
  REACH_HEADROOM,
  THERMAL_EDGE_INSET,
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

  // The thermal hugs one edge of the gap but stays clear of it: the inset (45)
  // is larger than the thermal radius (22), so the ring is always strictly
  // inside the gap however tight the gap gets.
  const offset = height / 2 - THERMAL_EDGE_INSET

  return [
    afterSide,
    {
      id,
      x: FIELD_WIDTH,
      gapY: centre - height / 2,
      gapHeight: height,
      thermal: {
        y: centre + (below ? offset : -offset),
        radius: THERMAL_RADIUS,
        collected: false,
      },
      passed: false,
    },
  ]
}
