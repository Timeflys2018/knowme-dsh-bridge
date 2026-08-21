import { describe, expect, it } from 'vitest'

import { createBridge, type LoaderEntryLike, type SessionProjectionsLike, type PermissionPresetsLike, type ApprovalServiceLike } from '../src/bridge.js'
import { BRIDGE_METHODS, type DshSessionStats, type DshPermission } from '../src/contract.js'
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

describe('knowme/permission.get + set — permission-presets exposure', () => {
  const OPTIONS = [
    { value: 'read-only', name: 'Read only' },
    { value: 'workspace-write', name: 'Workspace write' },
    { value: 'danger-full-access', name: 'Full access' },
  ]
  function projections(currentValue: string | undefined): SessionProjectionsLike {
    return {
      snapshot: () => ({ values: currentValue === undefined ? {} : { permissions: { options: OPTIONS, currentValue } } }),
    }
  }
  function presets(over: Partial<PermissionPresetsLike> = {}): PermissionPresetsLike {
    return {
      resolve: (name) => {
        if (name === 'read-only') return { sandbox: 'read-only', approval: 'never' }
        if (name === 'workspace-write') return { sandbox: 'workspace-write', approval: 'ask' }
        throw new Error(`unknown preset "${name}"`)
      },
      set: () => undefined,
      ...over,
    }
  }

  it('get maps the permissions projection to {preset, options}', async () => {
    const h = fakeBridgeDeps({ sessionProjections: projections('workspace-write') })
    h.makeAgent('s1')
    const bridge = createBridge(h.deps)
    const r = (await bridge.handleRequest(BRIDGE_METHODS.permissionGet, { sessionId: 's1' })) as DshPermission
    expect(r).toEqual({ preset: 'workspace-write', options: OPTIONS })
  })

  it('get degrades to {preset:null, options:[]} when the permissions projection is absent', async () => {
    const h = fakeBridgeDeps({ sessionProjections: projections(undefined) })
    h.makeAgent('s1')
    const bridge = createBridge(h.deps)
    const r = (await bridge.handleRequest(BRIDGE_METHODS.permissionGet, { sessionId: 's1' })) as DshPermission
    expect(r).toEqual({ preset: null, options: [] })
  })

  it('set replicates the /permission command: resolve → approval.setPolicy(agent,policy) → presets.set(session,name)', async () => {
    const calls: string[] = []
    const p = presets({ set: (_s, name) => { calls.push(`set:${name}`) } })
    const approvalService: ApprovalServiceLike = { setPolicy: (_a, policy) => { calls.push(`setPolicy:${policy}`) } }
    const h = fakeBridgeDeps({ sessionProjections: projections('workspace-write'), permissionPresets: p, approvalService })
    h.makeAgent('s1')
    const bridge = createBridge(h.deps)
    const r = await bridge.handleRequest(BRIDGE_METHODS.permissionSet, { sessionId: 's1', preset: 'read-only' })
    expect(r).toEqual({ resolved: true })
    // setPolicy (with the model-visible notice) MUST run before set(), so the raw approval write is skipped.
    expect(calls).toEqual(['setPolicy:never', 'set:read-only'])
  })

  it('set rejects custom and unknown presets with unknown-preset', async () => {
    const h = fakeBridgeDeps({ sessionProjections: projections('workspace-write'), permissionPresets: presets() })
    h.makeAgent('s1')
    const bridge = createBridge(h.deps)
    await expect(bridge.handleRequest(BRIDGE_METHODS.permissionSet, { sessionId: 's1', preset: 'custom' })).rejects.toThrow(/unknown-preset/)
    await expect(bridge.handleRequest(BRIDGE_METHODS.permissionSet, { sessionId: 's1', preset: 'nope' })).rejects.toThrow(/unknown-preset/)
  })

  it('set rejects permission-unavailable when permissionPresets is absent', async () => {
    const h = fakeBridgeDeps({ sessionProjections: projections('workspace-write') })
    h.makeAgent('s1')
    const bridge = createBridge(h.deps)
    await expect(bridge.handleRequest(BRIDGE_METHODS.permissionSet, { sessionId: 's1', preset: 'read-only' })).rejects.toThrow(/permission-unavailable/)
  })

  it('set maps the terminal-fence throw to permission-locked, other throws to permission-write-failed', async () => {
    const locked = presets({ set: () => { throw new Error('cannot change sandbox mode from "danger-full-access" to "read-only" while persistent terminal sessions are open') } })
    const h1 = fakeBridgeDeps({ sessionProjections: projections('danger-full-access'), permissionPresets: locked })
    h1.makeAgent('s1')
    await expect(createBridge(h1.deps).handleRequest(BRIDGE_METHODS.permissionSet, { sessionId: 's1', preset: 'read-only' })).rejects.toThrow(/permission-locked/)

    const other = presets({ set: () => { throw new Error('disk full') } })
    const h2 = fakeBridgeDeps({ sessionProjections: projections('workspace-write'), permissionPresets: other })
    h2.makeAgent('s2')
    await expect(createBridge(h2.deps).handleRequest(BRIDGE_METHODS.permissionSet, { sessionId: 's2', preset: 'read-only' })).rejects.toThrow(/permission-write-failed/)
  })

  it('set without an approval service falls back to presets.set alone (no setPolicy, still resolves)', async () => {
    const calls: string[] = []
    const p = presets({ set: (_s, name) => { calls.push(`set:${name}`) } })
    const h = fakeBridgeDeps({ sessionProjections: projections('workspace-write'), permissionPresets: p })
    h.makeAgent('s1')
    const bridge = createBridge(h.deps)
    const r = await bridge.handleRequest(BRIDGE_METHODS.permissionSet, { sessionId: 's1', preset: 'read-only' })
    expect(r).toEqual({ resolved: true })
    expect(calls).toEqual(['set:read-only'])
  })
})
