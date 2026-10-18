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
  // Derived from the width rather than floored independently. main.ts builds one
  // uniform transform from pixelWidth, so a separately floored height can miss
  // by a device pixel or two — a hairline unpainted strip along the bottom, or a
  // clipped final row of the ground band.
  const cssHeight = Math.round((cssWidth * FIELD_HEIGHT) / FIELD_WIDTH)
  // Clamped below at 1 as well as above at DPR_CAP: a zoomed-out desktop browser
  // reports a DPR under 1, which would otherwise give a backing store smaller
  // than the CSS box and a visibly soft canvas.
  const dpr = Math.min(Math.max(devicePixelRatio, 1), DPR_CAP)
  const pixelWidth = Math.floor(cssWidth * dpr)
  return {
    cssWidth,
    cssHeight,
    pixelWidth,
    // Likewise derived, so pixelHeight is exactly what the uniform transform draws.
    pixelHeight: Math.round((pixelWidth * FIELD_HEIGHT) / FIELD_WIDTH),
    scale,
    dpr,
  }
}
