import { main } from '../packages/cli/src/index.js'

process.exitCode = await main(process.argv.slice(2))
