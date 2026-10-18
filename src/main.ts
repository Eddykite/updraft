/**
 * Bootstrap: canvas element, loop driver, visibility/pause wiring (spec §2).
 *
 * SCAFFOLD STATE — the loop, input, audio and renderer are deliberately not
 * wired up yet: `step()` and the render/io modules throw `not implemented` until
 * the simulation and shell tasks land. What this file does today is mount and
 * size the canvas correctly and paint a placeholder, so CI, the bundle budget
 * and the Playwright smoke have something real to assert against.
 *
 * The shell task replaces the placeholder paint with createLoop + createSceneHost
 * and deletes this comment.
 */

import './style.css'
import { FIELD_HEIGHT, FIELD_WIDTH } from './game/constants.js'
import { computeViewport } from './render/viewport.js'

const root = document.getElementById('app')
if (!root) throw new Error('#app missing from index.html')

const canvas = document.createElement('canvas')
canvas.id = 'game'
canvas.setAttribute('aria-label', 'UPDRAFT game canvas')
canvas.dataset['logicalWidth'] = String(FIELD_WIDTH)
canvas.dataset['logicalHeight'] = String(FIELD_HEIGHT)
root.appendChild(canvas)

const ctx = canvas.getContext('2d')
if (!ctx) throw new Error('canvas 2d context unavailable')

function resize(context: CanvasRenderingContext2D): void {
  const viewport = computeViewport(window.innerWidth, window.innerHeight, window.devicePixelRatio)
  canvas.style.width = `${viewport.cssWidth}px`
  canvas.style.height = `${viewport.cssHeight}px`
  canvas.width = viewport.pixelWidth
  canvas.height = viewport.pixelHeight
  // One transform, then everything downstream draws in logical 540x960 coordinates.
  const unit = viewport.pixelWidth / FIELD_WIDTH
  context.setTransform(unit, 0, 0, unit, 0, 0)
  paintPlaceholder(context)
}

/** Temporary: replaced by render/renderer.ts in the shell task. */
function paintPlaceholder(context: CanvasRenderingContext2D): void {
  context.fillStyle = '#10243a'
  context.fillRect(0, 0, FIELD_WIDTH, FIELD_HEIGHT)

  context.fillStyle = '#f4f7fb'
  context.textAlign = 'center'
  context.font = '600 56px system-ui, -apple-system, Segoe UI, Roboto, sans-serif'
  context.fillText('UPDRAFT', FIELD_WIDTH / 2, FIELD_HEIGHT / 2 - 20)

  context.fillStyle = '#7f9cbb'
  context.font = '400 22px system-ui, -apple-system, Segoe UI, Roboto, sans-serif'
  context.fillText('scaffold — not yet playable', FIELD_WIDTH / 2, FIELD_HEIGHT / 2 + 24)
  context.fillText(`build ${__COMMIT_SHA__}`, FIELD_WIDTH / 2, FIELD_HEIGHT - 40)
}

window.addEventListener('resize', () => {
  resize(ctx)
})
resize(ctx)

// Signals to the Playwright smoke that bootstrap completed without throwing.
document.documentElement.dataset['updraft'] = 'ready'
