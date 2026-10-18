/**
 * Logical 540×960 -> device pixels, letterboxed, with a DPR cap of 2 (spec §2).
 *
 * Gameplay and layout are identical on a phone and a desktop monitor: there is no
 * responsive layout logic anywhere in UPDRAFT, just one fixed field scaled to fit
 * and centred. `scale` is logical px -> CSS px; the backing store is that again
 * times the capped device pixel ratio.
 */

import { DPR_CAP, FIELD_HEIGHT, FIELD_WIDTH } from '../game/constants.js'

export interface Viewport {
  /** CSS pixel size of the canvas element. */
  readonly cssWidth: number
  readonly cssHeight: number
  /** Backing store size in device pixels. */
  readonly pixelWidth: number
  readonly pixelHeight: number
  /** Logical px -> CSS px. */
  readonly scale: number
  /** Effective device pixel ratio after the cap. */
  readonly dpr: number
}

export function computeViewport(
  availableWidth: number,
  availableHeight: number,
  devicePixelRatio: number,
): Viewport {
  const scale = Math.min(availableWidth / FIELD_WIDTH, availableHeight / FIELD_HEIGHT)
  const cssWidth = Math.floor(FIELD_WIDTH * scale)
  const cssHeight = Math.floor(FIELD_HEIGHT * scale)
  const dpr = Math.min(devicePixelRatio, DPR_CAP)
  return {
    cssWidth,
    cssHeight,
    pixelWidth: Math.floor(cssWidth * dpr),
    pixelHeight: Math.floor(cssHeight * dpr),
    scale,
    dpr,
  }
}
