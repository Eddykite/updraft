/* eslint-disable @typescript-eslint/no-unused-vars -- contract stub; remove when implemented */
/**
 * Difficulty as pure functions of elapsed time (spec §2).
 *
 *   p = clamp(elapsed / 90, 0, 1)          linear, frozen at p = 1
 *   speed    = 180 + 240p                  px/s
 *   gap      = 260 - 110p                  px
 *   interval = 1.6 - 0.7p                  s
 *
 * Tested for monotonicity and for exact values at t = 0, 45, 90 and 300 (spec §3).
 */

/** Normalised difficulty progress in [0, 1]. */
export function progress(elapsed: number): number {
  throw new Error('not implemented')
}

/** Horizontal scroll speed in px/s at this elapsed time. */
export function scrollSpeed(elapsed: number): number {
  throw new Error('not implemented')
}

/** Gap height in px at this elapsed time. */
export function gapHeight(elapsed: number): number {
  throw new Error('not implemented')
}

/** Seconds between gate spawns at this elapsed time. */
export function spawnInterval(elapsed: number): number {
  throw new Error('not implemented')
}
