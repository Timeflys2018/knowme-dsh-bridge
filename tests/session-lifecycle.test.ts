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
  resumed: string[]
  live: Map<string, ReturnType<typeof makeAgent>>
  persisted: Map<string, { meta: { id: string; cwd: string; agentPreset?: string } }>
}

function makeFakes(over: Partial<{ inspectThrows: boolean }> = {}): Fakes {
  const created: string[] = []
  const resumed: string[] = []
  const live = new Map<string, ReturnType<typeof makeAgent>>()
  const persisted = new Map<string, { meta: { id: string; cwd: string; agentPreset?: string } }>()
  const deps: SessionLifecycleDeps = {
    agents: {
      get: (id: string) => live.get(String(id))?.agent,
      create: async (opts: { sessionId: unknown; meta: { cwd: string } }) => {
        const id = String(opts.sessionId)
        created.push(id)
        const a = makeAgent(id)
        live.set(id, a)
        return a
      },
      resume: async (opts: { resumeSessionId: unknown }) => {
        const id = String(opts.resumeSessionId)
        resumed.push(id)
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
        return { meta: p.meta, events: [] }
      },
    },
  }
  return { deps, created, resumed, live, persisted }
}

const OPTS = { provider: 'mify', model: 'zhipuai/glm-5.2' as string }

describe('resolvePromptAgent — three-state session gate (mirror apiproxy)', () => {
  it('attached (live agent) → reuse, no create/resume', async () => {
    const f = makeFakes()
    f.live.set('s1', makeAgent('s1'))
    const agent = await resolvePromptAgent(f.deps, { sessionId: 's1', cwd: '/proj', agentOptions: OPTS })
    expect(agent.id).toBe('s1')
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

  it('NIT: persisted session with a stored preset → throws preset-resume-unsupported', async () => {
    const f = makeFakes()
    f.persisted.set('s8', { meta: { id: 's8', cwd: '/proj', agentPreset: 'some-roster' } })
    await expect(resolvePromptAgent(f.deps, { sessionId: 's8', cwd: '/proj', agentOptions: OPTS })).rejects.toThrow(/preset/i)
    expect(f.resumed).toEqual([])
  })

  it('W3: concurrent same-id prompts share ONE create/resume (dedup)', async () => {
    const f = makeFakes()
    const [a, b] = await Promise.all([
      resolvePromptAgent(f.deps, { sessionId: 's9', cwd: '/proj', agentOptions: OPTS }),
      resolvePromptAgent(f.deps, { sessionId: 's9', cwd: '/proj', agentOptions: OPTS }),
    ])
    expect(f.created).toEqual(['s9']) // exactly one create despite two concurrent callers
    expect(a.id).toBe('s9')
    expect(b.id).toBe('s9')
  })
})
