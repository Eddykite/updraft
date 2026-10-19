/**
 * Draws a GameState to a 2D context (spec §2).
 *
 * Read-only: the renderer never mutates state and never decides anything. Flat
 * geometry drawn in code — no sprite sheets, no image files, no font files
 * (system font stack only, spec §8 decision 2). Introducing any binary asset is
 * a spec revision, not a build-task decision.
 *
 * Everything here is drawn in logical 540 × 960 coordinates. main.ts applies the
 * one transform that maps those to device pixels, so there is no responsive
 * layout logic anywhere: a phone and a desktop monitor get the identical frame,
 * letterboxed.
 *
 * Accessibility rules that constrain this file (concept doc, non-negotiable):
 * nothing flashes, nothing shakes, and the two things that can kill you — the
 * columns and the ground — are the highest-value, highest-contrast shapes on
 * screen, so they are distinguishable by shape and value with no colour vision
 * at all.
 *
 * There is deliberately no coverage gate on this directory (spec §3): asserting
 * draw calls is theatre. Its evidence is the Playwright screenshots.
 */

import {
  CEILING_Y,
  FIELD_HEIGHT,
  FIELD_WIDTH,
  GATE_WIDTH,
  GROUND_Y,
  KITE_RADIUS,
  KITE_X,
  VY_CLAMP,
} from '../game/constants.js'
import { thermalX } from '../game/collision.js'
import type { Gate, GameState, Kite } from '../game/state.js'
import { PALETTE } from './palette.js'

/** Per-frame values that are not part of the simulation: wall clock and interpolation. */
export interface Frame {
  /** Seconds since boot. Drives cosmetic motion only — never gameplay. */
  readonly time: number
  /** Fraction of a fixed step already elapsed, in [0, 1). Smooths the kite between steps. */
  readonly alpha: number
}

/** Cached per context: building a gradient every frame is pure waste. */
const skyCache = new WeakMap<CanvasRenderingContext2D, CanvasGradient>()

function sky(ctx: CanvasRenderingContext2D): CanvasGradient {
  let gradient = skyCache.get(ctx)
  if (!gradient) {
    gradient = ctx.createLinearGradient(0, 0, 0, FIELD_HEIGHT)
    gradient.addColorStop(0, PALETTE.skyTop)
    gradient.addColorStop(1, PALETTE.skyBottom)
    skyCache.set(ctx, gradient)
  }
  return gradient
}

export function render(ctx: CanvasRenderingContext2D, state: GameState, frame: Frame): void {
  ctx.save()
  ctx.fillStyle = sky(ctx)
  ctx.fillRect(0, 0, FIELD_WIDTH, FIELD_HEIGHT)

  drawClouds(ctx, state.distance, frame.time)
  drawHills(ctx, state.distance * 0.25, 720, 54, PALETTE.hillFar, 0.0)
  drawHills(ctx, state.distance * 0.45, 800, 38, PALETTE.hillNear, 1.7)

  for (const gate of state.gates) drawGate(ctx, gate, frame.time)

  drawGround(ctx, state.distance)
  drawKite(ctx, state.kite, frame)
  ctx.restore()
}

// --- background (purely cosmetic) -------------------------------------------

/** A slow drifting cloud band. Drifts on the clock as well as on distance, so the title screen breathes. */
function drawClouds(ctx: CanvasRenderingContext2D, distance: number, time: number): void {
  const period = 320
  const offset = (distance * 0.08 + time * 7) % period
  ctx.fillStyle = PALETTE.cloud
  for (let i = -1; i < Math.ceil(FIELD_WIDTH / period) + 1; i += 1) {
    const x = i * period - offset
    puff(ctx, x, 215, 54)
    puff(ctx, x + 96, 196, 38)
    puff(ctx, x + 168, 232, 30)
  }
}

function puff(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath()
  ctx.ellipse(x, y, r * 1.7, r * 0.62, 0, 0, Math.PI * 2)
  ctx.fill()
}

/**
 * One parallax layer of flat hills.
 *
 * The silhouette is a sum of two sines rather than a random walk: it has to look
 * the same every time the layer wraps, and the simulation's RNG is not available
 * here (and must not be — the renderer never draws from it).
 */
