/**
 * Collision primitives (spec §2).
 *
 * Table-driven tests cover exact-touch and one-pixel-clear cases on every edge
 * (spec §3), so be explicit about the boundary: a touch counts as a hit. Both
 * predicates compare squared distances, so no `Math.sqrt` and no epsilon drift.
 */

import { FIELD_HEIGHT, GATE_WIDTH, KITE_RADIUS, KITE_X } from './constants.js'
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
  // Nearest point on the rectangle to the circle centre.
  const nx = Math.min(Math.max(cx, rx), rx + rw)
  const ny = Math.min(Math.max(cy, ry), ry + rh)
  const dx = cx - nx
  const dy = cy - ny
  return dx * dx + dy * dy <= r * r
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
  const dx = ax - bx
  const dy = ay - by
  const reach = ar + br
  return dx * dx + dy * dy <= reach * reach
}

/** The x of a gate's vertical centre line, where its thermal rides. */
export function gateCentreX(gate: Gate): number {
  return gate.x + GATE_WIDTH / 2
}

/** True when the kite overlaps either column of this gate (fatal). */
export function hitsGateColumns(kite: Kite, gate: Gate): boolean {
  const gapBottom = gate.gapY + gate.gapHeight
  return (
    // Upper column: the ceiling down to the top of the gap.
    circleIntersectsRect(KITE_X, kite.y, KITE_RADIUS, gate.x, 0, GATE_WIDTH, gate.gapY) ||
    // Lower column: the bottom of the gap down past the ground line. The kite
    // dies on the ground before it can reach below GROUND_Y, so the extra height
    // is never load-bearing — it just means the rectangle has no bottom edge to
    // squeeze under.
    circleIntersectsRect(
      KITE_X,
      kite.y,
      KITE_RADIUS,
      gate.x,
      gapBottom,
      GATE_WIDTH,
      FIELD_HEIGHT - gapBottom,
    )
  )
}

/** True when the kite overlaps this gate's uncollected thermal. */
export function touchesThermal(kite: Kite, gate: Gate): boolean {
  if (gate.thermal.collected) return false
  return circlesIntersect(
    KITE_X,
    kite.y,
    KITE_RADIUS,
    gateCentreX(gate),
    gate.thermal.y,
    gate.thermal.radius,
  )
}
