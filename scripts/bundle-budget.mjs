#!/usr/bin/env node
/**
 * Bundle budget (spec §1, §4 step 7): fail if the shipped gzipped JS exceeds 60 KB.
 *
 * Bundle size is one of the few things that is genuinely stable in CI — unlike
 * frame timings, which are noise there and get measured by hand on a real device
 * instead. So this is a hard gate.
 *
 * Source maps are excluded: they are uploaded as CI artifacts but never published
 * to the public site (spec §7).
 */
import { gzipSync } from 'node:zlib'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const DIST = 'dist'
const BUDGET_BYTES = 60 * 1024

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

let files
try {
  files = walk(DIST)
} catch {
  console.error(`bundle-budget: ${DIST}/ not found — run \`pnpm build\` first.`)
  process.exit(1)
}

const js = files.filter((f) => f.endsWith('.js'))
if (js.length === 0) {
  console.error('bundle-budget: no JS emitted in dist/ — that is almost certainly a build bug.')
  process.exit(1)
}

let total = 0
const rows = []
for (const file of js) {
  const size = gzipSync(readFileSync(file)).length
  total += size
  rows.push([relative(DIST, file), size])
}

rows.sort((a, b) => b[1] - a[1])
const kb = (n) => `${(n / 1024).toFixed(2)} KB`
for (const [name, size] of rows) console.log(`  ${kb(size).padStart(10)}  ${name}`)
console.log(`  ${'─'.repeat(10)}`)
console.log(`  ${kb(total).padStart(10)}  total gzipped JS (budget ${kb(BUDGET_BYTES)})`)

if (total > BUDGET_BYTES) {
  console.error(
    `\nbundle-budget: FAIL — ${kb(total)} exceeds the ${kb(BUDGET_BYTES)} budget by ${kb(total - BUDGET_BYTES)}.\n` +
      'The budget is in the signed-off spec (§1). Raising it is a spec revision, not a build fix.',
  )
  process.exit(1)
}

console.log(`\nbundle-budget: OK — ${kb(BUDGET_BYTES - total)} of headroom remaining.`)
