/**
 * Does the ring's *drawn* glyph stay clear of the column's *drawn* glyph?
 *
 * The geometry in the spec is stated in collision terms — ring radius 22, column
 * left edge at `gate.x`. The renderer does not draw either of those shapes. The
 * ring is stroked with a 9 px glow around a radius that breathes to 1.05x, and
 * the column's lethal-edge cap band is drawn 6 px *wider than the column on each
 * side*. So the painted clearance is not the geometric clearance, and under a
 * tight enough lead the reward glyph can touch the hazard glyph while the
 * collision geometry is still provably clear.
 *
 * This measures the painted pixels rather than re-deriving them: it runs the real
 * `render()` against a hand-built state, records every paint op, classifies each
 * by its palette colour, rasterises, and intersects. Re-deriving the extents by
 * hand is exactly the move that has been wrong twice on this project.
 *
 * Not shipped code. `node scripts/run-tool.mjs tools/feel/ring-legibility.ts`.
 */

import { render } from '../../src/render/renderer.js'
import { PALETTE } from '../../src/render/palette.js'
import { createInitialState, thermalX, type Gate, type GameState } from '../../src/game/state.js'
import { GATE_WIDTH, THERMAL_RADIUS } from '../../src/game/constants.js'

const COLUMN_COLOURS = new Set<string>([PALETTE.column, PALETTE.columnShade, PALETTE.columnEdge])
const RING_COLOURS = new Set<string>([PALETTE.thermal, PALETTE.thermalCore])

type Op = { kind: 'rect' | 'annulus'; colour: string; a: number; b: number; c: number; d: number }

/**
 * A 2D context that paints nothing and remembers everything.
 *
 * Only the primitives the renderer actually uses are modelled as paint; the rest
 * are accepted and ignored so `render()` runs unmodified. Anything unexpected
 * throws rather than being silently dropped, so this cannot quietly stop
 * measuring the thing it claims to measure.
 */
function recorder(): { ops: Op[]; ctx: CanvasRenderingContext2D } {
  const ops: Op[] = []
  let fillStyle = '#000'
  let strokeStyle = '#000'
  let lineWidth = 1
  const stack: Array<[string, string, number]> = []
  // The current sub-path, only ever a single arc in this renderer's ring code.
  let pendingArc: { x: number; y: number; r: number } | null = null

  const ctx = {
    get fillStyle() {
      return fillStyle
    },
    set fillStyle(v: string) {
      fillStyle = v
    },
    get strokeStyle() {
      return strokeStyle
    },
    set strokeStyle(v: string) {
      strokeStyle = v
    },
    get lineWidth() {
      return lineWidth
    },
    set lineWidth(v: number) {
      lineWidth = v
    },
    globalAlpha: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    save() {
      stack.push([fillStyle, strokeStyle, lineWidth])
    },
    restore() {
      const prev = stack.pop()
      if (prev) [fillStyle, strokeStyle, lineWidth] = prev
    },
    fillRect(x: number, y: number, w: number, h: number) {
      ops.push({ kind: 'rect', colour: fillStyle, a: x, b: y, c: w, d: h })
    },
    clearRect() {},
    beginPath() {
      pendingArc = null
    },
    closePath() {},
    moveTo() {},
    lineTo() {},
    quadraticCurveTo() {},
    bezierCurveTo() {},
    arc(x: number, y: number, r: number) {
      pendingArc = { x, y, r }
    },
    ellipse(x: number, y: number, rx: number) {
      pendingArc = { x, y, r: rx }
    },
    stroke() {
      if (pendingArc) {
        ops.push({
          kind: 'annulus',
          colour: strokeStyle,
          a: pendingArc.x,
          b: pendingArc.y,
          c: pendingArc.r,
          d: lineWidth,
        })
      }
    },
    fill() {
      if (pendingArc) {
        // A filled disc is an annulus from 0 to r.
        ops.push({
          kind: 'annulus',
          colour: fillStyle,
          a: pendingArc.x,
          b: pendingArc.y,
          c: pendingArc.r / 2,
          d: pendingArc.r,
        })
      }
    },
    fillText() {},
    strokeText() {},
    measureText() {
      return { width: 0 }
    },
    translate() {},
    rotate() {},
    scale() {},
    setTransform() {},
    resetTransform() {},
    setLineDash() {},
    clip() {},
    createLinearGradient() {
      return { addColorStop() {} }
    },
    createRadialGradient() {
      return { addColorStop() {} }
    },
  }

  return { ops, ctx: ctx as unknown as CanvasRenderingContext2D }
}

/** Integer pixel keys painted by one op, restricted to a window. */
function paint(op: Op, into: Set<number>, x0: number, x1: number, y0: number, y1: number): void {
  const key = (x: number, y: number) => (y - y0) * (x1 - x0) + (x - x0)
  if (op.kind === 'rect') {
    const [rx, ry, rw, rh] = [op.a, op.b, op.c, op.d]
    for (let y = Math.max(y0, Math.floor(ry)); y < Math.min(y1, Math.ceil(ry + rh)); y += 1) {
      for (let x = Math.max(x0, Math.floor(rx)); x < Math.min(x1, Math.ceil(rx + rw)); x += 1) {
        into.add(key(x, y))
      }
    }
    return
  }
  const [cx, cy, r, lw] = [op.a, op.b, op.c, op.d]
  const outer = r + lw / 2
  const inner = Math.max(0, r - lw / 2)
  for (
    let y = Math.max(y0, Math.floor(cy - outer));
    y < Math.min(y1, Math.ceil(cy + outer));
    y += 1
  ) {
    for (
      let x = Math.max(x0, Math.floor(cx - outer));
      x < Math.min(x1, Math.ceil(cx + outer));
      x += 1
    ) {
      // Sample the pixel centre.
      const dx = x + 0.5 - cx
      const dy = y + 0.5 - cy
      const dist = Math.hypot(dx, dy)
      if (dist <= outer && dist >= inner) into.add(key(x, y))
    }
  }
}

