import { SessionId } from '@deepseek-ai/dsh-session'

import { resolveSessionPresetFromEvents, type SessionEventLike } from './bridge.js'

/**
 * session-lifecycle — the three-state prompt-agent resolver (design D4). dsh's stock SDK server only
 * ever `create()`s, so resuming a session whose JSONL log already exists on disk throws an id-collision.
 * This mirrors dsh's OWN reference host gate (apiproxy api-proxy.ts:1572-1616) at the bridge's stdio
 * face: reuse a live agent / resume a persisted one / create a new one. Ported minus apiproxy's preset
 * roster machinery (knowme-sdk composes no preset). All external types are structurally narrowed here so
 * the bridge never takes a hard build dep on churny dsh internals (B3-small discipline).
 */

interface DshAgent {
  readonly id: string
  readonly followup: (message: unknown) => void
}

// The resolver returns the live dsh agent object itself (not a stripped {id,followup}) so callers invoke
// `agent.followup(msg)` with the agent as `this` — followup reaches into `this.send`, so a detached
// method reference would break at call time.
export type ResolvedAgent = DshAgent

interface AgentHandleLike {
  readonly agent: DshAgent
}

export interface AgentOptionsLike {
  readonly provider: string
  readonly model: string
  readonly maxTokens?: number
}

interface AgentSetupOptionsLike {
  readonly setup?: (agentCtx: object) => Promise<void>
}

interface AgentPresetMountsLike {
  readonly defaultId: string
  resolve(id?: string): Promise<{ readonly id: string }>
  mount(agentCtx: object, id?: string): Promise<{ readonly id: string } | void>
}

export interface SessionLifecycleDeps {
  readonly agents: {
    get: (id: unknown) => DshAgent | undefined
    create: (opts: { sessionId: unknown; meta: { cwd: string }; agentOptions?: AgentOptionsLike } & AgentSetupOptionsLike) => Promise<AgentHandleLike>
    resume: (opts: { resumeSessionId: unknown; agentOptions?: AgentOptionsLike } & AgentSetupOptionsLike) => Promise<AgentHandleLike>
  }
  readonly sessions: { get: (id: unknown) => unknown }
  readonly persistence:
    | {
        list: () => Promise<readonly { readonly id: string; readonly cwd?: string; readonly agentPreset?: string }[]>
        inspect: (id: unknown) => Promise<{
          readonly meta: { readonly id: string; readonly cwd?: string; readonly agentPreset?: string }
          readonly events?: readonly SessionEventLike[]
        }>
      }
    | undefined
  readonly resolveAgentPresets?: () => AgentPresetMountsLike | undefined
}

export interface ResolvePromptInput {
  readonly sessionId: string
  readonly cwd: string
  // undefined = initialize has not run yet (W1): the resolver must refuse rather than default.
  readonly agentOptions: AgentOptionsLike | undefined
}

// Per-id in-flight create/resume so two concurrent prompts for the same session share ONE resolution
// (W3/D6) — a second create/resume would double-register the agent and conflict.
const inFlight = new Map<string, Promise<ResolvedAgent>>()

export function resolvePromptAgent(deps: SessionLifecycleDeps, input: ResolvePromptInput): Promise<ResolvedAgent> {
  const { sessionId } = input
  // Attached-live check runs on EVERY call (W4): a disposed agent is no longer returned by agents.get,
  // so this both fast-paths reuse and avoids handing back a stale handle.
  const liveAgent = deps.agents.get(SessionId(sessionId))
  if (liveAgent !== undefined) return Promise.resolve(liveAgent)

  const pending = inFlight.get(sessionId)
  if (pending !== undefined) return pending

  const resolution = resolveColdAgent(deps, input).finally(() => {
    if (inFlight.get(sessionId) === resolution) inFlight.delete(sessionId)
  })
  inFlight.set(sessionId, resolution)
  return resolution
}

async function resolveColdAgent(deps: SessionLifecycleDeps, input: ResolvePromptInput): Promise<ResolvedAgent> {
  const { sessionId, cwd, agentOptions } = input
  // W1: a prompt before initialize has no route/model — refuse loudly rather than create with defaults.
  if (agentOptions === undefined) {
    throw new Error(`initialize required before session/prompt (session "${sessionId}")`)
  }

  const persisted = deps.persistence === undefined ? undefined : (await deps.persistence.list()).find((h) => h.id === sessionId)
  if (persisted !== undefined && deps.persistence !== undefined) {
    // inspect first: reads the header for the cwd/preset guards and surfaces a torn-log corruption error
    // BEFORE we attempt resume. W2: a corruption here propagates as a clean error — we do NOT fall back
    // to create (a silent fresh-create would re-introduce the id-collision/history-loss class + mask it).
    const inspected = await deps.persistence.inspect(SessionId(sessionId))
    const storedCwd = inspected.meta.cwd
    if (storedCwd !== undefined && storedCwd !== cwd) {
      throw new Error(`session "${sessionId}" cwd conflict: persisted "${storedCwd}" != requested "${cwd}"`)
    }
    const handle = await deps.agents.resume({
      resumeSessionId: SessionId(sessionId),
      agentOptions,
      ...composeAgentSetup(deps, {
        header: inspected.meta.agentPreset === undefined ? {} : { agentPreset: inspected.meta.agentPreset },
        events: inspected.events ?? [],
      }),
    })
    return handle.agent
  }

  const handle = await deps.agents.create({
    sessionId: SessionId(sessionId),
    meta: { cwd },
    agentOptions,
    ...composeAgentSetup(deps, { header: {}, events: [] }),
  })
  return handle.agent
}

function composeAgentSetup(
  deps: SessionLifecycleDeps,
  stored: { readonly header: { readonly agentPreset?: string }; readonly events: readonly SessionEventLike[] },
): AgentSetupOptionsLike {
  const presets = deps.resolveAgentPresets?.()
  if (presets === undefined) return {}
  const resolvedId = resolveSessionPresetFromEvents(stored) ?? presets.defaultId
  return {
    setup: async (agentCtx) => {
      try {
        await presets.mount(agentCtx, resolvedId)
      } catch (error) {
        if (!isMissingPresetError(error)) throw error
        process.stderr.write(`knowme-dsh-bridge: preset "${resolvedId}" could not be mounted; falling back to "${presets.defaultId}"\n`)
        await presets.mount(agentCtx, presets.defaultId)
      }
    },
  }
}

function isMissingPresetError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.name === 'UnknownPresetError' || error.name === 'PresetMountError' || error.message.includes('UnknownPresetError') || error.message.includes('PresetMountError')
}
