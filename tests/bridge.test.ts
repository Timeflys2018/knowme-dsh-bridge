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
})
