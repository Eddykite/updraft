import { describe, expect, it } from 'vitest'
import {
  FIELD_HEIGHT,
  GATE_WIDTH,
  KITE_RADIUS,
  KITE_X,
  THERMAL_RADIUS,
} from '../src/game/constants.js'
import {
  circleIntersectsRect,
  circlesIntersect,
  gateCentreX,
  hitsGateColumns,
  touchesThermal,
} from '../src/game/collision.js'
import type { Gate, Kite } from '../src/game/state.js'

/**
 * Collision (spec §3): table-driven, with exact-touch and one-pixel-clear cases
 * on every edge. The rule the tables encode: **touching counts as a hit**.
 */

// A 100x60 rectangle at (200, 300) — nothing special about it, which is the point.
const RX = 200
const RY = 300
const RW = 100
const RH = 60
const R = 10

type Case = readonly [name: string, cx: number, cy: number, hit: boolean]

const RECT_CASES: readonly Case[] = [
  ['centre of the rect', RX + RW / 2, RY + RH / 2, true],

  // Left edge.
  ['exact touch on the left edge', RX - R, RY + RH / 2, true],
  ['one pixel clear of the left edge', RX - R - 1, RY + RH / 2, false],
  ['one pixel inside the left edge', RX - R + 1, RY + RH / 2, true],

  // Right edge.
  ['exact touch on the right edge', RX + RW + R, RY + RH / 2, true],
  ['one pixel clear of the right edge', RX + RW + R + 1, RY + RH / 2, false],
  ['one pixel inside the right edge', RX + RW + R - 1, RY + RH / 2, true],

  // Top edge.
  ['exact touch on the top edge', RX + RW / 2, RY - R, true],
  ['one pixel clear of the top edge', RX + RW / 2, RY - R - 1, false],
  ['one pixel inside the top edge', RX + RW / 2, RY - R + 1, true],

  // Bottom edge.
  ['exact touch on the bottom edge', RX + RW / 2, RY + RH + R, true],
  ['one pixel clear of the bottom edge', RX + RW / 2, RY + RH + R + 1, false],
  ['one pixel inside the bottom edge', RX + RW / 2, RY + RH + R - 1, true],

  // Corners: the diagonal cases a naive AABB-vs-AABB test gets wrong. The
  // offsets are 3-4-5 triangles so "exactly touching" is exact in floating point.
  ['exact touch on the top-left corner', RX - 6, RY - 8, true],
  ['one tenth of a pixel clear of the top-left corner', RX - 6.1, RY - 8.1, false],
  ['one tenth of a pixel inside the top-left corner', RX - 5.9, RY - 7.9, true],
  ['exact touch on the bottom-right corner', RX + RW + 8, RY + RH + 6, true],
  ['just clear of the bottom-right corner diagonally', RX + RW + 8.1, RY + RH + 6.1, false],
  ['diagonally clear of the corner although inside both edge bands', RX - R - 1, RY - R - 1, false],
]

describe('circleIntersectsRect', () => {
  it.each(RECT_CASES)('%s', (_name, cx, cy, hit) => {
    expect(circleIntersectsRect(cx, cy, R, RX, RY, RW, RH)).toBe(hit)
  })

  it('handles a degenerate zero-height rect as a line segment', () => {
    expect(circleIntersectsRect(RX, RY, R, RX, RY, RW, 0)).toBe(true)
    expect(circleIntersectsRect(RX, RY - R - 1, R, RX, RY, RW, 0)).toBe(false)
  })
})

describe('circlesIntersect', () => {
  const CIRCLE_CASES: readonly Case[] = [
    ['concentric', 0, 0, true],
    ['exact touch along x', 30, 0, true],
    ['one pixel clear along x', 31, 0, false],
    ['one pixel overlapping along x', 29, 0, true],
    ['exact touch along y', 0, -30, true],
    ['one pixel clear along y', 0, -31, false],
    ['3-4-5 triangle, exactly touching', 18, 24, true],
    ['3-4-5 triangle, just clear', 18.1, 24.1, false],
  ]

  // Radii 10 and 20, so they touch at a centre distance of exactly 30.
  it.each(CIRCLE_CASES)('%s', (_name, bx, by, hit) => {
    expect(circlesIntersect(0, 0, 10, bx, by, 20)).toBe(hit)
  })

  it('is symmetric in its arguments', () => {
    expect(circlesIntersect(5, 7, 10, 30, 7, 20)).toBe(circlesIntersect(30, 7, 20, 5, 7, 10))
  })
})

