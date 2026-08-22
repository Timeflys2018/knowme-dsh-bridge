import { describe, expect, it } from 'vitest'

import { createBridge, type AgentLike, type BridgeDeps } from '../src/bridge.js'

const DEFAULTS_GET = 'knowme/defaults.get'

const PRESET_OPTIONS = [
  { id: 'standard', name: '标准模式', description: 'Full coding agent' },
  { id: 'code', name: 'PTC 模式' },
  { id: 'minimal', name: '极简模式' },
  { id: 'cordis', name: '创造模式' },
] as const

function makeAgentPresets(over: Partial<{ defaultId: string; list: () => Promise<readonly typeof PRESET_OPTIONS[number][]> }> = {}) {
  return {
    defaultId: 'standard',
    list: async () => PRESET_OPTIONS,
    resolve: async (id?: string) => ({ id: id ?? 'standard' }),
    recompose: async (_ctx: object, id: string) => ({ id }),
    ...over,
  }
}

function makePermissionPresets(over: Partial<{ names: readonly string[]; defaultPreset: string }> = {}) {
  return {
    resolve: (_name: string) => ({ sandbox: 'workspace-write', approval: 'ask' }),
    set: () => undefined,
    names: ['read-only', 'workspace-write', 'danger-full-access'] as readonly string[],
    defaultPreset: 'workspace-write',
    ...over,
  }
}

describe('knowme/defaults.get — session-less profile defaults', () => {
  it('returns mode + permission defaults and options WITHOUT a live session (agents.get never called)', async () => {
    let agentsGetCalls = 0
    const bridge = createBridge({
      agents: { get: () => { agentsGetCalls += 1; return undefined } },
      resolveAgentPresets: () => makeAgentPresets(),
      resolvePermissionPresets: () => makePermissionPresets(),
      notify: () => undefined,
    } as unknown as BridgeDeps)

    const result = await bridge.handleRequest(DEFAULTS_GET, undefined)

    expect(result).toEqual({
      mode: {
        default: 'standard',
        options: [
          { value: 'standard', name: '标准模式', description: 'Full coding agent' },
          { value: 'code', name: 'PTC 模式' },
          { value: 'minimal', name: '极简模式' },
          { value: 'cordis', name: '创造模式' },
        ],
      },
      permission: {
        default: 'workspace-write',
        options: [
          { value: 'read-only', name: 'read-only' },
          { value: 'workspace-write', name: 'workspace-write' },
          { value: 'danger-full-access', name: 'danger-full-access' },
        ],
      },
    })
    expect(agentsGetCalls).toBe(0)
  })

  it('filters broken agent presets out of the mode options', async () => {
    const bridge = createBridge({
      agents: { get: () => undefined },
      resolveAgentPresets: () => makeAgentPresets({ list: async () => [...PRESET_OPTIONS, { id: 'broken', name: 'X', broken: true } as never] }),
      resolvePermissionPresets: () => makePermissionPresets(),
      notify: () => undefined,
    } as unknown as BridgeDeps)

    const result = (await bridge.handleRequest(DEFAULTS_GET, undefined)) as { mode: { options: { value: string }[] } }
    expect(result.mode.options.map((o) => o.value)).toEqual(['standard', 'code', 'minimal', 'cordis'])
  })

  it('degrades each side independently when its service is absent', async () => {
    const onlyMode = createBridge({
      agents: { get: () => undefined },
      resolveAgentPresets: () => makeAgentPresets(),
      notify: () => undefined,
    } as unknown as BridgeDeps)
    await expect(onlyMode.handleRequest(DEFAULTS_GET, undefined)).resolves.toEqual({
      mode: { default: 'standard', options: PRESET_OPTIONS.map((p) => ({ value: p.id, name: p.name, ...(p.description ? { description: p.description } : {}) })) },
      permission: { default: null, options: [] },
    })

    const neither = createBridge({ agents: { get: () => undefined }, notify: () => undefined } as unknown as BridgeDeps)
    await expect(neither.handleRequest(DEFAULTS_GET, undefined)).resolves.toEqual({
      mode: { default: null, options: [] },
      permission: { default: null, options: [] },
    })
  })
})
