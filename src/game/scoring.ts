/**
 * Score, streak and multiplier (spec §2).
 *
 *   collect a thermal        -> streak + 1
 *   pass a gate without it   -> streak = 0
 *   multiplier               = min(1 + floor(streak / 2), 5)   [see state.multiplierFor]
 *   pass a gate              -> +10 × multiplier
 *   collect a thermal        -> +5  × multiplier
 *
 * `multiplierFor` lives in state.ts because the HUD needs it too; the award
 * functions live here.
 *
 * **Which multiplier applies to a thermal.** The one you had when you took it,
 * not the one it earns you: the award is paid at the current rate and *then* the
 * streak (and possibly the multiplier) steps up. Collecting the thermal that
 * takes you from 1× to 2× pays 5, and the next thing you score pays double.
 * The spec fixes the two rules but not their order, so this is the choice, made
 * once, here, and frozen by tests and the golden replay.
 */

import { SCORE_PER_GATE, SCORE_PER_THERMAL } from './constants.js'

/** Points for passing a gate at this multiplier. */
export function gateAward(multiplier: number): number {
  return SCORE_PER_GATE * multiplier
}

/** Points for collecting a thermal at this multiplier. */
export function thermalAward(multiplier: number): number {
  return SCORE_PER_THERMAL * multiplier
}
