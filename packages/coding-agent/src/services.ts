import type { CodingService } from './codingAgent.js'
import type { SkillsService } from './skills.js'

/** The `ctx` keys this package provides. */
declare module '@tnega/core' {
  interface ServiceMap {
    skills: SkillsService
    coding: CodingService
  }
}
