/* eslint-disable @typescript-eslint/no-unused-vars -- contract stub; remove when implemented */
/**
 * Score, multiplier, best, hint and mute icon (spec §2).
 *
 * Score top-centre (large), multiplier beneath it (grows and flashes on each
 * step up), best top-right, speaker icon in the top-right corner with a 44×44
 * hit area. The "hold to climb" hint fades after the first three seconds of the
 * first run.
 */

import type { GameState } from '../game/state.js'
import type { Viewport } from './viewport.js'

export interface HudModel {
  readonly best: number
  readonly muted: boolean
  readonly showHint: boolean
}

export function drawHud(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  model: HudModel,
  viewport: Viewport,
): void {
  throw new Error('not implemented')
}
