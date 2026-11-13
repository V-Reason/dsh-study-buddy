/**
 * ESM host build for dsh-study-buddy (host-only plugin; no client half).
 * Bundles own sources into one file; @deepseek-ai/* stay external (the
 * profile's node_modules provides them). tsc then emits declarations.
 */
import { build } from 'esbuild'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'

const manifest = JSON.parse(readFileSync('package.json', 'utf8'))

mkdirSync('lib', { recursive: true })
// 清掉上一次的声明产物：删掉的模块（card/insight/template/moc/history…）如果留着
// `lib/types/*.d.ts`，消费方还是能 import 到"已经不存在的 API"——编译期零信号。
rmSync('lib/types', { recursive: true, force: true })

/** jsdom 默认样式表原本从包内文件读取；单文件产物需要把这段小资产一并内联。 */
const inlineJsdomStylesheet = {
  name: 'inline-jsdom-default-stylesheet',
  setup(build) {
    build.onLoad(
      { filter: /jsdom[\\/]lib[\\/]jsdom[\\/]living[\\/]helpers[\\/]style-rules\.js$/ },
      (args) => {
        const cssPath = resolve(dirname(args.path), '../../browser/default-stylesheet.css')
        const css = readFileSync(cssPath, 'utf8')
        const source = readFileSync(args.path, 'utf8').replace(
          /fs\.readFileSync\(\s*path\.resolve\(\s*__dirname,\s*"\.\.\/\.\.\/browser\/default-stylesheet\.css"\s*\),\s*\{\s*encoding:\s*"utf-8"\s*\}\s*\)/,
          JSON.stringify(css),
        )
        return { contents: source, loader: 'js', resolveDir: dirname(args.path) }
      },
    )
    build.onLoad(
      { filter: /jsdom[\\/]lib[\\/]jsdom[\\/]living[\\/]xhr[\\/]XMLHttpRequest-impl\.js$/ },
      (args) => {
        const source = readFileSync(args.path, 'utf8').replace(
          /const syncWorkerFile = require\.resolve \? require\.resolve\("\.\/xhr-sync-worker\.js"\) : null;/,
          'const syncWorkerFile = null;',
        )
        return { contents: source, loader: 'js', resolveDir: dirname(args.path) }
      },
    )
  },
}

const result = await build({
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node22'],
  define: {
    __DSH_STUDY_BUDDY_VERSION__: JSON.stringify(manifest.version),
  },
  sourcemap: true,
  sourcesContent: false,
  minify: true,
  legalComments: 'none',
  banner: {
    js: [
      "import { createRequire } from 'node:module';",
      "import { dirname } from 'node:path';",
      "import { fileURLToPath } from 'node:url';",
      'const require = createRequire(import.meta.url);',
      'const __filename = fileURLToPath(import.meta.url);',
      'const __dirname = dirname(__filename);',
    ].join('\n'),
  },
  plugins: [inlineJsdomStylesheet],
  external: ['@deepseek-ai/cordis', '@deepseek-ai/dsh-*'],
  logLevel: 'info',
  write: false,
})

/**
 * Windows 在 Vitest 刚退出时可能仍短暂映射旧 bundle。先生成临时文件，再重试
 * 原子替换；直接让 esbuild 覆写目标会报 "user-mapped section open"。
 */
function commitOutput(target, contents) {
  const temp = `${target}.tmp-${process.pid}`
  writeFileSync(temp, contents)
  let lastError
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      renameSync(temp, target)
      return
    } catch (error) {
      lastError = error
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
      if (!['EBUSY', 'EPERM', 'EACCES'].includes(code)) break
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
    }
  }
  rmSync(temp, { force: true })
  throw lastError
}

for (const output of result.outputFiles) {
  commitOutput(output.path, output.contents)
}

const artifact = readFileSync('lib/index.js', 'utf8')
if (/await import\(["'](?:mermaid|jsdom)["']\)/.test(artifact)) {
  throw new Error('构建产物仍含运行时 Mermaid/JSDOM 包解析；Electron 宿主会因 createRequire.resolve.paths 崩溃')
}
if (!artifact.includes('dsh-study-buddy-artifact:v') || !artifact.includes(':bundled-mermaid-jsdom')) {
  throw new Error(`构建产物缺少发布标识 dsh-study-buddy-artifact:v${manifest.version}:bundled-mermaid-jsdom`)
}

// 用 node 直接运行 typescript 的 bin 入口（跨平台，避免 Windows 下
// .bin/tsc 无扩展名 shell 脚本无法直接 execFileSync 的问题）
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], { stdio: 'inherit' })