function drawHills(
  ctx: CanvasRenderingContext2D,
  scrolled: number,
  baseY: number,
  amplitude: number,
  colour: string,
  phase: number,
): void {
  const period = 1080
  const offset = scrolled % period
  ctx.fillStyle = colour
  ctx.beginPath()
  ctx.moveTo(-40, FIELD_HEIGHT)
  for (let x = -40; x <= FIELD_WIDTH + 40; x += 20) {
    const t = x + offset
    const y =
      baseY +
      Math.sin(t * 0.0062 + phase) * amplitude +
      Math.sin(t * 0.0171 + phase * 2) * (amplitude * 0.38)
    ctx.lineTo(x, y)
  }
  ctx.lineTo(FIELD_WIDTH + 40, FIELD_HEIGHT)
  ctx.closePath()
  ctx.fill()
}

// --- hazards -----------------------------------------------------------------

/**
 * A power-line gate: two flat columns with the gap between them.
 *
 * Hazard legibility, not decoration: the columns are the brightest shapes on
 * screen, they are solid rectangles (no other object in the game is), and each
 * one carries a hatched band and a bright rule on the edge that faces the gap —
 * so the lethal edge reads as an edge by shape and value alone.
 */
function drawGate(ctx: CanvasRenderingContext2D, gate: Gate, time: number): void {
  const gapBottom = gate.gapY + gate.gapHeight
  column(ctx, gate.x, 0, gate.gapY, true)
  column(ctx, gate.x, gapBottom, GROUND_Y - gapBottom, false)

  if (!gate.thermal.collected) {
    // thermalX, not the centre line: the ring leads its gate by THERMAL_LEAD and
    // sits outside the gap (spec §2.2). Drawing it anywhere else would put the
    // painted ring somewhere the simulation will not collect it, which is the
    // one class of bug a player experiences as the game lying to them.
    drawThermal(ctx, thermalX(gate), gate.thermal.y, gate.thermal.radius, time)
  }
}

function column(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  height: number,
  fromTop: boolean,
): void {
  if (height <= 0) return
  ctx.fillStyle = PALETTE.column
  ctx.fillRect(x, y, GATE_WIDTH, height)

  // A shaded right third gives the flat silhouette a direction without a sprite.
  ctx.fillStyle = PALETTE.columnShade
  ctx.fillRect(x + GATE_WIDTH * 0.66, y, GATE_WIDTH * 0.34, height)

  const edgeY = fromTop ? y + height - 14 : y
  ctx.fillStyle = PALETTE.columnEdge
  ctx.fillRect(x - 6, edgeY, GATE_WIDTH + 12, 14)

  // Hatching on the cap band: a second, non-colour cue that this is the lethal edge.
  ctx.fillStyle = PALETTE.columnShade
  for (let i = 0; i < 5; i += 1) ctx.fillRect(x - 2 + i * 15, edgeY + 3, 6, 8)

  // Insulator rungs down the shaft, so long columns do not read as flat paint.
  ctx.fillStyle = PALETTE.columnEdge
  const first = fromTop ? y + 24 : y + 30
  for (let ry = first; ry < y + height - 24; ry += 56) {
    ctx.fillRect(x + 10, ry, GATE_WIDTH - 20, 4)
  }
}

/**
 * A thermal: a glowing ring with a rising shimmer.
 *
 * Always an outline, never a filled disc — a ring is the one shape the columns
 * can never be, which is what keeps "reward" and "hazard" apart in greyscale.
 * The shimmer rises steadily; it does not flash (accessibility).
 */
