import { describe, expect, it, vi } from 'vitest'

import { resolvePromptAgent, type SessionLifecycleDeps } from '../src/session-lifecycle.js'

// Fakes for the dsh services the resolver injects. Shapes mirror the real dsh surface (agents
// registry keyed by SessionId, sessions.get, sessionPersistence.list/inspect) — verified against rc.8.
function makeAgent(id: string): { id: string; agent: { id: string; followup: ReturnType<typeof vi.fn> } } {
  return { id, agent: { id, followup: vi.fn() } }
}

interface Fakes {
  deps: SessionLifecycleDeps
  created: string[]
  createdMeta: Map<string, string | undefined>
  resumed: string[]
  setupCalls: Array<() => Promise<void>>
  mounted: string[]
  live: Map<string, ReturnType<typeof makeAgent>>
  persisted: Map<string, { meta: { id: string; cwd: string; agentPreset?: string }; events?: readonly { type: string; data: unknown }[] }>
}

function makeFakes(over: Partial<{ inspectThrows: boolean; mountThrows: boolean; noAgentPresets: boolean }> = {}): Fakes {
  const created: string[] = []
  const createdMeta = new Map<string, string | undefined>()
  const resumed: string[] = []
  const setupCalls: Array<() => Promise<void>> = []
  const mounted: string[] = []
  const live = new Map<string, ReturnType<typeof makeAgent>>()
  const persisted = new Map<string, { meta: { id: string; cwd: string; agentPreset?: string }; events?: readonly { type: string; data: unknown }[] }>()
  const deps = {
    agents: {
      get: (id: string) => live.get(String(id))?.agent,
      create: async (opts: { sessionId: unknown; meta: { cwd: string; agentPreset?: string }; setup?: (agentCtx: object) => Promise<void> }) => {
        const id = String(opts.sessionId)
        created.push(id)
        // Record the meta.agentPreset — dsh persists it on the session header (what getAgentPreset reads).
        // The runtime bug this guards: composing via setup-mount alone reports 'standard' from get.
        createdMeta.set(id, opts.meta.agentPreset)
        if (opts.setup !== undefined) setupCalls.push(() => opts.setup?.({}) ?? Promise.resolve())
        const a = makeAgent(id)
        live.set(id, a)
        return a
      },
      resume: async (opts: { resumeSessionId: unknown; setup?: (agentCtx: object) => Promise<void> }) => {
        const id = String(opts.resumeSessionId)
        resumed.push(id)
        if (opts.setup !== undefined) setupCalls.push(() => opts.setup?.({}) ?? Promise.resolve())
        const a = makeAgent(id)
        live.set(id, a)
        return a
      },
    },
    sessions: { get: (id: string) => (live.has(String(id)) ? { id: String(id) } : undefined) },
    persistence: {
      list: async () => [...persisted.values()].map((p) => p.meta),
      inspect: async (id: string) => {
        if (over.inspectThrows === true) throw new Error('SessionPersistenceCorruptionError: torn log')
        const p = persisted.get(String(id))
        if (p === undefined) throw new Error('not found')
        return { meta: p.meta, events: p.events ?? [] }
      },
    },
    ...(over.noAgentPresets === true
      ? {}
      : {
          resolveAgentPresets: () => ({
            defaultId: 'standard',
            resolve: async (id?: string) => ({ id: id ?? 'standard' }),
            mount: async (_agentCtx: object, id?: string) => {
              if (over.mountThrows === true && id !== 'standard') {
                const error = new Error(`unknown preset ${id}`)
                error.name = 'UnknownPresetError'
                throw error
              }
              mounted.push(id ?? 'standard')
            },
          }),
        }),
  } as SessionLifecycleDeps
  return { deps, created, createdMeta, resumed, setupCalls, mounted, live, persisted }
}

const OPTS = { provider: 'mify', model: 'zhipuai/glm-5.2' as string }

