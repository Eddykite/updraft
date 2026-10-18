/**
 * Bootstrap: canvas element, loop driver, visibility/pause wiring (spec §2).
 *
 * This is the only file that touches the DOM directly, and it does four things:
 * mount and size the canvas, wire the browser's events to the shell, drive the
 * fixed-timestep loop, and publish a little state onto the document so the
 * Playwright suite can assert what the game is doing without reading pixels.
 *
 * The one transform that maps logical 540 × 960 onto device pixels is applied
 * here and nowhere else — every other drawing module works in logical
 * coordinates, which is what makes the layout identical on a phone and a
 * desktop monitor with no responsive logic anywhere.
 */

import './style.css'
import { createLoop } from './app/loop.js'
import { createSceneHost } from './app/scenes.js'
import type { SceneHost, SceneStatus } from './app/scenes.js'
import { FIELD_HEIGHT, FIELD_WIDTH } from './game/constants.js'
import { createAudio } from './io/audio.js'
import { createInputSource, logicalScaleFor } from './io/input.js'
import { readMuted } from './io/storage.js'
import { computeViewport } from './render/viewport.js'

const root = document.getElementById('app')
if (!root) throw new Error('#app missing from index.html')

const canvas = document.createElement('canvas')
canvas.id = 'game'
canvas.setAttribute('aria-label', 'UPDRAFT game canvas')
canvas.dataset['logicalWidth'] = String(FIELD_WIDTH)
canvas.dataset['logicalHeight'] = String(FIELD_HEIGHT)
root.appendChild(canvas)

const context2d = canvas.getContext('2d')
if (!context2d) throw new Error('canvas 2d context unavailable')
// Bound to a non-nullable const so the closures below do not have to re-narrow it.
const ctx: CanvasRenderingContext2D = context2d

/**
 * `?seed=` makes a run reproducible: the same seed and the same inputs replay
 * exactly (spec §2). The game-over screen prints the seed, so a bug report can
 * carry one and anyone can fly the identical course.
 */
function seedFromLocation(): number {
  const requested = new URLSearchParams(window.location.search).get('seed')
  if (requested !== null) {
    const parsed = Number.parseInt(requested, 10)
    if (Number.isFinite(parsed)) return parsed >>> 0
  }
  return Date.now() >>> 0
}

const audio = createAudio(readMuted())

// input and the scene host are mutually dependent: input raises pause/mute/gesture
// at the host, and the host samples input. The host is created a few lines down.
let host: SceneHost | null = null
const input = createInputSource(canvas, {
  onPause: () => host?.pause(),
  onMuteToggle: () => host?.toggleMute(),
  onGesture: () => host?.unlockAudio(),
})

host = createSceneHost({
  input,
  audio,
  ctx,
  seed: seedFromLocation(),
  build: __COMMIT_SHA__,
  onStatusChange: publishStatus,
})

/**
 * Publish the shell's state as data attributes.
 *
 * This is the seam the Playwright suite asserts against: "the game reached game
 * over with a score" is a fact about the state, and reading it here is honest,
 * whereas OCR-ing a canvas is not. Written only when something actually changes.
 */
function publishStatus(status: SceneStatus): void {
  const dataset = document.documentElement.dataset
  dataset['updraftPhase'] = status.phase
  dataset['updraftScore'] = String(status.score)
  dataset['updraftBest'] = String(status.best)
  dataset['updraftMuted'] = String(status.muted)
}

publishStatus(host.status())

function resize(): void {
  const viewport = computeViewport(window.innerWidth, window.innerHeight, window.devicePixelRatio)
  canvas.style.width = `${viewport.cssWidth}px`
  canvas.style.height = `${viewport.cssHeight}px`
  canvas.width = viewport.pixelWidth
  canvas.height = viewport.pixelHeight
  // One transform, then everything downstream draws in logical 540x960 coordinates.
  const unit = viewport.pixelWidth / FIELD_WIDTH
  ctx.setTransform(unit, 0, 0, unit, 0, 0)
  // Taps arrive in CSS pixels and are hit-tested in logical ones.
  input.setViewport(logicalScaleFor(viewport.cssWidth))
}

window.addEventListener('resize', resize)
resize()

const loop = createLoop({
  update: (dt) => host?.update(dt),
  render: (alpha) => host?.render(alpha),
})

/**
 * A hidden tab pauses, always (spec §2).
 *
 * rAF stops firing in a backgrounded tab anyway, so the real job here is the
 * return trip: forget the minutes that passed, or the accumulator tries to
 * repay them and the player comes back to a kite that has already crashed.
 */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    host?.pause()
  } else {
    loop.resetClock()
  }
})

loop.start()

// Signals to the Playwright smoke that bootstrap completed without throwing.
document.documentElement.dataset['updraft'] = 'ready'
