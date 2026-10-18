/**
 * Score, multiplier, best, hint, mute icon — and the three screens (spec §2).
 *
 * Score top-centre (large), multiplier beneath it (grows on each step up), best
 * top-right, speaker icon in the top-right corner with a 44×44 hit area. The
 * "hold to climb" hint fades after the first three seconds of the first run.
 *
 * The screen cards (Title, Paused, Game Over) live here rather than in
 * renderer.ts because they are chrome, not world: renderer.ts draws the field
 * and nothing else, this file draws everything that sits on top of it. Both work
 * in logical 540 × 960 coordinates.
 *
 * System font stack only — there are no font files in UPDRAFT (spec §8,
 * decision 2). Nothing on this layer flashes: the multiplier *grows* and
 * brightens once per step up over a fifth of a second, and the prompts breathe
 * at well under 1 Hz (accessibility, non-negotiable).
 */

import { FIELD_HEIGHT, FIELD_WIDTH, MUTE_HIT_AREA } from '../game/constants.js'
import type { GameState } from '../game/state.js'
import { mixHex, PALETTE } from './palette.js'

/** No font files: the system UI stack, which is already on every device. */
const FONT = `system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`

/**
 * The speaker's hit area in logical pixels — 44 × 44, the minimum touch target.
 *
 * io/input.ts imports this to hit-test taps, so the drawn icon and the tappable
 * box can never drift apart.
 */
export const MUTE_BUTTON = {
  x: FIELD_WIDTH - 16 - MUTE_HIT_AREA,
  y: 16,
  width: MUTE_HIT_AREA,
  height: MUTE_HIT_AREA,
} as const

export interface HudModel {
  readonly best: number
  readonly muted: boolean
  /** The "hold to climb" hint is shown for the first HINT_FADE_SECONDS of the first run only. */
  readonly showHint: boolean
  /** 1 → 0 as the hint fades out. */
  readonly hintAlpha: number
  /** 1 → 0 after a multiplier step up; drives a single grow-and-brighten, never a flash. */
  readonly multiplierPulse: number
  /** True when this run's score beat the stored best. */
  readonly newBest: boolean
  /** False during the 400 ms game-over input lock, so the prompt does not lie. */
  readonly restartReady: boolean
  /** Seconds since boot, for the slow breathing of the prompts. */
  readonly time: number
  /** Commit SHA injected at build time (spec §6, item 2). */
  readonly build: string
}

export function drawHud(ctx: CanvasRenderingContext2D, state: GameState, model: HudModel): void {
  ctx.save()
  ctx.textAlign = 'center'
  ctx.textBaseline = 'alphabetic'

  switch (state.phase) {
    case 'title':
      drawTitleCard(ctx, model)
      break
    case 'playing':
      drawPlayingHud(ctx, state, model)
      break
    case 'paused':
      drawPlayingHud(ctx, state, model)
      drawPausedCard(ctx)
      break
    case 'gameover':
      drawPlayingHud(ctx, state, model)
      drawGameOverCard(ctx, state, model)
      break
  }

  drawBest(ctx, model.best)
  drawMuteButton(ctx, model.muted)
  ctx.restore()
}

// --- live HUD ----------------------------------------------------------------

/**
 * Centre of the "hold to climb" hint, deliberately NOT the centre of the field.
 *
 * The kite flies at a fixed x of KITE_X (150) and roams the full height, so a
 * centred hint is text the kite falls straight through — which is exactly what
 * it did on the first screenshot of a real run. Both lines are under 180px wide,
 * so centring them here keeps them clear of the kite and its tail (which trails
 * to the *left*, making the right side of the field the safe one) at every
 * altitude, without moving the hint around as the kite moves.
 */
const HINT_X = 350