// --- the game-level wrappers -------------------------------------------------

function gate(overrides: Partial<Gate> = {}): Gate {
  return {
    id: 1,
    x: KITE_X - GATE_WIDTH / 2,
    gapY: 400,
    gapHeight: 200,
    thermal: { y: 450, radius: THERMAL_RADIUS, collected: false },
    passed: false,
    ...overrides,
  }
}

const kite = (y: number): Kite => ({ y, vy: 0 })

describe('hitsGateColumns', () => {
  const g = gate() // gap spans [400, 600], columns at x in [115, 185]

  it('is clear in the middle of the gap', () => {
    expect(hitsGateColumns(kite(500), g)).toBe(false)
  })

  it('exact touch on the upper column is a hit, one pixel of clearance is not', () => {
    expect(hitsGateColumns(kite(g.gapY + KITE_RADIUS), g)).toBe(true)
    expect(hitsGateColumns(kite(g.gapY + KITE_RADIUS + 1), g)).toBe(false)
  })

  it('exact touch on the lower column is a hit, one pixel of clearance is not', () => {
    const gapBottom = g.gapY + g.gapHeight
    expect(hitsGateColumns(kite(gapBottom - KITE_RADIUS), g)).toBe(true)
    expect(hitsGateColumns(kite(gapBottom - KITE_RADIUS - 1), g)).toBe(false)
  })

  it('misses a gate that is still to the right of the kite', () => {
    expect(hitsGateColumns(kite(100), gate({ x: KITE_X + KITE_RADIUS + 1 }))).toBe(false)
    expect(hitsGateColumns(kite(100), gate({ x: KITE_X + KITE_RADIUS }))).toBe(true)
  })

  it('misses a gate that has gone past, to one pixel', () => {
    const clear = KITE_X - KITE_RADIUS - GATE_WIDTH - 1
    expect(hitsGateColumns(kite(100), gate({ x: clear }))).toBe(false)
    expect(hitsGateColumns(kite(100), gate({ x: clear + 1 }))).toBe(true)
  })

  it('a column reaches the whole way to the bottom of the field', () => {
    expect(hitsGateColumns(kite(FIELD_HEIGHT - KITE_RADIUS), g)).toBe(true)
  })

  it('a column reaches the whole way to the top of the field', () => {
    expect(hitsGateColumns(kite(0), g)).toBe(true)
  })
})

describe('touchesThermal', () => {
  const g = gate({ x: KITE_X - GATE_WIDTH / 2 }) // thermal centred on the kite's x

  it('collects when the circles touch exactly, and not one pixel short', () => {
    expect(gateCentreX(g)).toBe(KITE_X)
    const reach = KITE_RADIUS + THERMAL_RADIUS
    expect(touchesThermal(kite(g.thermal.y - reach), g)).toBe(true)
    expect(touchesThermal(kite(g.thermal.y - reach - 1), g)).toBe(false)
    expect(touchesThermal(kite(g.thermal.y + reach), g)).toBe(true)
    expect(touchesThermal(kite(g.thermal.y + reach + 1), g)).toBe(false)
  })

  it('never re-collects an already collected thermal', () => {
    const collected = gate({ thermal: { ...g.thermal, collected: true } })
    expect(touchesThermal(kite(collected.thermal.y), collected)).toBe(false)
  })

  it('is out of reach horizontally once the gate has moved on', () => {
    const away = gate({ x: KITE_X - GATE_WIDTH / 2 - (KITE_RADIUS + THERMAL_RADIUS + 1) })
    expect(touchesThermal(kite(away.thermal.y), away)).toBe(false)
  })
})
