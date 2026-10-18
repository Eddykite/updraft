/* eslint-disable @typescript-eslint/no-unused-vars -- contract stub; remove when implemented */
/**
 * Kite integration, velocity and position clamps (spec §2).
 *
 * Acceleration is GRAVITY when the input is released and GRAVITY + LIFT_ACCEL
 * (net -1400, i.e. upward) while held. vy is clamped to ±VY_CLAMP. At the
 * ceiling the kite is soft-clamped to y = CEILING_Y with vy zeroed — a ceiling
 * touch is never fatal.
 */

import type { Kite } from './state.js'

/** Advance the kite by one step. Pure; returns a new Kite. */
export function integrate(kite: Kite, holding: boolean, dt: number): Kite {
  throw new Error('not implemented')
}

/** True when the kite's circle has reached the fatal ground line. */
export function hasHitGround(kite: Kite): boolean {
  throw new Error('not implemented')
}
