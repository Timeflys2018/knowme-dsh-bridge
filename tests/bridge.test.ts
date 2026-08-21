import { describe, expect, it } from 'vitest'

import { createBridge, type LoaderEntryLike, type SessionProjectionsLike } from '../src/bridge.js'
import { BRIDGE_METHODS, type DshSessionStats } from '../src/contract.js'
import { fakeBridgeDeps } from './helpers.js'

describe('knowme-dsh-bridge routing contract', () => {
  it('rejects unknown methods', async () => {
    const bridge = createBridge(fakeBridgeDeps().deps)
    await expect(bridge.handleRequest('bogus/method', {})).rejects.toThrow(/unknown knowme-dsh-bridge method/)
    await expect(bridge.handleRequest('knowme/bogus', {})).rejects.toThrow(
      /unknown knowme-dsh-bridge method: knowme\/bogus/,
    )
  })

  // Each bridge method is routed (not "unknown"); with unusable params the
  // method-specific validation error proves dispatch reached the right body.
  it.each([
    [BRIDGE_METHODS.selectModel, /sessionId/],
    [BRIDGE_METHODS.approvalRespond, /sessionId/],
    [BRIDGE_METHODS.questionRespond, /sessionId/],
  ])('routes %s to its own validation', async (method, pattern) => {
    const bridge = createBridge(fakeBridgeDeps().deps)
    await expect(bridge.handleRequest(method, {})).rejects.toThrow(pattern)
  })
})

describe('knowme/listPlugins — cordis loader projection', () => {
  function entry(over: Partial<LoaderEntryLike> & Pick<LoaderEntryLike, 'id'>): LoaderEntryLike {
    return { options: { name: `@x/${over.id}` }, disabled: false, ...over }
  }

  it('projects non-group leaf entries with enabled + fiberPhase (mirrors dsh gateway)', async () => {
    const loader = {
      entries: (): LoaderEntryLike[] => [
        entry({ id: 'group-1', options: { name: 'grp', group: true } }),
        entry({ id: 'llm', options: { name: '@deepseek-ai/dsh-llm' }, fiber: { state: 2 } }),
        entry({ id: 'sandbox', options: { name: '@deepseek-ai/dsh-tool-pwsh-sandbox' }, disabled: true, fiber: { state: 4 } }),
        entry({ id: 'bridge', options: { name: '@knowme/dsh-bridge' } }),
      ],
    }
    const bridge = createBridge({ ...fakeBridgeDeps().deps, loader })
    const result = (await bridge.handleRequest(BRIDGE_METHODS.listPlugins, {})) as {
      entries: { entryId: string; moduleName: string; enabled: boolean; fiberPhase: string | null }[]
    }
    // Group container is skipped; the three leaf entries project in loader order.
    expect(result.entries).toEqual([
      { entryId: 'llm', moduleName: '@deepseek-ai/dsh-llm', enabled: true, fiberPhase: 'active' },
      { entryId: 'sandbox', moduleName: '@deepseek-ai/dsh-tool-pwsh-sandbox', enabled: false, fiberPhase: null },
      { entryId: 'bridge', moduleName: '@knowme/dsh-bridge', enabled: true, fiberPhase: null },
    ])
  })

  it('degrades to an empty list when the loader service is absent', async () => {
    const bridge = createBridge(fakeBridgeDeps().deps)
    const result = await bridge.handleRequest(BRIDGE_METHODS.listPlugins, {})
    expect(result).toEqual({ entries: [] })
  })
})

