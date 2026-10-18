/* eslint-disable @typescript-eslint/no-unused-vars -- contract stub; remove when implemented */
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
 */

import type { Gate } from './state.js'
import type { Rng } from './rng.js'

/** Vertical distance the kite can cover and settle within time T, in px. Pure maths. */
export function reach(seconds: number): number {
  throw new Error('not implemented')
}

/** The clamped limit on the change in gap centre between consecutive gates, in px. */
export function maxCentreDelta(seconds: number): number {
  throw new Error('not implemented')
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
  throw new Error('not implemented')
}
