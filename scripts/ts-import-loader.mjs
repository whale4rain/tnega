import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    const candidate = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL)
    if (specifier.endsWith('.js') && existsSync(fileURLToPath(candidate))) {
      return nextResolve(specifier.replace(/\.js$/, '.ts'), context)
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
  return nextLoad(url, context)
}
