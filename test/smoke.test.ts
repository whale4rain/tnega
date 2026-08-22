import { describe, expect, it } from 'vitest'

import { name as agentName } from '../packages/agent/src/index.js'
import { name as cliName } from '../packages/cli/src/index.js'
import { name as coreName } from '../packages/core/src/index.js'
import { name as evalName } from '../packages/eval/src/index.js'
import { name as evolveName } from '../packages/evolve/src/index.js'
import { name as sessionName } from '../packages/session/src/index.js'
import { name as toolsName } from '../packages/tools/src/index.js'

describe('workspace smoke test', () => {
  it('resolves every package in the workspace', () => {
    expect(coreName).toBe('@tnega/core')
    expect(agentName).toBe('@tnega/agent')
    expect(toolsName).toBe('@tnega/tools')
    expect(sessionName).toBe('@tnega/session')
    expect(evalName).toBe('@tnega/eval')
    expect(evolveName).toBe('@tnega/evolve')
    expect(cliName).toBe('@tnega/cli')
  })
})
