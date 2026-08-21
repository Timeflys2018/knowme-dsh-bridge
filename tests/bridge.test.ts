import { describe, expect, it } from 'vitest'

import { createBridge, type LoaderEntryLike } from '../src/bridge.js'
import { BRIDGE_METHODS } from '../src/contract.js'
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