describe('resolvePromptAgent — three-state session gate (mirror apiproxy)', () => {
  it('attached (live agent) → reuse, no create/resume', async () => {
    const f = makeFakes()
    f.live.set('s1', makeAgent('s1'))
    const { agent, created } = await resolvePromptAgent(f.deps, { sessionId: 's1', cwd: '/proj', agentOptions: OPTS })
    expect(agent.id).toBe('s1')
    expect(created).toBe(false)
    expect(f.created).toEqual([])
    expect(f.resumed).toEqual([])
  })

  it('detached-on-disk → resume(resumeSessionId), loads history, no create', async () => {
    const f = makeFakes()
    f.persisted.set('s2', { meta: { id: 's2', cwd: '/proj' } })
    await resolvePromptAgent(f.deps, { sessionId: 's2', cwd: '/proj', agentOptions: OPTS })
    expect(f.resumed).toEqual(['s2'])
    expect(f.created).toEqual([])
  })

  it('new (no live, no disk log) → create({sessionId,meta:{cwd}})', async () => {
    const f = makeFakes()
    await resolvePromptAgent(f.deps, { sessionId: 's3', cwd: '/proj', agentOptions: OPTS })
    expect(f.created).toEqual(['s3'])
    expect(f.resumed).toEqual([])
  })

  it('W4: attached check runs on EVERY call (disposed agent re-resolves, not stale-reused)', async () => {
    const f = makeFakes()
    f.persisted.set('s4', { meta: { id: 's4', cwd: '/proj' } })
    // First: not live → resume
    await resolvePromptAgent(f.deps, { sessionId: 's4', cwd: '/proj', agentOptions: OPTS })
    expect(f.resumed).toEqual(['s4'])
    // Agent disposed out-of-band (removed from live map) → next call must resume again, not reuse a stale handle
    f.live.delete('s4')
    await resolvePromptAgent(f.deps, { sessionId: 's4', cwd: '/proj', agentOptions: OPTS })
    expect(f.resumed).toEqual(['s4', 's4'])
  })

  it('D5: cwd mismatch on a persisted session → throws cwd-conflict, no resume', async () => {
    const f = makeFakes()
    f.persisted.set('s5', { meta: { id: 's5', cwd: '/OTHER' } })
    await expect(resolvePromptAgent(f.deps, { sessionId: 's5', cwd: '/proj', agentOptions: OPTS })).rejects.toThrow(/cwd/i)
    expect(f.resumed).toEqual([])
  })

  it('W1: missing agentOptions (prompt before initialize) → throws initialize-required', async () => {
    const f = makeFakes()
    await expect(
      resolvePromptAgent(f.deps, { sessionId: 's6', cwd: '/proj', agentOptions: undefined }),
    ).rejects.toThrow(/initialize/i)
    expect(f.created).toEqual([])
  })

  it('W2: torn/corrupt persisted log → clean error, NO fresh-create', async () => {
    const f = makeFakes({ inspectThrows: true })
    f.persisted.set('s7', { meta: { id: 's7', cwd: '/proj' } })
    await expect(resolvePromptAgent(f.deps, { sessionId: 's7', cwd: '/proj', agentOptions: OPTS })).rejects.toThrow()
    expect(f.created).toEqual([]) // MUST NOT silently fresh-create over a corrupt log
    expect(f.resumed).toEqual([])
  })

  it('resumed session with a selected preset mounts that preset during setup', async () => {
    const f = makeFakes()
    f.persisted.set('s8', {
      meta: { id: 's8', cwd: '/proj' },
      events: [{ type: 'agent-preset/selected', data: { agentPreset: 'minimal' } }],
    })
    await resolvePromptAgent(f.deps, { sessionId: 's8', cwd: '/proj', agentOptions: OPTS })
    expect(f.resumed).toEqual(['s8'])

    await f.setupCalls[0]?.()

    expect(f.mounted).toEqual(['minimal'])
  })

  it('new session mounts the default preset during create setup', async () => {
    const f = makeFakes()
    await resolvePromptAgent(f.deps, { sessionId: 's8-create', cwd: '/proj', agentOptions: OPTS })
    expect(f.created).toEqual(['s8-create'])

    await f.setupCalls[0]?.()

    expect(f.mounted).toEqual(['standard'])
  })

  it('no agentPresets roster composes no setup and still resumes', async () => {
    const f = makeFakes({ noAgentPresets: true })
    f.persisted.set('s8-bare', { meta: { id: 's8-bare', cwd: '/proj' } })
    await resolvePromptAgent(f.deps, { sessionId: 's8-bare', cwd: '/proj', agentOptions: OPTS })
    expect(f.resumed).toEqual(['s8-bare'])
    expect(f.setupCalls).toEqual([])
    expect(f.mounted).toEqual([])
  })

  it('missing stored preset falls back to default during setup and resume succeeds', async () => {
    const f = makeFakes({ mountThrows: true })
    f.persisted.set('s8-missing', {
      meta: { id: 's8-missing', cwd: '/proj' },
      events: [{ type: 'agent-preset/selected', data: { agentPreset: 'minimal' } }],
    })
    await resolvePromptAgent(f.deps, { sessionId: 's8-missing', cwd: '/proj', agentOptions: OPTS })

    await f.setupCalls[0]?.()

    expect(f.mounted).toEqual(['standard'])
  })

  it('W3: concurrent same-id prompts share ONE create/resume (dedup)', async () => {
    const f = makeFakes()
    const [a, b] = await Promise.all([
      resolvePromptAgent(f.deps, { sessionId: 's9', cwd: '/proj', agentOptions: OPTS }),
      resolvePromptAgent(f.deps, { sessionId: 's9', cwd: '/proj', agentOptions: OPTS }),
    ])
    expect(f.created).toEqual(['s9']) // exactly one create despite two concurrent callers
    expect(a.agent.id).toBe('s9')
    expect(b.agent.id).toBe('s9')
    expect(a.created).toBe(true)
  })

  // Change 4b: the chosen mode composes the CREATE (via the header channel → resolveSessionPresetFromEvents).
  it('create with agentPreset mounts that preset', async () => {
    const f = makeFakes()
    const { created } = await resolvePromptAgent(f.deps, { sessionId: 's-mode', cwd: '/proj', agentOptions: OPTS, agentPreset: 'minimal' })
    expect(created).toBe(true)
    // meta.agentPreset RECORDS it on the header (getAgentPreset reads this); setup MOUNTS it (runtime toolset).
    expect(f.createdMeta.get('s-mode')).toBe('minimal')
    await Promise.all(f.setupCalls.map((run) => run()))
    expect(f.mounted).toEqual(['minimal'])
  })

  it('create without agentPreset mounts the default', async () => {
    const f = makeFakes()
    await resolvePromptAgent(f.deps, { sessionId: 's-def', cwd: '/proj', agentOptions: OPTS })
    await Promise.all(f.setupCalls.map((run) => run()))
    expect(f.mounted).toEqual(['standard'])
  })

  // A resumed session's stored preset wins — the prompt's agentPreset MUST NOT override it.
  it('resume ignores the prompt agentPreset (stored preset wins)', async () => {
    const f = makeFakes()
    f.persisted.set('s-res', { meta: { id: 's-res', cwd: '/proj', agentPreset: 'code' } })
    const { created } = await resolvePromptAgent(f.deps, { sessionId: 's-res', cwd: '/proj', agentOptions: OPTS, agentPreset: 'minimal' })
    expect(created).toBe(false)
    await Promise.all(f.setupCalls.map((run) => run()))
    expect(f.mounted).toEqual(['code']) // stored 'code', NOT the prompt's 'minimal'
  })

  it('a live-agent reuse reports created:false', async () => {
    const f = makeFakes()
    f.live.set('s-live', makeAgent('s-live'))
    const { created } = await resolvePromptAgent(f.deps, { sessionId: 's-live', cwd: '/proj', agentOptions: OPTS, agentPreset: 'minimal' })
    expect(created).toBe(false)
    expect(f.mounted).toEqual([]) // no create/mount for a live reuse
  })
})
