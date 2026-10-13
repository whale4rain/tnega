import { main } from '../packages/cli/src/entry.js'

process.exitCode = await main(process.argv.slice(2))