/** One gate, placed by hand so this measures geometry rather than the spawner. */
function stateWithGate(
  gapCentre: number,
  gapHeight: number,
  outset: number,
  below: boolean,
): GameState {
  const base = createInitialState(1)
  const u = below ? 1 : -1
  const gate: Gate = {
    id: 1,
    x: 300,
    gapY: gapCentre - gapHeight / 2,
    gapHeight,
    thermal: {
      y: gapCentre + u * (gapHeight / 2 + outset),
      radius: THERMAL_RADIUS,
      collected: false,
    },
    scored: false,
    passed: false,
  } as Gate
  return { ...base, phase: 'playing', gates: [gate], elapsed: 10 }
}

/**
 * The breathe term means the painted ring is time-dependent; the worst case is
 * its maximum, so sweep a full period rather than sampling one arbitrary frame.
 */
function worstCase(state: GameState): {
  overlap: number
  gapPx: number
  ringRight: number
  columnLeft: number
} {
  let overlap = 0
  let ringRight = -Infinity
  let columnLeft = Infinity

  const gate = state.gates[0]!
  // Scoped to the ring's own neighbourhood. The HUD shares both palettes, and an
  // unscoped window would let chrome at the top of the screen answer a question
  // about a gate in the middle of it.
  const x0 = Math.floor(thermalX(gate) - 80)
  const x1 = Math.ceil(gate.x + GATE_WIDTH + 20)
  const y0 = Math.max(0, Math.floor(gate.thermal.y - 70))
  const y1 = Math.min(960, Math.ceil(gate.thermal.y + 70))

  for (let i = 0; i < 60; i += 1) {
    const time = (i / 60) * ((2 * Math.PI) / 2.1)
    const { ops, ctx } = recorder()
    render(ctx, state, { time, alpha: 0 })

    const ring = new Set<number>()
    const column = new Set<number>()
    for (const op of ops) {
      if (RING_COLOURS.has(op.colour)) paint(op, ring, x0, x1, y0, y1)
      else if (COLUMN_COLOURS.has(op.colour)) paint(op, column, x0, x1, y0, y1)
    }

    let hits = 0
    for (const p of ring) if (column.has(p)) hits += 1
    overlap = Math.max(overlap, hits)

    // Painted extents, for a readable number. Restricted to this gate's own
    // columns: other things on screen share the hazard palette (the ground band
    // among them) and would otherwise win the minimum from off to the left.
    for (const op of ops) {
      if (RING_COLOURS.has(op.colour) && op.kind === 'annulus') {
        // The HUD shares the reward palette, so scope this to the gate's ring.
        const near = Math.abs(op.b - gate.thermal.y) <= 60
        if (near) ringRight = Math.max(ringRight, op.a + op.c + op.d / 2)
      }
      if (COLUMN_COLOURS.has(op.colour) && op.kind === 'rect') {
        const nearX = op.a >= gate.x - 80 && op.a <= gate.x + GATE_WIDTH + 20
        const nearY = op.b + op.d >= y0 && op.b <= y1
        if (nearX && nearY) columnLeft = Math.min(columnLeft, op.a)
      }
    }
  }

  return { overlap, gapPx: columnLeft - ringRight, ringRight, columnLeft }
}

// --- Report -----------------------------------------------------------------

const LEAD_FROM_COLUMN_CENTRE = GATE_WIDTH / 2 + (300 - thermalX({ x: 300 }))

console.log('Painted clearance between the ring glyph and the column glyph')
console.log('(measured from the real renderer, not re-derived)\n')
console.log(`  repo thermalX      gate.x - ${300 - thermalX({ x: 300 })}`)
console.log(`  i.e. lead from the column centre-line: ${LEAD_FROM_COLUMN_CENTRE} px`)
console.log(
  `  collision clearance ring-disc to column: ${300 - thermalX({ x: 300 }) - THERMAL_RADIUS} px\n`,
)

const rows: Array<[string, number, number, boolean]> = [
  ['t=0   gap 260, E=76', 480, 260, true],
  ['t=30  gap 223, E=46', 480, 223, true],
  ['t=60  gap 187, E=28', 480, 187, true],
  ['t=90+ gap 150, E=22', 480, 150, true],
  ['t=90+ gap 150, E=22 (above)', 480, 150, false],
  ['endgame gap 110, E=22', 480, 110, true],
]

console.log('  case                         painted gap   overlapping px')
for (const [label, centre, h, below] of rows) {
  const outset = label.includes('E=76')
    ? 76
    : label.includes('E=46')
      ? 46
      : label.includes('E=28')
        ? 28
        : 22
  const r = worstCase(stateWithGate(centre, h, outset, below))
  console.log(
    `  ${label.padEnd(28)} ${r.gapPx.toFixed(1).padStart(8)} px ${String(r.overlap).padStart(12)}`,
  )
}