function drawThermal(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  time: number,
): void {
  const breathe = 1 + Math.sin(time * 2.1) * 0.05

  ctx.save()
  ctx.strokeStyle = PALETTE.thermal
  ctx.globalAlpha = 0.35
  ctx.lineWidth = 9
  ctx.beginPath()
  ctx.arc(x, y, radius * breathe, 0, Math.PI * 2)
  ctx.stroke()

  ctx.globalAlpha = 1
  ctx.lineWidth = 3.5
  ctx.strokeStyle = PALETTE.thermalCore
  ctx.beginPath()
  ctx.arc(x, y, radius * breathe, 0, Math.PI * 2)
  ctx.stroke()

  // Three motes rising through the ring: the "updraft" read, at a calm 1.1 Hz.
  ctx.fillStyle = PALETTE.thermal
  for (let i = 0; i < 3; i += 1) {
    const t = (time * 1.1 + i / 3) % 1
    const moteY = y + radius - t * (radius * 2)
    ctx.globalAlpha = Math.sin(t * Math.PI) * 0.85
    ctx.beginPath()
    ctx.ellipse(x + Math.sin(t * 6.3 + i) * 5, moteY, 2.6, 4.2, 0, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()
}

/** The ground: a solid band with a bright rule and moving ticks for speed. */
function drawGround(ctx: CanvasRenderingContext2D, distance: number): void {
  ctx.fillStyle = PALETTE.ground
  ctx.fillRect(0, GROUND_Y, FIELD_WIDTH, FIELD_HEIGHT - GROUND_Y)

  ctx.fillStyle = PALETTE.groundEdge
  ctx.fillRect(0, GROUND_Y, FIELD_WIDTH, 3)

  ctx.save()
  ctx.globalAlpha = 0.45
  const period = 48
  const offset = distance % period
  for (let x = -period; x < FIELD_WIDTH + period; x += period) {
    ctx.fillRect(x - offset, GROUND_Y + 10, 22, 3)
  }
  ctx.restore()
}

// --- the kite ----------------------------------------------------------------

/**
 * A flat diamond with a ribbon tail that lags its motion.
 *
 * The tail is decoration and never collides — collision is the KITE_RADIUS
 * circle at the kite's centre (concept doc). Its lag is derived from vy rather
 * than from stored history, so it stays a pure function of the state: no hidden
 * renderer state to desynchronise from a replay.
 */
function drawKite(ctx: CanvasRenderingContext2D, kite: Kite, frame: Frame): void {
  // Interpolate between fixed steps so a 120 Hz display sees smooth motion.
  const y = Math.min(
    Math.max(kite.y + kite.vy * frame.alpha * (1 / 60), CEILING_Y - KITE_RADIUS),
    FIELD_HEIGHT,
  )
  const lean = Math.max(-1, Math.min(1, kite.vy / VY_CLAMP))

  drawTail(ctx, y, lean, frame.time)

  ctx.save()
  ctx.translate(KITE_X, y)
  ctx.rotate(lean * 0.42)

  const halfWidth = 17
  const halfHeight = 22
  ctx.beginPath()
  ctx.moveTo(0, -halfHeight)
  ctx.lineTo(halfWidth, 0)
  ctx.lineTo(0, halfHeight)
  ctx.lineTo(-halfWidth, 0)
  ctx.closePath()
  ctx.fillStyle = PALETTE.kite
  ctx.fill()

  // Lower half in shade: a fold, drawn as geometry rather than a gradient.
  ctx.beginPath()
  ctx.moveTo(-halfWidth, 0)
  ctx.lineTo(halfWidth, 0)
  ctx.lineTo(0, halfHeight)
  ctx.closePath()
  ctx.fillStyle = PALETTE.kiteShade
  ctx.fill()

  ctx.strokeStyle = PALETTE.kiteSpar
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(0, -halfHeight)
  ctx.lineTo(0, halfHeight)
  ctx.moveTo(-halfWidth, 0)
  ctx.lineTo(halfWidth, 0)
  ctx.stroke()
  ctx.restore()
}

function drawTail(ctx: CanvasRenderingContext2D, y: number, lean: number, time: number): void {
  const segments = 7
  ctx.save()
  ctx.strokeStyle = PALETTE.tail
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(KITE_X - 4, y + 16)
  for (let i = 1; i <= segments; i += 1) {
    const t = i / segments
    const x = KITE_X - 8 - t * 74
    // The tail hangs behind and opposite the kite's motion, with a slow ripple.
    const sag = -lean * t * 58 + Math.sin(time * 6 - i * 0.85) * (5 + t * 7)
    ctx.lineTo(x, y + 18 + t * 26 + sag)
  }
  ctx.lineWidth = 4
  ctx.globalAlpha = 0.9
  ctx.stroke()
  ctx.restore()
}
