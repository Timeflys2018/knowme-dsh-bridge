import { describe, expect, it, vi } from 'vitest'

import { createBridge, type AgentLike, type BridgeDeps, type SessionEventLike } from '../src/bridge.js'

const AGENT_PRESET_GET = 'knowme/agentPreset.get'
const AGENT_PRESET_SET = 'knowme/agentPreset.set'

interface FakeAgentPresetService {
  readonly defaultId: string
  list(): Promise<readonly { readonly id: string; readonly name?: string; readonly description?: string; readonly broken?: boolean }[]>
  resolve(id?: string): Promise<{ readonly id: string }>
  recompose(agentCtx: object, id: string): Promise<{ readonly id: string }>
}

interface AppendCall {
  readonly type: string
  readonly data: unknown
}

interface PresetHarness {
  readonly appendCalls: AppendCall[]
  readonly service: FakeAgentPresetService
  readonly recomposeCalls: string[]
  readonly bridge: ReturnType<typeof createBridge>
}

const PRESET_OPTIONS = [
  { id: 'standard', name: '标准模式', description: 'Full coding agent' },
  { id: 'code', name: 'PTC 模式' },
  { id: 'minimal', name: '极简模式' },
  { id: 'cordis', name: '创造模式' },
] as const

function presetEvent(id: string): SessionEventLike {
  return { type: 'agent-preset/selected', data: { agentPreset: id } }
}

function turnStart(): SessionEventLike {
  return { type: 'turn/start', data: {} }
}

function makePresetHarness(events: readonly SessionEventLike[] = [], over: Partial<FakeAgentPresetService> = {}): PresetHarness {
  const appendCalls: AppendCall[] = []
  const recomposeCalls: string[] = []
  const session = {
    id: 's1',
    events,
    append: (type: string, data: unknown) => { appendCalls.push({ type, data }) },
  }
  const agent = { id: 's1', session, ctx: {} } as AgentLike
  const service: FakeAgentPresetService = {
    defaultId: 'standard',
    list: async () => PRESET_OPTIONS,
    resolve: async (id) => ({ id: id ?? 'standard' }),
    recompose: async (_agentCtx, id) => {
      recomposeCalls.push(id)
      return { id }
    },
    ...over,
  }
  const deps = {
    agents: { get: (sessionId: string) => (sessionId === 's1' ? agent : undefined) },
    resolveAgentPresets: () => service,
    notify: () => undefined,
  } as BridgeDeps
  return { appendCalls, service, recomposeCalls, bridge: createBridge(deps) }
}

describe('knowme/agentPreset.get — mode snapshot from agentPresets', () => {
  it('returns the selected preset, non-broken options, default, and unlocked state for a blank live session', async () => {
    const h = makePresetHarness([presetEvent('code')], {
      list: async () => [...PRESET_OPTIONS, { id: 'broken', name: 'Broken', broken: true }],
    })

    const result = await h.bridge.handleRequest(AGENT_PRESET_GET, { sessionId: 's1' })

    expect(result).toEqual({
      preset: 'code',
      default: 'standard',
      locked: false,
      options: [
        { value: 'standard', name: '标准模式', description: 'Full coding agent' },
        { value: 'code', name: 'PTC 模式' },
        { value: 'minimal', name: '极简模式' },
        { value: 'cordis', name: '创造模式' },
      ],
    })
  })

  it('falls back to defaultId when the session has no selected/header preset', async () => {
    const h = makePresetHarness([])

    const result = await h.bridge.handleRequest(AGENT_PRESET_GET, { sessionId: 's1' })

    expect(result).toMatchObject({ preset: 'standard', default: 'standard', locked: false })
  })

  it('degrades to an empty unlocked snapshot when service or live agent is absent', async () => {
    const noService = createBridge({ agents: { get: () => ({ id: 's1', session: { id: 's1', events: [] }, ctx: {} } as AgentLike) }, notify: () => undefined })
    await expect(noService.handleRequest(AGENT_PRESET_GET, { sessionId: 's1' })).resolves.toEqual({
      preset: null,
      options: [],
      default: null,
      locked: false,
    })

    const noAgent = createBridge({ agents: { get: () => undefined }, resolveAgentPresets: () => makePresetHarness().service, notify: () => undefined } as BridgeDeps)
    await expect(noAgent.handleRequest(AGENT_PRESET_GET, { sessionId: 'ghost' })).resolves.toEqual({
      preset: null,
      options: [],
      default: null,
      locked: false,
    })
  })

  it('reports locked once the session has a turn/start event', async () => {
    const h = makePresetHarness([turnStart(), presetEvent('minimal')])

    const result = await h.bridge.handleRequest(AGENT_PRESET_GET, { sessionId: 's1' })

    expect(result).toMatchObject({ preset: 'minimal', locked: true })
  })
})

