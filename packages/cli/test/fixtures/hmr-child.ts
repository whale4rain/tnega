// Child process for plugin-hmr.test.ts: mounts a hot profile, edits a file the
// plugin imports, and prints the probe result before and after the reload.
import { writeFile } from 'node:fs/promises'
import { Context } from '@tnega/core'
import { createHotPluginHost } from '../../src/plugin-hmr.js'

const [file, wordFile] = process.argv.slice(2)
if (!file || !wordFile) throw new Error('usage: hmr-child <profile> <word-file>')
const host = await createHotPluginHost(file, { watch: false })
const root = new Context()
await root.plugin(host.plugin)
const probe = () => {
  const out: string[] = []
  root.emit('hmr/probe', out)
  return out.join(',')
}
const before = probe()
await writeFile(wordFile, 'export const word = "two"\n')
await host.reload()
process.stdout.write(`${before} -> ${probe()}\n`)
await host.close()
