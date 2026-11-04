import { expect, it } from 'vitest'
import { isSandboxPipeDenial } from '../src/index.js'

it('recognises the Windows sandbox named-pipe denial in its usual shapes', () => {
  for (const text of [
    'Error: spawn EPERM\n    at ChildProcess.spawn',
    'spawnSync C:\\Program Files\\nodejs\\node.exe EPERM',
    'const error = {"message":"spawn EPERM","stack":"..."}',
    '[vite] Internal server error: spawn EPERM',
    'Error: listen EACCES: permission denied \\\\.\\pipe\\tnega-test',
  ]) {
    expect(isSandboxPipeDenial(text), text).toBe(true)
  }
  for (const text of ['plain failure', 'EPERM: operation not permitted, open \'C:\\out.txt\'', 'listen EACCES: permission denied 0.0.0.0:80']) {
    expect(isSandboxPipeDenial(text), text).toBe(false)
  }
})
