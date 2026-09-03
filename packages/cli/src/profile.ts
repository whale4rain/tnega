import type { Plugin } from '@tnega/core'
import type { AgentRuntimeOptions } from './commands.js'

export interface AgentProfile {
  name: string
  bundles: readonly Plugin[]
  options?: Omit<AgentRuntimeOptions, 'cwd' | 'sessionFile' | 'plugins'>
}

export const generalAgentProfile: AgentProfile = {
  name: 'general',
  bundles: [],
}

export function bootAgentRuntime(
  base: Pick<AgentRuntimeOptions, 'cwd' | 'sessionFile'>,
  profile: AgentProfile = generalAgentProfile,
  overlay: Omit<AgentRuntimeOptions, 'cwd' | 'sessionFile'> = {},
): AgentRuntimeOptions {
  return {
    ...base,
    ...profile.options,
    ...overlay,
    plugins: [...(profile.bundles ?? []), ...(overlay.plugins ?? [])],
  }
}
