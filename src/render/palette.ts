/**
 * The whole colour vocabulary of the game, in one place.
 *
 * Accessibility is non-negotiable (concept doc): the palette is colour-blind
 * safe, which here means **nothing is distinguished by hue alone**. The two
 * things that can kill you read as hazards without any colour vision at all:
 *
 *  - power-line columns are the brightest, highest-contrast shapes on screen,
 *    are solid rectangles, and carry a hatched cap band;
 *  - the ground is a solid band with a bright rule along its top edge.
 *
 * Everything safe (sky, hills, clouds) is low-contrast and sits in the dark half
 * of the value range; everything that matters sits in the light half. Thermals
 * are rings — an outline, never a filled blob — so they cannot be confused with
 * a column even in greyscale.
 *
 * There are no image files and no font files anywhere in UPDRAFT (spec §8,
 * decision 2): every one of these is painted as flat geometry in code.
 */

export const PALETTE = {
  /** Sky gradient, top to bottom. */
  skyTop: '#0a1626',
  skyBottom: '#1d3e58',

  /** Purely cosmetic background, deliberately low contrast. */
  cloud: 'rgba(214, 233, 248, 0.09)',
  hillFar: '#16354c',
  hillNear: '#0d2538',

  /** Hazard: the ground band, plus the bright rule along its top edge. */
  ground: '#07131d',
  groundEdge: '#e9b44c',

  /** Hazard: power-line columns. The brightest, highest-contrast shape on screen. */
  column: '#e9b44c',
  columnShade: '#b4842c',
  columnEdge: '#fde8b4',

  /** Reward: thermal rings. Always an outline, never a filled blob. */
  thermal: '#7fe3f0',
  thermalCore: '#eafcff',

  /** The kite. Near-white so it is legible against every background layer. */
  kite: '#f3f7fb',
  kiteShade: '#b9ccdd',
  kiteSpar: '#0a1626',
  tail: '#7fe3f0',

  /** HUD. */
  text: '#f3f7fb',
  textDim: '#8fa9c2',
  textAccent: '#e9b44c',
  panel: 'rgba(5, 14, 24, 0.72)',
} as const

/**
 * Blend two `#rrggbb` colours. `t` is clamped to [0, 1].
 *
 * Exists so an animated colour can be interpolated rather than switched at a
 * threshold — a one-frame colour change reads as a flash, which the
 * accessibility rules rule out (spec §2).
 */
export function mixHex(from: string, to: string, t: number): string {
  const amount = Math.min(Math.max(t, 0), 1)
  const a = Number.parseInt(from.slice(1), 16)
  const b = Number.parseInt(to.slice(1), 16)
  const channel = (shift: number): number => {
    const left = (a >> shift) & 0xff
    const right = (b >> shift) & 0xff
    return Math.round(left + (right - left) * amount)
  }
  const hex = ((channel(16) << 16) | (channel(8) << 8) | channel(0)).toString(16)
  return `#${hex.padStart(6, '0')}`
}
