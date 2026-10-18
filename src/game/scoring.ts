/* eslint-disable @typescript-eslint/no-unused-vars -- contract stub; remove when implemented */
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
 */

/** Points for passing a gate at this multiplier. */
export function gateAward(multiplier: number): number {
  throw new Error('not implemented')
}

/** Points for collecting a thermal at this multiplier. */
export function thermalAward(multiplier: number): number {
  throw new Error('not implemented')
}
