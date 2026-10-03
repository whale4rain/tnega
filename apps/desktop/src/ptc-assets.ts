import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** PTC assets are shipped in extraResources, outside the bundled main process. */
export function desktopPtcAssets(runtimeRoot: string): { workerUrl: URL; wasmPath: string } {
  return {
    workerUrl: pathToFileURL(join(runtimeRoot, 'dist', 'ptc-worker.js')),
    wasmPath: join(runtimeRoot, 'dist', 'quickjs.wasm'),
  }
}
