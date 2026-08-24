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
