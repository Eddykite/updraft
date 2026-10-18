/**
 * Difficulty as pure functions of elapsed time (spec §2).
 *
 *   p = clamp(elapsed / 90, 0, 1)          linear, frozen at p = 1
 *   speed    = 180 + 240p                  px/s
 *   gap      = 260 - 110p                  px
 *   interval = 1.6 - 0.7p                  s
 *
 * Tested for monotonicity and for exact values at t = 0, 45, 90 and 300 (spec §3).
 * Nothing here reads state: given the same elapsed time these always agree, which
 * is what lets the spawner's fairness proof be a pure calculation.
 */

import {
  DIFFICULTY_RAMP_SECONDS,
  GAP_BASE,
  GAP_RANGE,
  INTERVAL_BASE,
  INTERVAL_RANGE,
  SPEED_BASE,
  SPEED_RANGE,
} from './constants.js'

/** Normalised difficulty progress in [0, 1]. */
export function progress(elapsed: number): number {
  return Math.min(Math.max(elapsed / DIFFICULTY_RAMP_SECONDS, 0), 1)
}

/** Horizontal scroll speed in px/s at this elapsed time. */
export function scrollSpeed(elapsed: number): number {
  return SPEED_BASE + SPEED_RANGE * progress(elapsed)
}

/** Gap height in px at this elapsed time. */
export function gapHeight(elapsed: number): number {
  return GAP_BASE - GAP_RANGE * progress(elapsed)
}

/** Seconds between gate spawns at this elapsed time. */
export function spawnInterval(elapsed: number): number {
  return INTERVAL_BASE - INTERVAL_RANGE * progress(elapsed)
}
