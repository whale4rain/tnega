#!/usr/bin/env node
import { main } from './entry.js'

process.exitCode = await main(process.argv.slice(2))
