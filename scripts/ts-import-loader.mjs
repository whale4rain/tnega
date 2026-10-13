import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    for (const extension of ['.ts', '.tsx']) {
      const candidate = new URL(specifier.replace(/\.js$/, extension), context.parentURL)
      if (specifier.endsWith('.js') && existsSync(fileURLToPath(candidate))) {
        return nextResolve(specifier.replace(/\.js$/, extension), context)
      }
    }
  }
  return nextResolve(specifier, context)
}

// Match the Markdown imports embedded by production builds and Vite tests.
export async function load(url, context, nextLoad) {
  if (url.startsWith('file:') && url.endsWith('.md?raw')) {
    const content = await readFile(new URL(url), 'utf8')
    return { format: 'module', source: `export default ${JSON.stringify(content)};`, shortCircuit: true }
  }
  // Node strips types but cannot compile JSX; the TUI's components need esbuild.
  if (url.startsWith('file:') && url.endsWith('.tsx')) {
    const { transform } = await import('esbuild')
    const source = await readFile(new URL(url), 'utf8')
    const { code } = await transform(source, { loader: 'tsx', jsx: 'automatic', format: 'esm', sourcefile: fileURLToPath(url) })
    return { format: 'module', source: code, shortCircuit: true }
  }
  return nextLoad(url, context)
}
