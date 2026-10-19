/**
 * Difficulty as pure functions of elapsed time (spec §2.4).
 *
 *   p = clamp(elapsed / 90, 0, 1)                   phase 1 — the teaching ramp
 *   q = max(0, 1 - 2^(-(elapsed - 90) / 60))        phase 2 — no top
 *
 *   speed    = 180 + 240p + 140q     px/s     180 … 420 … → 560
 *   gap      = 260 - 110p -  40q     px       260 … 150 … → 110
 *   interval = 1.6  - 0.7p  - 0.22q  s        1.6 … 0.9 … → 0.68
 *   outset E = 22 + 54·(1 - p)²      px        76 …  22 … → 22
 *
 * **There is no branch at t = 90.** `q` is 0 for all `t <= 90` and `p` is 1 for
 * all `t >= 90`, so each parameter is one sum of two independent terms and
 * continuity at the junction is a property of the arithmetic rather than of a
 * conditional somebody might get wrong. The `Math.max` in `secondProgress` is
 * the clamp on q itself, in the same spirit as the clamp on p.
 *
 * A continued linear ramp would hit a wall and need a second freeze, or walk
 * straight through the physical limits. An asymptote keeps tightening strictly,
 * at every t, while never crossing one — which is what a leaderboard needs,
 * because there is no plateau to settle into. All three parameters keep moving:
 * freezing any one of them would let the course settle into a fixed character
 * that can be learned once and then merely endured.
 *
 * `thermalOutset` is quadratic rather than linear so that E lands on its floor
 * with zero slope, which is what keeps the published cost table monotone through
 * the phase junction (spec §2.2).
 *
 * Nothing here reads state: given the same elapsed time these always agree,
 * which is what lets the spawner's fairness proof be a pure calculation.
 */

import {
  DIFFICULTY_RAMP_SECONDS,
  GAP_BASE,
  GAP_RANGE,
  GAP_RANGE_2,
  INTERVAL_BASE,
  INTERVAL_RANGE,
  INTERVAL_RANGE_2,
  SECOND_RAMP_HALF_LIFE,
  SPEED_BASE,
  SPEED_RANGE,
  SPEED_RANGE_2,
  THERMAL_OUTSET_FLOOR,
  THERMAL_OUTSET_RANGE,
} from './constants.js'

/** Phase-1 progress in [0, 1]. Reaches 1 at t = 90 s and stays there. */
export function progress(elapsed: number): number {
  return Math.min(Math.max(elapsed / DIFFICULTY_RAMP_SECONDS, 0), 1)
}

/**
 * Phase-2 progress in [0, 1). Zero until t = 90 s, then closes half the
 * remaining distance to the floors every SECOND_RAMP_HALF_LIFE seconds.
 *
 * It approaches 1 and, in exact arithmetic, never arrives. In float64 the
 * difference stops resolving at about t = 3.2 ks (2^-51 of the range falls below
 * one ulp of the sum), from which point the parameters are saturated rather than
 * merely close; the difficulty test pins that and says so, since a limit the
 * machine reaches is worth knowing about even when the maths does not.
 */
export function secondProgress(elapsed: number): number {
  return Math.max(0, 1 - 2 ** (-(elapsed - DIFFICULTY_RAMP_SECONDS) / SECOND_RAMP_HALF_LIFE))
}

/** Horizontal scroll speed in px/s at this elapsed time. */
export function scrollSpeed(elapsed: number): number {
  return SPEED_BASE + SPEED_RANGE * progress(elapsed) + SPEED_RANGE_2 * secondProgress(elapsed)
}

/** Gap height in px at this elapsed time. */
export function gapHeight(elapsed: number): number {
  return GAP_BASE - GAP_RANGE * progress(elapsed) - GAP_RANGE_2 * secondProgress(elapsed)
}

/** Seconds between gate spawns at this elapsed time. */
export function spawnInterval(elapsed: number): number {
  return (
    INTERVAL_BASE - INTERVAL_RANGE * progress(elapsed) - INTERVAL_RANGE_2 * secondProgress(elapsed)
  )
}

/**
 * How far beyond the gap edge the ring's centre sits, in px (spec §2.2).
 *
 * Depends on p only, so the ring has already reached its floor of 22 px by the
 * time phase 2 starts. 22 is THERMAL_RADIUS, and that is not a coincidence: at
 * the floor the ring's disc is exactly flush with the gap band, which is the
 * tightest placement for which "collecting means leaving the safe corridor"
 * still holds.
 */
export function thermalOutset(elapsed: number): number {
  const remaining = 1 - progress(elapsed)
  return THERMAL_OUTSET_FLOOR + THERMAL_OUTSET_RANGE * remaining * remaining
}
