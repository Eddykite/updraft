/**
 * Kite integration, velocity and position clamps (spec §2).
 *
 * Acceleration is GRAVITY when the input is released and GRAVITY + LIFT_ACCEL
 * (net -1400, i.e. upward) while held. vy is clamped to ±VY_CLAMP. At the
 * ceiling the kite is soft-clamped to y = CEILING_Y with vy zeroed — a ceiling
 * touch is never fatal.
 *
 * Integration is semi-implicit Euler: velocity is advanced first, then position
 * is advanced with the *new* velocity. That makes a held climb of n steps from
 * velocity v0 land exactly on
 *
 *   vy = v0 + n·a·dt                    (before clamping)
 *   y  = y0 + dt·(n·v0 + a·dt·n(n+1)/2)
 *
 * which is what the physics tests assert against — a closed form, not a second
 * copy of this loop.
 */

import { CEILING_Y, GRAVITY, GROUND_Y, KITE_RADIUS, LIFT_ACCEL, VY_CLAMP } from './constants.js'
import type { Kite } from './state.js'

/** Vertical acceleration for this input, in px/s². Negative is upward. */
export function accelerationFor(holding: boolean): number {
  return holding ? GRAVITY + LIFT_ACCEL : GRAVITY
}

/** Advance the kite by one step. Pure; returns a new Kite. */
export function integrate(kite: Kite, holding: boolean, dt: number): Kite {
  const unclamped = kite.vy + accelerationFor(holding) * dt
  const vy = Math.min(Math.max(unclamped, -VY_CLAMP), VY_CLAMP)
  const y = kite.y + vy * dt

  // Soft ceiling: the kite stops dead against it and is free to fall away again.
  // Deliberately NOT fatal (spec §2) — punishing the top of the field would make
  // the only safe line the middle one.
  if (y <= CEILING_Y) return { y: CEILING_Y, vy: 0 }

  return { y, vy }
}

/** True when the kite's circle has reached the fatal ground line. */
export function hasHitGround(kite: Kite): boolean {
  return kite.y + KITE_RADIUS >= GROUND_Y
}
