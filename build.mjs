/**
 * Build the published entry point from `src/`.
 *
 * `@deepseek-ai/*` runtimes stay external: the host process already loaded the
 * harness, so importing its packages must resolve to that same single copy.
 * `./windows.ts` is a local module and is bundled in.
 */
import { build } from 'esbuild'

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  external: [
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-agent',
    '@deepseek-ai/dsh-llm',
    '@deepseek-ai/schemastery',
  ],
})