describe('knowme/agentPreset.set — blank-only serialized recompose', () => {
  it('recomposes a blank session, appends the canonical resolved id, and returns it', async () => {
    const recompose = vi.fn(async () => ({ id: 'minimal-canonical' }))
    const h = makePresetHarness([], { recompose })

    const result = await h.bridge.handleRequest(AGENT_PRESET_SET, { sessionId: 's1', preset: 'minimal' })

    expect(result).toEqual({ resolved: true, preset: 'minimal-canonical' })
    expect(recompose).toHaveBeenCalledWith(expect.any(Object), 'minimal')
    expect(h.appendCalls).toEqual([{ type: 'agent-preset/selected', data: { agentPreset: 'minimal-canonical' } }])
  })

  it('rejects a session with turn/start as agent-preset-locked without recompose or append', async () => {
    const recompose = vi.fn(async () => ({ id: 'minimal' }))
    const h = makePresetHarness([turnStart()], { recompose })

    await expect(h.bridge.handleRequest(AGENT_PRESET_SET, { sessionId: 's1', preset: 'minimal' })).rejects.toThrow(/agent-preset-locked/)

    expect(recompose).not.toHaveBeenCalled()
    expect(h.appendCalls).toEqual([])
  })

  it('maps UnknownPresetError to agent-preset-not-found and PresetMountError to agent-preset-invalid', async () => {
    const unknown = new Error('Unknown preset: bogus')
    unknown.name = 'UnknownPresetError'
    const h1 = makePresetHarness([], { recompose: async () => { throw unknown } })
    await expect(h1.bridge.handleRequest(AGENT_PRESET_SET, { sessionId: 's1', preset: 'bogus' })).rejects.toThrow(/agent-preset-not-found/)
    expect(h1.appendCalls).toEqual([])

    const invalid = new Error('mount failed')
    invalid.name = 'PresetMountError'
    const h2 = makePresetHarness([], { recompose: async () => { throw invalid } })
    await expect(h2.bridge.handleRequest(AGENT_PRESET_SET, { sessionId: 's1', preset: 'broken' })).rejects.toThrow(/agent-preset-invalid/)
    expect(h2.appendCalls).toEqual([])
  })

  it('maps an append failure after successful recompose to agent-preset-append-failed', async () => {
    const agent = {
      id: 's1',
      session: { id: 's1', events: [], append: () => { throw new Error('deep freeze rejected') } },
      ctx: {},
    } as AgentLike
    const deps = {
      agents: { get: () => agent },
      resolveAgentPresets: () => ({
        defaultId: 'standard',
        list: async () => PRESET_OPTIONS,
        resolve: async (id?: string) => ({ id: id ?? 'standard' }),
        recompose: async () => ({ id: 'minimal' }),
      }),
      notify: () => undefined,
    } as BridgeDeps

    await expect(createBridge(deps).handleRequest(AGENT_PRESET_SET, { sessionId: 's1', preset: 'minimal' })).rejects.toThrow(/agent-preset-append-failed/)
  })

  it('rejects session-not-found for an absent agent and agent-preset-invalid when the service is absent', async () => {
    const noAgent = createBridge({ agents: { get: () => undefined }, resolveAgentPresets: () => makePresetHarness().service, notify: () => undefined } as BridgeDeps)
    await expect(noAgent.handleRequest(AGENT_PRESET_SET, { sessionId: 'ghost', preset: 'minimal' })).rejects.toThrow(/session-not-found/)

    const noService = createBridge({ agents: { get: () => ({ id: 's1', session: { id: 's1', events: [] }, ctx: {} } as AgentLike) }, notify: () => undefined })
    await expect(noService.handleRequest(AGENT_PRESET_SET, { sessionId: 's1', preset: 'minimal' })).rejects.toThrow(/agent-preset-invalid/)
  })

  it('serializes concurrent sets for the same session', async () => {
    const calls: string[] = []
    let releaseFirst: (() => void) | undefined
    const firstRelease = new Promise<void>((release) => { releaseFirst = release })
    let signalFirstStarted: () => void = () => undefined
    const firstStarted = new Promise<void>((resolve) => { signalFirstStarted = resolve })
    const service: FakeAgentPresetService = {
      defaultId: 'standard',
      list: async () => PRESET_OPTIONS,
      resolve: async (id) => ({ id: id ?? 'standard' }),
      recompose: async (_ctx, id) => {
        calls.push(`start:${id}`)
        if (id === 'minimal') {
          signalFirstStarted()
          await firstRelease
        }
        calls.push(`end:${id}`)
        return { id }
      },
    }
    const session = {
      id: 's1',
      events: [] as SessionEventLike[],
      append: (type: string, data: unknown) => { calls.push(`append:${type}:${JSON.stringify(data)}`) },
    }
    const agent = { id: 's1', session, ctx: {} } as AgentLike
    const bridge = createBridge({ agents: { get: () => agent }, resolveAgentPresets: () => service, notify: () => undefined } as BridgeDeps)
    const first = bridge.handleRequest(AGENT_PRESET_SET, { sessionId: 's1', preset: 'minimal' })
    const second = bridge.handleRequest(AGENT_PRESET_SET, { sessionId: 's1', preset: 'code' })
    void first.catch(() => undefined)
    void second.catch(() => undefined)

    await vi.waitFor(() => expect(calls).toEqual(['start:minimal']))
    expect(calls).toEqual(['start:minimal'])
    releaseFirst?.()

    await Promise.all([first, second])
    expect(calls).toEqual([
      'start:minimal',
      'end:minimal',
      'append:agent-preset/selected:{"agentPreset":"minimal"}',
      'start:code',
      'end:code',
      'append:agent-preset/selected:{"agentPreset":"code"}',
    ])
  })
})