function drawPlayingHud(ctx: CanvasRenderingContext2D, state: GameState, model: HudModel): void {
  ctx.save()
  // A soft drop shadow is what keeps white text legible over a bright column.
  ctx.shadowColor = 'rgba(3, 10, 18, 0.85)'
  ctx.shadowBlur = 12

  ctx.fillStyle = PALETTE.text
  ctx.font = `700 76px ${FONT}`
  ctx.fillText(String(state.score), FIELD_WIDTH / 2, 100)

  // Grows and brightens on each step up, then settles. One pulse, no repeat.
  const pulse = clamp01(model.multiplierPulse)
  ctx.save()
  ctx.translate(FIELD_WIDTH / 2, 142)
  ctx.scale(1 + pulse * 0.35, 1 + pulse * 0.35)
  // Interpolated, not switched: a `pulse > 0 ?` test makes the colour pop back
  // in a single frame at the end of each pulse, which contradicts "grows and
  // brightens, then settles" and is the one bit of the HUD that read as a flash.
  ctx.fillStyle = mixHex(PALETTE.textAccent, PALETTE.thermalCore, pulse)
  ctx.font = `700 30px ${FONT}`
  ctx.fillText(`×${state.multiplier}`, 0, 0)
  ctx.restore()

  if (model.showHint && model.hintAlpha > 0) {
    ctx.globalAlpha = clamp01(model.hintAlpha)
    ctx.fillStyle = PALETTE.text
    ctx.font = `600 26px ${FONT}`
    ctx.fillText('hold to climb', HINT_X, 620)
    ctx.globalAlpha = clamp01(model.hintAlpha) * 0.75
    ctx.font = `400 20px ${FONT}`
    ctx.fillText('let go to glide', HINT_X, 652)
  }
  ctx.restore()
}

function drawBest(ctx: CanvasRenderingContext2D, best: number): void {
  ctx.save()
  ctx.textAlign = 'right'
  ctx.fillStyle = PALETTE.textDim
  ctx.font = `600 20px ${FONT}`
  ctx.shadowColor = 'rgba(3, 10, 18, 0.85)'
  ctx.shadowBlur = 10
  ctx.fillText(`BEST ${best}`, FIELD_WIDTH - 16, 82)
  ctx.restore()
}

/**
 * The speaker, drawn inside its 44 × 44 touch target.
 *
 * Muted is a drawn slash, not a colour change: the state has to be readable
 * without colour vision and at a glance on a phone.
 */
function drawMuteButton(ctx: CanvasRenderingContext2D, muted: boolean): void {
  const cx = MUTE_BUTTON.x + MUTE_BUTTON.width / 2
  const cy = MUTE_BUTTON.y + MUTE_BUTTON.height / 2

  ctx.save()
  ctx.fillStyle = PALETTE.panel
  roundedRect(ctx, MUTE_BUTTON.x, MUTE_BUTTON.y, MUTE_BUTTON.width, MUTE_BUTTON.height, 12)
  ctx.fill()

  ctx.fillStyle = muted ? PALETTE.textDim : PALETTE.text
  ctx.strokeStyle = muted ? PALETTE.textDim : PALETTE.text
  ctx.lineWidth = 2.4
  ctx.lineCap = 'round'

  // Cone.
  ctx.beginPath()
  ctx.moveTo(cx - 9, cy - 4)
  ctx.lineTo(cx - 4, cy - 4)
  ctx.lineTo(cx + 2, cy - 10)
  ctx.lineTo(cx + 2, cy + 10)
  ctx.lineTo(cx - 4, cy + 4)
  ctx.lineTo(cx - 9, cy + 4)
  ctx.closePath()
  ctx.fill()

  if (muted) {
    ctx.beginPath()
    ctx.moveTo(cx + 6, cy - 6)
    ctx.lineTo(cx + 14, cy + 6)
    ctx.moveTo(cx + 14, cy - 6)
    ctx.lineTo(cx + 6, cy + 6)
    ctx.stroke()
  } else {
    for (let i = 0; i < 2; i += 1) {
      ctx.beginPath()
      ctx.arc(cx + 2, cy, 7 + i * 5, -0.9, 0.9)
      ctx.stroke()
    }
  }
  ctx.restore()
}

// --- screens -----------------------------------------------------------------

