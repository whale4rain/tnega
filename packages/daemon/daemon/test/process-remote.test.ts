import { expect, it } from 'vitest'
import { Peer, acceptDaemon, initialize, memoryTransportPair } from '@tnega/daemon-protocol'
import { remoteExecutionProvider } from '@tnega/process-remote'

it('keeps the output and exit of a process that ends before process/start answers', async () => {
  const [runtimeSide, daemonSide] = memoryTransportPair()
  const accepted = acceptDaemon(runtimeSide, { heartbeat: false })
  const daemon: Peer = new Peer(daemonSide, {
    heartbeat: false,
    handle: async method => {
      if (method !== 'process/start') return null
      // What a daemon sends for a process that is already done when it starts.
      daemon.notify('process/tail', { handle: 'h1', output: 'all done\n' })
      daemon.notify('process/exit', { handle: 'h1', exitCode: 0 })
      return { handle: 'h1', pid: 7 }
    },
  })
  await initialize(daemon, { deviceId: 'dev_1', capabilities: { process: true }, workspaces: [{ id: 'ws_1', path: '/w' }] })
  const link = await accepted
  try {
    const provider = remoteExecutionProvider(link, { workspaceId: 'ws_1' })
    const process = await provider.startProcess!({ argv: ['true'], cwd: '/w' })
    expect(await process.exited).toBe(0)
    expect(process.output()).toBe('all done\n')
    expect(process.exitCode()).toBe(0)
  } finally {
    link.close()
  }
})
