import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

// JSONReporter does not include unhandled runtime errors in Vitest 4.
export default class ReleaseTestReporter {
  onTestRunEnd(_modules, errors, reason) {
    const dir = resolve(import.meta.dirname, '../.tnega')
    mkdirSync(dir, { recursive: true })
    writeFileSync(resolve(dir, 'release-ci-errors.json'), JSON.stringify({ errors, reason }))
  }
}