function drawTitleCard(ctx: CanvasRenderingContext2D, model: HudModel): void {
  ctx.save()
  ctx.shadowColor = 'rgba(3, 10, 18, 0.9)'
  ctx.shadowBlur = 18

  ctx.fillStyle = PALETTE.text
  ctx.font = `800 82px ${FONT}`
  ctx.fillText('UPDRAFT', FIELD_WIDTH / 2, 360)

  ctx.fillStyle = PALETTE.textAccent
  ctx.font = `600 24px ${FONT}`
  ctx.fillText('hold to climb — let go to glide', FIELD_WIDTH / 2, 404)

  ctx.fillStyle = PALETTE.textDim
  ctx.font = `400 20px ${FONT}`
  ctx.fillText('thread the power lines, take the thermals', FIELD_WIDTH / 2, 438)

  prompt(ctx, 'press anything to fly', 560, model.time)

  // Same reasoning as the seed on the game-over card: the build string is what
  // a bug report quotes, so it has to clear AA rather than merely decorate.
  ctx.fillStyle = PALETTE.textDim
  ctx.globalAlpha = 0.9
  ctx.font = `400 16px ${FONT}`
  ctx.fillText(`build ${model.build}`, FIELD_WIDTH / 2, FIELD_HEIGHT - 44)
  ctx.restore()
}

function drawPausedCard(ctx: CanvasRenderingContext2D): void {
  ctx.save()
  ctx.fillStyle = 'rgba(5, 14, 24, 0.66)'
  ctx.fillRect(0, 0, FIELD_WIDTH, FIELD_HEIGHT)

  ctx.fillStyle = PALETTE.text
  ctx.font = `800 54px ${FONT}`
  ctx.fillText('PAUSED', FIELD_WIDTH / 2, 450)

  ctx.fillStyle = PALETTE.textDim
  ctx.font = `400 22px ${FONT}`
  ctx.fillText('press anything to resume', FIELD_WIDTH / 2, 492)
  ctx.restore()
}

function drawGameOverCard(ctx: CanvasRenderingContext2D, state: GameState, model: HudModel): void {
  ctx.save()
  ctx.fillStyle = 'rgba(5, 14, 24, 0.72)'
  ctx.fillRect(0, 0, FIELD_WIDTH, FIELD_HEIGHT)

  ctx.fillStyle = PALETTE.panel
  roundedRect(ctx, 52, 300, FIELD_WIDTH - 104, 332, 26)
  ctx.fill()

  ctx.fillStyle = PALETTE.textDim
  ctx.font = `600 22px ${FONT}`
  ctx.fillText(
    state.crashCause === 'ground' ? 'DOWN IN THE FIELD' : 'INTO THE LINES',
    FIELD_WIDTH / 2,
    352,
  )

  ctx.fillStyle = PALETTE.text
  ctx.font = `800 92px ${FONT}`
  ctx.fillText(String(state.score), FIELD_WIDTH / 2, 448)

  if (model.newBest) {
    ctx.fillStyle = PALETTE.textAccent
    ctx.font = `700 28px ${FONT}`
    ctx.fillText('NEW BEST!', FIELD_WIDTH / 2, 492)
  } else {
    ctx.fillStyle = PALETTE.textDim
    ctx.font = `500 24px ${FONT}`
    ctx.fillText(`best ${model.best}`, FIELD_WIDTH / 2, 492)
  }

  // The seed makes a bug report reproducible (spec §2, determinism) — which
  // means someone has to be able to *read* it. At alpha 0.55 this was ~3.1:1
  // against the panel, under the 4.5:1 AA floor for functional text.
  ctx.fillStyle = PALETTE.textDim
  ctx.globalAlpha = 0.9
  ctx.font = `400 15px ${FONT}`
  ctx.fillText(`seed ${state.seed} · build ${model.build}`, FIELD_WIDTH / 2, 604)
  ctx.globalAlpha = 1

  // The prompt appears only once the 400 ms lock has expired, so it never
  // invites a press the game is still ignoring.
  if (model.restartReady) prompt(ctx, 'press anything to fly again', 548, model.time)
  ctx.restore()
}

// --- helpers -----------------------------------------------------------------

/** A prompt that breathes at ~0.4 Hz. Slow on purpose: nothing in UPDRAFT flashes. */
function prompt(ctx: CanvasRenderingContext2D, text: string, y: number, time: number): void {
  ctx.save()
  ctx.globalAlpha = 0.72 + Math.sin(time * 2.4) * 0.26
  ctx.fillStyle = PALETTE.text
  ctx.font = `600 26px ${FONT}`
  ctx.fillText(text, FIELD_WIDTH / 2, y)
  ctx.restore()
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + width, y, x + width, y + height, radius)
  ctx.arcTo(x + width, y + height, x, y + height, radius)
  ctx.arcTo(x, y + height, x, y, radius)
  ctx.arcTo(x, y, x + width, y, radius)
  ctx.closePath()
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value
}
