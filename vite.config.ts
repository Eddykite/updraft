import { defineConfig } from 'vite'

// Spec §5, rule 1: the base path is host-neutral and read from the environment.
// Cloudflare Pages and Netlify serve from '/'; a GitHub Pages project site serves
// from '/<repo>/'. Never hardcode this — picking a host later must stay a config
// change, not a code change.
//
//   UPDRAFT_BASE=/updraft/ pnpm build
const base = process.env.UPDRAFT_BASE ?? '/'

// Spec §6, item 2: build provenance. The commit SHA is injected at build time and
// rendered in the title-screen footer so anyone can check which commit is live.
const commitSha = process.env.GITHUB_SHA ?? process.env.UPDRAFT_COMMIT_SHA ?? 'dev'

export default defineConfig({
  base,
  define: {
    __COMMIT_SHA__: JSON.stringify(commitSha.slice(0, 7)),
  },
  build: {
    target: 'es2022',
    // Spec §7: source maps are generated and uploaded as CI artifacts,
    // but are NOT published to the public site. The deploy task excludes *.map.
    sourcemap: true,
    assetsInlineLimit: 0,
    reportCompressedSize: true,
  },
})