describe('knowme/sessionStats — token-meter projection snapshot', () => {
  function projections(byId: Record<string, ProjectionSnapshotFake>): SessionProjectionsLike {
    return {
      snapshot: (session: object): ProjectionSnapshotFake => {
        const id = (session as { id?: string }).id ?? ''
        return byId[id] ?? { values: {} }
      },
    }
  }
  interface ProjectionSnapshotFake {
    values: {
      tokenUsage?: { uncachedInputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }
      contextPressure?: { pressureTokens?: number; contextWindow?: number }
      sessionStats?: { turns: number; steps: number; llmMs: number; toolMs: number; ttftMs: number; ttftSteps: number; decodeMs: number; decodeTokens: number }
    }
  }

  it('maps uncachedInputTokens/outputTokens/cache + contextPressure for a live session with usage', async () => {
    const harness = fakeBridgeDeps({
      sessionProjections: projections({
        's-live': {
          values: {
            tokenUsage: { uncachedInputTokens: 120, outputTokens: 45, cacheReadTokens: 12, cacheWriteTokens: 3 },
            contextPressure: { pressureTokens: 1000, contextWindow: 2000 },
          },
        },
      }),
    })
    harness.makeAgent('s-live')
    const bridge = createBridge(harness.deps)
    const stats = (await bridge.handleRequest(BRIDGE_METHODS.sessionStats, { sessionId: 's-live' })) as DshSessionStats
    expect(stats).toEqual({
      inputTokens: 120,
      outputTokens: 45,
      cacheReadTokens: 12,
      cacheWriteTokens: 3,
      contextPressure: { tokens: 1000, window: 2000 },
      // cacheHitRatio now rides the token buckets (graduated): 12 / (120 + 12 + 3) = 12/135.
      cacheHitRatio: 12 / 135,
    })
  })

  it('omits contextPressure for a live-but-idle session (distinguishes not-started from 0 tokens)', async () => {
    const harness = fakeBridgeDeps({
      sessionProjections: projections({
        's-idle': { values: { tokenUsage: { uncachedInputTokens: 0, outputTokens: 0 } } },
      }),
    })
    harness.makeAgent('s-idle')
    const bridge = createBridge(harness.deps)
    const stats = (await bridge.handleRequest(BRIDGE_METHODS.sessionStats, { sessionId: 's-idle' })) as DshSessionStats
    expect(stats.contextPressure).toBeUndefined()
    expect(stats.inputTokens).toBe(0)
    expect(stats.outputTokens).toBe(0)
  })

  it('degrades to an empty snapshot when the projections service is absent', async () => {
    const harness = fakeBridgeDeps()
    harness.makeAgent('s-1')
    const bridge = createBridge(harness.deps)
    const stats = (await bridge.handleRequest(BRIDGE_METHODS.sessionStats, { sessionId: 's-1' })) as DshSessionStats
    expect(stats).toEqual({ inputTokens: 0, outputTokens: 0 })
  })

  it('returns an empty snapshot for an unknown session id (no throw)', async () => {
    const harness = fakeBridgeDeps({ sessionProjections: projections({}) })
    const bridge = createBridge(harness.deps)
    const stats = (await bridge.handleRequest(BRIDGE_METHODS.sessionStats, { sessionId: 'nope' })) as DshSessionStats
    expect(stats).toEqual({ inputTokens: 0, outputTokens: 0 })
  })

  it('maps the sessionStats projection → turns/steps/llmMs/toolMs + derived firstTokenMs/tokPerSec + cacheHitRatio', async () => {
    const harness = fakeBridgeDeps({
      sessionProjections: projections({
        's-rich': {
          values: {
            tokenUsage: { uncachedInputTokens: 100, outputTokens: 50, cacheReadTokens: 900, cacheWriteTokens: 0 },
            sessionStats: { turns: 3, steps: 16, llmMs: 157000, toolMs: 706000, ttftMs: 6800, ttftSteps: 4, decodeMs: 2000, decodeTokens: 322 },
          },
        },
      }),
    })
    harness.makeAgent('s-rich')
    const bridge = createBridge(harness.deps)
    const stats = (await bridge.handleRequest(BRIDGE_METHODS.sessionStats, { sessionId: 's-rich' })) as DshSessionStats
    expect(stats.turns).toBe(3)
    expect(stats.steps).toBe(16)
    expect(stats.llmMs).toBe(157000)
    expect(stats.toolMs).toBe(706000)
    expect(stats.firstTokenMs).toBe(1700) // 6800 / 4
    expect(stats.tokPerSec).toBe(161) // 322 / (2000/1000)
    expect(stats.cacheHitRatio).toBeCloseTo(0.9, 5) // 900 / (100 + 900 + 0)
  })

  it('omits firstTokenMs when ttftSteps is 0 and tokPerSec when decodeMs is 0', async () => {
    const harness = fakeBridgeDeps({
      sessionProjections: projections({
        's-edge': {
          values: {
            sessionStats: { turns: 1, steps: 1, llmMs: 10, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 },
          },
        },
      }),
    })
    harness.makeAgent('s-edge')
    const bridge = createBridge(harness.deps)
    const stats = (await bridge.handleRequest(BRIDGE_METHODS.sessionStats, { sessionId: 's-edge' })) as DshSessionStats
    expect(stats.turns).toBe(1)
    expect(stats.firstTokenMs).toBeUndefined()
    expect(stats.tokPerSec).toBeUndefined()
  })

  it('omits all session-stats-derived fields when the sessionStats projection is absent', async () => {
    const harness = fakeBridgeDeps({
      sessionProjections: projections({
        's-notok': { values: { tokenUsage: { uncachedInputTokens: 10, outputTokens: 5 } } },
      }),
    })
    harness.makeAgent('s-notok')
    const bridge = createBridge(harness.deps)
    const stats = (await bridge.handleRequest(BRIDGE_METHODS.sessionStats, { sessionId: 's-notok' })) as DshSessionStats
    expect(stats.turns).toBeUndefined()
    expect(stats.steps).toBeUndefined()
    expect(stats.firstTokenMs).toBeUndefined()
    expect(stats.tokPerSec).toBeUndefined()
    expect(stats.cacheHitRatio).toBeUndefined() // no cache buckets → denominator guard
    expect(stats.inputTokens).toBe(10)
  })
})
