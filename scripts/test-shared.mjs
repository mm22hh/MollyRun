import { spawnSync } from 'node:child_process'
import { build } from 'esbuild'

await build({
  entryPoints: ['src/shared/model.test.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'out/model.test.cjs'
})

const result = spawnSync(process.execPath, ['--test', 'out/model.test.cjs'], { stdio: 'inherit' })
process.exit(result.status ?? 1)
