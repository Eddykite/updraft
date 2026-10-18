import { describe, expect, it } from 'vitest'
import { computeViewport } from '../src/render/viewport.js'
import { logicalScaleFor } from '../src/io/input.js'
import { DPR_CAP, FIELD_HEIGHT, FIELD_WIDTH } from '../src/game/constants.js'

/**
 * Logical 540 × 960 -> device pixels, letterboxed, DPR capped at 2 (spec §2).
 *
 * The point of this module is that there is no responsive layout logic anywhere
 * else: a phone and a desktop monitor get the identical frame, scaled. So the
 * things worth asserting are the aspect ratio never changing, the field always
 * fitting, and the DPR cap actually capping — a 3× phone backing store is 2.25×
 * the pixels of a 2× one for no visible gain and a real frame-time cost.
 */

const ratio = FIELD_WIDTH / FIELD_HEIGHT

describe('computeViewport', () => {
  const windows: ReadonlyArray<readonly [string, number, number, number]> = [
    ['desktop 1440x900', 1440, 900, 1],
    ['desktop 1440x900 retina', 1440, 900, 2],
    ['iPhone 13 390x844', 390, 844, 3],
    ['tall and narrow', 320, 1200, 2],
    ['short and wide', 1920, 400, 1],
    ['exactly the field', 540, 960, 1],
  ]

  for (const [label, width, height, dpr] of windows) {
    it(`keeps the 9:16 field inside ${label} without stretching it`, () => {
      const viewport = computeViewport(width, height, dpr)

      expect(viewport.cssWidth).toBeLessThanOrEqual(width)
      expect(viewport.cssHeight).toBeLessThanOrEqual(height)
      expect(viewport.cssWidth / viewport.cssHeight).toBeCloseTo(ratio, 1)
      // Letterboxed, not cropped: one axis touches the window edge.
      const fills =
        Math.abs(viewport.cssWidth - width) <= 1 || Math.abs(viewport.cssHeight - height) <= 1
      expect(fills).toBe(true)
    })
  }

  it('caps the device pixel ratio at 2', () => {
    expect(computeViewport(390, 844, 3).dpr).toBe(DPR_CAP)
    expect(computeViewport(390, 844, 4).dpr).toBe(DPR_CAP)
    expect(computeViewport(390, 844, 1).dpr).toBe(1)
    expect(computeViewport(390, 844, 1.5).dpr).toBe(1.5)
  })

  it('clamps a sub-native ratio up to 1', () => {
    // A zoomed-out desktop browser reports DPR < 1. Honouring it would give a
    // backing store smaller than the CSS box, i.e. a visibly soft canvas.
    expect(computeViewport(1440, 900, 0.5).dpr).toBe(1)
    expect(computeViewport(1440, 900, 0.75).dpr).toBe(1)
  })

  it('sizes the backing store to the capped ratio', () => {
    const viewport = computeViewport(1440, 900, 3)
    expect(viewport.pixelWidth).toBe(Math.floor(viewport.cssWidth * DPR_CAP))
  })

  it('keeps the backing store exactly 9:16, so the uniform transform fills it', () => {
    // main.ts derives ONE scale factor from pixelWidth and draws 540x960 logical
    // through it. If pixelHeight were floored independently it could miss that
    // by a device pixel — a hairline unpainted strip, or a clipped bottom row.
    for (const [w, h, dpr] of [
      [1440, 900, 3],
      [390, 844, 3],
      [1000, 1000, 1],
      [333, 777, 1.5],
    ] as const) {
      const viewport = computeViewport(w, h, dpr)
      const unit = viewport.pixelWidth / 540
      expect(viewport.pixelHeight).toBe(Math.round(unit * 960))
      expect(viewport.cssHeight).toBe(Math.round((viewport.cssWidth * 960) / 540))
    }
  })

  it('scales down for a window smaller than the field, and up for a larger one', () => {
    expect(computeViewport(270, 480, 1).scale).toBeCloseTo(0.5, 5)
    expect(computeViewport(1080, 1920, 1).scale).toBeCloseTo(2, 5)
  })
})

describe('logicalScaleFor', () => {
  it('inverts the CSS scale so a tap maps back into field coordinates', () => {
    const viewport = computeViewport(390, 844, 2)
    const scale = logicalScaleFor(viewport.cssWidth)
    expect(viewport.cssWidth * scale).toBeCloseTo(FIELD_WIDTH, 5)
  })

  it('never divides by zero on a collapsed layout', () => {
    expect(logicalScaleFor(0)).toBe(1)
    expect(logicalScaleFor(-10)).toBe(1)
  })
})
