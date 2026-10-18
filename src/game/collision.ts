/* eslint-disable @typescript-eslint/no-unused-vars -- contract stub; remove when implemented */
/**
 * Collision primitives (spec §2).
 *
 * Table-driven tests cover exact-touch and one-pixel-clear cases on every edge
 * (spec §3), so be explicit about the boundary: a touch counts as a hit.
 */

import type { Gate, Kite } from './state.js'

/** Circle vs axis-aligned rectangle. Touching counts as overlapping. */
export function circleIntersectsRect(
  cx: number,
  cy: number,
  r: number,
  rx: number,
  ry: number,
  rw: number,
  rh: number,
): boolean {
  throw new Error('not implemented')
}

/** Circle vs circle. Touching counts as overlapping. */
export function circlesIntersect(
  ax: number,
  ay: number,
  ar: number,
  bx: number,
  by: number,
  br: number,
): boolean {
  throw new Error('not implemented')
}

/** True when the kite overlaps either column of this gate (fatal). */
export function hitsGateColumns(kite: Kite, gate: Gate): boolean {
  throw new Error('not implemented')
}

/** True when the kite overlaps this gate's uncollected thermal. */
export function touchesThermal(kite: Kite, gate: Gate): boolean {
  throw new Error('not implemented')
}
