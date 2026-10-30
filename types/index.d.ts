export type Tokens = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type Usage = {
  contextTokens?: number
  contextWindow: number
  contextPercent?: number
  costUsd?: number
  limits: Limit[]
  main: Tokens
}

/** One model request a subagent made: when, and the tokens that count toward burn. */
export type Sample = { at: number; tokens: number }

export type AgentStat = {
  id: string
  description: string
  type: string
  status: string
  firstSeen: number
  activity: string
  tokens: Tokens
  samples: Sample[]
  killRequested: boolean
}

export type DashSettings = { threshold: number; autoKill: boolean }

declare module 'claude-code' {
  interface PluginState {
    'token-dash': {
      now: number
      usage: Shaped<Usage>
      agents: Shaped<Record<string, AgentStat>>
      settings: DashSettings
    }
  }
}
