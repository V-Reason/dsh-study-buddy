/**
 * ESM host build for dsh-study-buddy (host-only plugin; no client half).
 * Bundles own sources into one file; @deepseek-ai/* stay external (the
 * profile's node_modules provides them). tsc then emits declarations.
 */
import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

mkdirSync('lib', { recursive: true })

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node22'],
  sourcemap: true,
  external: ['@deepseek-ai/cordis', '@deepseek-ai/dsh-*'],
  logLevel: 'info',
})

// 用 node 直接运行 typescript 的 bin 入口（跨平台，避免 Windows 下
// .bin/tsc 无扩展名 shell 脚本无法直接 execFileSync 的问题）
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], { stdio: 'inherit' })
