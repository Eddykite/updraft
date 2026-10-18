/**
 * Search for `e2e/game.ts`'s SCORING_TAPE. Run it with:
 *
 *   node scripts/run-tool.mjs tools/feel/tape-search.ts
 *
 * It takes a few minutes and prints a tape plus the worst case it survives. This
 * is not part of `pnpm verify` — it is the thing you run on the day the tape
 * stops scoring, which happens whenever the course changes under it.
 *
 * Hill climb rather than anything cleverer because the objective is cheap, the
 * search space is nine numbers, and the answer only has to be good enough to
 * make a screenshot show a played game. It keeps the best *worst* case (see
 * `worstCase`), so the tape it returns is one that scores on a loaded machine,
 * not one that scores on a quiet one.
 */

import { DEFAULT_SEED } from '../../e2e/game.js'
import { flyTape, mulberry, worstCase } from './tape.js'

const rng = mulberry(20261018)
let best: { tape: number[]; score: number } = { tape: [], score: -1 }

for (const length of [9, 13, 17]) {
  for (let restart = 0; restart < 30; restart += 1) {
    let tape = Array.from({ length }, () => 200 + Math.round(rng() * 500))
    let score = worstCase(tape, DEFAULT_SEED)
    for (let iteration = 0; iteration < 900; iteration += 1) {
      const i = Math.floor(rng() * tape.length)
      const candidate = [...tape]
      candidate[i] = Math.max(
        120,
        Math.min(900, (candidate[i] as number) + Math.round((rng() - 0.5) * 120)),
      )
      const next = worstCase(candidate, DEFAULT_SEED)
      // >= rather than > so the climb can drift across plateaux, which this
      // objective has a lot of: a tape only changes score when a phase boundary
      // crosses a frame that mattered.
      if (next >= score) {
        tape = candidate
        score = next
      }
    }
    if (score > best.score) best = { tape, score }
  }
}

console.log(
  `SCORING_TAPE = [${best.tape.join(', ')}]\n` +
    `  worst case over +50ms-per-phase delay: ${best.score}\n` +
    `  undelayed: ${flyTape(best.tape, DEFAULT_SEED, 0, () => 0)}`,
)
