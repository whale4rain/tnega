import type { AgentProfile, AgentRuntimeOptions } from '@tnega/runtime'

export type { AgentProfile } from '@tnega/runtime'

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
