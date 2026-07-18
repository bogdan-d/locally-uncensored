// Regenerate every teaser clip that has a manifest. Serial on purpose: the
// two-pass encoder and the frame-step capture are CPU-bound anyway.
// Usage: node scripts/teasers/build-all.mjs [--fn=music]
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const only = process.argv.find((a) => a.startsWith('--fn='))?.split('=')[1]
const manifests = fs.readdirSync(path.join(HERE, 'manifests'))
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.replace(/\.json$/, ''))
  .filter((fn) => !only || fn === only)

let failed = 0
for (const fn of manifests) {
  console.log(`\n=== ${fn} ===`)
  const r = spawnSync(process.execPath, [path.join(HERE, 'render.mjs'), `--fn=${fn}`], { stdio: 'inherit' })
  if (r.status !== 0) { failed += 1; console.error(`FAILED: ${fn}`) }
}
process.exit(failed ? 1 : 0)
