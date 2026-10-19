/**
 * Score, streak and multiplier (spec §2).
 *
 *   collect a thermal        -> streak + 1, capped at STREAK_MAX (8)
 *   pass a gate without it   -> streak - 2, floored at 0
 *   multiplier               = min(1 + floor(streak / 2), 5)   [see state.multiplierFor]
 *   pass a gate              -> +10 × multiplier
 *   collect a thermal        -> +5  × multiplier
 *
 * No score constant moved in v2 and none needed to. The measured payoff for
 * collecting in v1 was 1.09× — not because +5 was too small but because it was
 * never actually being paid: the safe line already took 59% of the rings, so
 * both strategies carried a multiplier. With the ring outside the gap the safe
 * line takes *zero* rings, so it is stuck at 10/gate while a sustained collector
 * holds the 5× cap and takes 75/gate. The realised payoff goes from 1.09× to
 * 7.5× with nothing here changed.
 *
 * What did change is the shape of the penalty for declining a ring — see
 * STREAK_MISS_PENALTY. A reset was harmless while the ring was free and is wrong
 * now that it is risky.
 *
 * `multiplierFor` lives in state.ts because the HUD needs it too; the award
 * functions live here.
 *
 * **Which multiplier applies to a thermal.** The one you had when you took it,
 * not the one it earns you: the award is paid at the current rate and *then* the
 * streak (and possibly the multiplier) steps up. Collecting the thermal that
 * takes you from 1× to 2× pays 5, and the next thing you score pays double.
 * v1's spec fixed the two rules but not their order, so the choice was made here
 * in code; spec v2 §2.2 ratifies it, so it is now a documented gameplay rule
 * rather than an implementation detail that tests happened to freeze.
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
