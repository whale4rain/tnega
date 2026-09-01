import type { AgentType, SessionMode } from '@tnega/session'

export type PlanStatus = 'pending' | 'done' | 'failed'

export interface PlanItem {
  id: string
  title: string
  status: PlanStatus
  detail?: string
}

export interface Plan {
  summary?: string
  items: PlanItem[]
  status: 'pending' | 'running' | 'done' | 'failed'
}

export interface SlashCommand {
  name: string
  description: string
}

export type SlashCommandResult =
  | { kind: 'text'; text: string }
  | { kind: 'json'; value: unknown }

export interface CodingSurvey {
  agentType: AgentType
  mode: SessionMode
  planTools: number
  skillsEnabled: boolean
  skills: number
  mcpEnabled: boolean
  mcpServers: number
  mcpTools: number
}

export { type AgentType, type SessionMode }
