/**
 * Run a TypeScript file under tools/ in Node.
 *
 * The game's own modules import each other with `.js` specifiers that point at
 * `.ts` files — correct for a bundler, but Node's native type stripping will not
 * follow them. So bundle first with esbuild (already present for vite) into a
 * temp file and run that. No watch mode, no config: this exists so `pnpm feel`
 * is one command rather than a paragraph in a comment thread.
 */

import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const entry = process.argv[2]
if (entry === undefined) {
  console.error('usage: node scripts/run-tool.mjs <entry.ts>')
  process.exit(2)
}

const dir = await mkdtemp(join(tmpdir(), 'updraft-tool-'))
const outfile = join(dir, 'tool.mjs')

try {
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile,
    logLevel: 'warning',
  })
  await import(pathToFileURL(outfile).href)
} finally {
  await rm(dir, { recursive: true, force: true })
}
