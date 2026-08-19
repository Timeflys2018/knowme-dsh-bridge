import type { BridgeDeps, AgentLike, SessionEventLike } from '../src/bridge.js'

export interface RecordedNotification {
  readonly method: string
  readonly params: Record<string, unknown>
}

export interface FakeBridgeHarness {
  readonly deps: BridgeDeps
  readonly notifications: RecordedNotification[]
  readonly installs: { count: number; agentCtxs: object[] }
  makeAgent(id: string, events?: SessionEventLike[]): AgentLike
}

export function askedEvent(id: string, callId?: string): SessionEventLike {
  return {
    type: 'approval/asked',
    data: { id, toolName: 'bash', ...(callId === undefined ? {} : { callId }) },
  }
}

export function decidedEvent(id: string, outcome = 'allowed-once'): SessionEventLike {
  return { type: 'approval/decided', data: { id, outcome } }
}

export function fakeBridgeDeps(over: Partial<BridgeDeps> = {}): FakeBridgeHarness {
  const notifications: RecordedNotification[] = []
  const agents = new Map<string, AgentLike>()
  const installs = { count: 0, agentCtxs: [] as object[] }
  const deps: BridgeDeps = {
    agents: { get: (sessionId: string) => agents.get(sessionId) },
    notify: (method, params) => { notifications.push({ method, params: params as Record<string, unknown> }) },
    installModelSelection: (agentCtx) => {
      installs.count += 1
      installs.agentCtxs.push(agentCtx)
      return () => undefined
    },
    logger: { warn: () => undefined },
    ...over,
  }
  return {
    deps,
    notifications,
    installs,
    makeAgent(id: string, events: SessionEventLike[] = []): AgentLike {
      const agent: AgentLike = { id, session: { id, events }, ctx: {} }
      agents.set(id, agent)
      return agent
    },
  }
}
