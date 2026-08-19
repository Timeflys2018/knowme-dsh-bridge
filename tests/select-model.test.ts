import { describe, expect, it } from 'vitest'

import { createBridge, type LlmLike } from '../src/bridge.js'
import { BRIDGE_METHODS } from '../src/contract.js'
import { fakeBridgeDeps } from './helpers.js'

const RESOLVED = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }

function makeLlm(behavior: 'ok' | 'throw' | { provider: string; model: string; reasoningEffort?: string } = 'ok'): LlmLike {
  return {
    resolveCallConfig: async (config) => {
      if (behavior === 'throw') throw new Error('no adapter registered for provider "ghost"')
      if (behavior === 'ok') return config
      return behavior
    },
  }
}

describe('selectModel error taxonomy', () => {
  it('unknown session rejects with session-not-found', async () => {
    const harness = fakeBridgeDeps({ llm: makeLlm() })
    const bridge = createBridge(harness.deps)
    await expect(bridge.handleRequest(BRIDGE_METHODS.selectModel, {
      sessionId: 'ghost-session', provider: RESOLVED.provider, model: RESOLVED.model,
    })).rejects.toThrow(/session-not-found/)
  })

  it('absent llm service rejects with llm-unavailable', async () => {
    const harness = fakeBridgeDeps()
    harness.makeAgent('sess-1')
    const bridge = createBridge(harness.deps)
    await expect(bridge.handleRequest(BRIDGE_METHODS.selectModel, {
      sessionId: 'sess-1', provider: RESOLVED.provider, model: RESOLVED.model,
    })).rejects.toThrow(/llm-unavailable/)
  })

  it('resolveCallConfig failure rejects with model-unavailable', async () => {
    const harness = fakeBridgeDeps({ llm: makeLlm('throw') })
    harness.makeAgent('sess-1')
    const bridge = createBridge(harness.deps)
    await expect(bridge.handleRequest(BRIDGE_METHODS.selectModel, {
      sessionId: 'sess-1', provider: 'ghost', model: 'whatever',
    })).rejects.toThrow(/model-unavailable/)
    expect(harness.installs.count).toBe(0)
  })
})

describe('selectModel installs a memoized selection ref', () => {
  it('first switch installs once via installModelSelection on the agent context', async () => {
    const harness = fakeBridgeDeps({ llm: makeLlm() })
    const agent = harness.makeAgent('sess-1')
    const bridge = createBridge(harness.deps)
    await expect(bridge.handleRequest(BRIDGE_METHODS.selectModel, {
      sessionId: 'sess-1', ...RESOLVED,
    })).resolves.toEqual({ selected: { provider: RESOLVED.provider, model: RESOLVED.model } })
    expect(harness.installs.count).toBe(1)
    expect(harness.installs.agentCtxs).toEqual([agent.ctx])
  })

  it('reasoningEffort round-trips only when supplied', async () => {
    const harness = fakeBridgeDeps({ llm: makeLlm({ ...RESOLVED, reasoningEffort: 'high' }) })
    harness.makeAgent('sess-1')
    const bridge = createBridge(harness.deps)
    await expect(bridge.handleRequest(BRIDGE_METHODS.selectModel, {
      sessionId: 'sess-1', ...RESOLVED, reasoningEffort: 'high',
    })).resolves.toEqual({ selected: { ...RESOLVED, reasoningEffort: 'high' } })
  })

  it('second switch on the same agent does not re-install', async () => {
    const harness = fakeBridgeDeps({ llm: makeLlm() })
    harness.makeAgent('sess-1')
    const bridge = createBridge(harness.deps)
    await bridge.handleRequest(BRIDGE_METHODS.selectModel, { sessionId: 'sess-1', ...RESOLVED })
    await bridge.handleRequest(BRIDGE_METHODS.selectModel, {
      sessionId: 'sess-1', provider: RESOLVED.provider, model: 'deepseek-v4-chat',
    })
    expect(harness.installs.count).toBe(1)
  })

  it('a different agent installs its own ref', async () => {
    const harness = fakeBridgeDeps({ llm: makeLlm() })
    harness.makeAgent('sess-1')
    harness.makeAgent('sess-2')
    const bridge = createBridge(harness.deps)
    await bridge.handleRequest(BRIDGE_METHODS.selectModel, { sessionId: 'sess-1', ...RESOLVED })
    await bridge.handleRequest(BRIDGE_METHODS.selectModel, { sessionId: 'sess-2', ...RESOLVED })
    expect(harness.installs.count).toBe(2)
  })

  it('param validation rejects non-string sessionId/provider/model', async () => {
    const harness = fakeBridgeDeps({ llm: makeLlm() })
    harness.makeAgent('sess-1')
    const bridge = createBridge(harness.deps)
    await expect(bridge.handleRequest(BRIDGE_METHODS.selectModel, { provider: 'p', model: 'm' }))
      .rejects.toThrow(/sessionId/)
    await expect(bridge.handleRequest(BRIDGE_METHODS.selectModel, { sessionId: 'sess-1', model: 'm' }))
      .rejects.toThrow(/provider/)
    await expect(bridge.handleRequest(BRIDGE_METHODS.selectModel, { sessionId: 'sess-1', provider: 'p' }))
      .rejects.toThrow(/model/)
  })
})
