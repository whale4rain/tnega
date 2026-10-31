import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, test } from 'vitest'

test.skipIf(process.platform === 'linux' && !process.env.DISPLAY)(
  'Browser attachment preserves the Electron host theme across tabs and reconnects', async () => {
    const require = createRequire(resolve('apps/desktop/package.json'))
    const executable: unknown = require('electron')
    if (typeof executable !== 'string') throw new TypeError('Electron executable is unavailable')
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const { stdout } = await promisify(execFile)(executable, [resolve('apps/desktop/scripts/verify-browser-theme.cjs')], {
      env, windowsHide: true, timeout: 30_000,
    })
    expect(stdout).toContain('Browser attach, new tabs, reconnect and all theme preferences passed')
  }, 35_000,
)
