/**
 * Bridge dispatcher + interaction-control state machines.
 *
 * Runs inside a dsh deployment (mounted via cordis.yml, see src/index.ts) and
 * adds the `knowme/*` methods over the stdio JSON-RPC channel: each body
 * forwards to a dsh runtime capability that already exists in-process — it is
 * only unwired over stdio by the official server.
 *
 * This module holds no runtime imports on dsh packages (type-only), so unit
 * tests exercise the state machines against structural fakes; src/index.ts
 * injects the real services and the real `installModelSelection`.
 *
 * dsh source anchors (pinned by verify:contract):
 * - approval scan + park: packages/host/apiproxy/src/api-proxy.ts:1391-1457
 * - approval audit events: packages/interaction/user-approval/src/index.ts
 * - question provider:    packages/host/apiproxy/src/api-proxy.ts:1338-1374
 * - model selection:      packages/core/agent/src/model-selection.ts
 */

import { randomUUID } from 'node:crypto'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import {
  BRIDGE_METHODS,
  BRIDGE_NOTIFICATIONS,
  type DshSessionStats,
  ERROR_NAMES,
  type PluginFiberPhase,
  type PluginInventoryItem,
  type QuestionAnswerItem,
} from './contract.js'

export interface SessionEventLike {
  readonly type: string
  readonly data: unknown
}

export interface AgentLike {
  readonly id: string
  readonly session: { readonly id: string; readonly events: readonly SessionEventLike[] }
  readonly ctx: object
}

export interface LlmRouteConfig {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

export interface LlmLike {
  resolveCallConfig(config: LlmRouteConfig): Promise<LlmRouteConfig>
}

export type ModelSelectionLike = LlmRouteConfig

export interface ModelSelectionRefLike {
  current: ModelSelectionLike | undefined
  assembled: ModelSelectionLike | undefined
}

export type ModelSelectionInstaller = (agentCtx: object, selection: ModelSelectionRefLike) => () => void

export interface ApprovalRequestLike {
  readonly agent: AgentLike
  readonly toolName: string
  readonly callId?: string
  readonly reason?: string
  readonly signal?: AbortSignal
}

export type ApprovalAskListener = (
  req: ApprovalRequestLike,
  next: () => Promise<ApprovalOutcome>,
) => Promise<ApprovalOutcome>

export interface QuestionRequestLike {
  readonly questions: readonly unknown[]
  readonly agent?: AgentLike
  readonly signal?: AbortSignal
}

export interface QuestionAnswerLike {
  readonly answers: readonly QuestionAnswerItem[]
}

export interface QuestionProviderLike {
  ask(request: QuestionRequestLike): Promise<QuestionAnswerLike>
}

/**
 * Structural view of one cordis loader entry the plugin projection reads. Mirrors
 * the fields dsh's own PluginInventoryGateway consumes (host/plugin-inventory):
 * `id`, `options.name`/`options.group`, the effective `disabled` getter, and the
 * root `fiber.state` (a cordis FiberState numeric enum). Typed locally so unit
 * tests use structural fakes and the bridge keeps no runtime dsh import.
 */
export interface LoaderEntryLike {
  readonly id: string
  readonly options: { readonly name: string; readonly group?: boolean }
  readonly disabled: boolean
  readonly fiber?: { readonly state: number }
}

export interface LoaderLike {
  entries(): Iterable<LoaderEntryLike>
}

export interface TokenUsageProjectionLike {
  readonly uncachedInputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
}

export interface ContextPressureProjectionLike {
  readonly pressureTokens?: number
  readonly contextWindow?: number
}

export interface ProjectionSnapshotLike {
  readonly values: {
    readonly tokenUsage?: TokenUsageProjectionLike
    readonly contextPressure?: ContextPressureProjectionLike
  }
}

export interface SessionProjectionsLike {
  snapshot(session: object): ProjectionSnapshotLike
}

export interface BridgeDeps {
  readonly agents: { get(sessionId: string): AgentLike | undefined }
  readonly llm?: LlmLike
  /** cordis-plugin-loader entry tree for knowme/listPlugins; absent → empty plugin list. */
  readonly loader?: LoaderLike
  /** cordis token-meter projections for knowme/sessionStats; absent → empty snapshot. */
  readonly sessionProjections?: SessionProjectionsLike
  readonly notify: (method: string, params: object) => void
  readonly installModelSelection?: ModelSelectionInstaller
  readonly logger?: { warn(message: string): void }
}

/**
 * cordis FiberState (numeric const enum) → public phase string. Verbatim mirror
 * of dsh host/plugin-inventory FIBER_PHASE: 0 PENDING, 1 LOADING, 2 ACTIVE,
 * 3 FAILED, 4 DISPOSED (→ null), 5 UNLOADING. verify:contract pins these values.
 */
const FIBER_PHASE: Readonly<Record<number, PluginFiberPhase>> = {
  0: 'pending',
  1: 'loading',
  2: 'active',
  3: 'failed',
  4: null,
  5: 'unloading',
}

/**
 * Minimal structural context apply() reads. Typed as our own interface (not
 * the full cordis Context) so unit tests can mount the plugin on a fake; the
 * real cordis loader passes a real Context at runtime, which satisfies these
 * members (on/effect are bivariant methods).
 */
export interface BridgePluginContext {
  readonly agents: { get(sessionId: string): unknown }
  get(service: string, required?: boolean): unknown
  on(event: string, handler: (...args: never[]) => unknown): () => void
  effect(
    setup: () => void | (() => void | Promise<void>),
    name?: string,
  ): void
  readonly logger: { warn(message: string): void }
  readonly root: { readonly fiber: { dispose(): Promise<void> } }
}

export interface SelectModelParams {
  readonly sessionId: string
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

export interface ApprovalRespondParams {
  readonly sessionId: string
  readonly approvalId: string
  readonly outcome: 'allowed-once' | 'rejected'
}

export interface QuestionRespondParams {
  readonly sessionId: string
  readonly requestId: string
  readonly answers: readonly QuestionAnswerItem[]
}

export interface Bridge {
  handleRequest(method: string, params: Record<string, unknown> | undefined): Promise<unknown>
  readonly approvalAsk: ApprovalAskListener
  readonly questionProvider: QuestionProviderLike
  disableQuestions(reason: string): void
  dispose(): void
}

interface ParkedApproval {
  readonly sessionId: string
  readonly settle: (outcome: ApprovalOutcome) => void
}

interface ParkedQuestion {
  readonly sessionId: string
  readonly resolveAnswer: (answer: QuestionAnswerLike) => void
  readonly rejectAsk: (error: Error) => void
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

function requireString(params: Record<string, unknown> | undefined, method: string, key: string): string {
  const value = params?.[key]
  if (typeof value !== 'string' || value === '') {
    throw new Error(`${method}: ${key} must be a non-empty string`)
  }
  return value
}

/**
 * Recover the approval id for one dispatch from the session's audit log: the
 * newest `approval/asked` that is undecided, unclaimed by another parked
 * entry, and callId-symmetric with the request. Verbatim port of the apiproxy
 * scan (api-proxy.ts:1403-1426). Returns undefined when the ask bypassed the
 * audited path — the caller then delegates to the fail-closed default.
 *
 * Known latent limitation (inherited from the apiproxy, documented in design
 * D3): two concurrently parked callId-less asks can LIFO-swap outcomes; no
 * such asker exists today (the tool executor always passes callId).
 */
export function recoverApprovalId(
  events: readonly SessionEventLike[],
  claimed: ReadonlySet<string>,
  callId: string | undefined,
): string | undefined {
  const decided = new Set<string>()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined) continue
    if (event.type === 'approval/decided') {
      const data = recordOf(event.data)
      if (data !== undefined && typeof data['id'] === 'string') decided.add(data['id'])
    } else if (event.type === 'approval/asked') {
      const data = recordOf(event.data)
      if (data === undefined || typeof data['id'] !== 'string') continue
      if (decided.has(data['id']) || claimed.has(data['id'])) continue
      const eventCallId = data['callId']
      if ((callId ?? null) !== (typeof eventCallId === 'string' ? eventCallId : null)) continue
      return data['id']
    }
  }
  return undefined
}

export function createBridge(deps: BridgeDeps): Bridge {
  const pendingApprovals = new Map<string, ParkedApproval>()
  const pendingQuestions = new Map<string, ParkedQuestion>()
  const selectionRefs = new WeakMap<AgentLike, ModelSelectionRefLike>()
  let questionsUsable = true

  async function selectModel(params: Record<string, unknown> | undefined): Promise<unknown> {
    const method = BRIDGE_METHODS.selectModel
    const sessionId = requireString(params, method, 'sessionId')
    const provider = requireString(params, method, 'provider')
    const model = requireString(params, method, 'model')
    const rawEffort = params?.['reasoningEffort']
    if (rawEffort !== undefined && typeof rawEffort !== 'string') {
      throw new Error(`${method}: reasoningEffort must be a string when supplied`)
    }

    const llm = deps.llm
    if (llm === undefined) {
      throw new Error(`${ERROR_NAMES.llmUnavailable}: ${method} requires the llm service`)
    }
    const agent = deps.agents.get(sessionId)
    if (agent === undefined) {
      throw new Error(`${ERROR_NAMES.sessionNotFound}: ${sessionId}`)
    }

    let resolved: LlmRouteConfig
    try {
      resolved = await llm.resolveCallConfig({
        provider,
        model,
        ...(rawEffort === undefined ? {} : { reasoningEffort: rawEffort }),
      })
    } catch (error) {
      throw new Error(`${ERROR_NAMES.modelUnavailable}: ${error instanceof Error ? error.message : String(error)} (${provider}/${model})`)
    }

    let ref = selectionRefs.get(agent)
    if (ref === undefined) {
      ref = { current: undefined, assembled: undefined }
      selectionRefs.set(agent, ref)
      // Disposer intentionally dropped: cleanup rides the agent's scoped-context
      // disposal; the WeakMap is a cache, not a lifetime owner (design D2).
      deps.installModelSelection?.(agent.ctx, ref)
    }
    const selected: ModelSelectionLike = {
      provider: resolved.provider,
      model: resolved.model,
      ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort }),
    }
    ref.current = selected
    return { selected }
  }

  async function approvalRespond(params: Record<string, unknown> | undefined): Promise<unknown> {
    const method = BRIDGE_METHODS.approvalRespond
    const sessionId = requireString(params, method, 'sessionId')
    const approvalId = requireString(params, method, 'approvalId')
    const outcome = params?.['outcome']
    if (outcome !== 'allowed-once' && outcome !== 'rejected') {
      throw new Error(`${method}: outcome must be 'allowed-once' or 'rejected' (got ${JSON.stringify(outcome)})`)
    }
    // Lookup-and-settle is one synchronous block: teardown and abort listeners
    // cannot interleave, so first-settle-wins is guaranteed (design D3 step 5).
    const entry = pendingApprovals.get(approvalId)
    if (entry === undefined || entry.sessionId !== sessionId) {
      throw new Error(`${ERROR_NAMES.approvalNotFound}: ${approvalId}`)
    }
    entry.settle(outcome)
    return { resolved: true }
  }

  async function questionRespond(params: Record<string, unknown> | undefined): Promise<unknown> {
    const method = BRIDGE_METHODS.questionRespond
    if (!questionsUsable) {
      throw new Error(`${ERROR_NAMES.userQuestionsUnavailable}: ${method} is degraded (question provider not registered)`)
    }
    const sessionId = requireString(params, method, 'sessionId')
    const requestId = requireString(params, method, 'requestId')
    const answers = parseAnswerItems(params?.['answers'])

    const entry = pendingQuestions.get(requestId)
    if (entry === undefined || entry.sessionId !== sessionId) {
      throw new Error(`${ERROR_NAMES.questionNotFound}: ${requestId}`)
    }
    entry.resolveAnswer({ answers })
    return { resolved: true }
  }

  function parseAnswerItems(value: unknown): QuestionAnswerItem[] {
    if (!Array.isArray(value)) {
      throw new Error(`${BRIDGE_METHODS.questionRespond}: answers must be an array`)
    }
    const items: QuestionAnswerItem[] = []
    for (const raw of value) {
      const item = recordOf(raw)
      if (item === undefined || typeof item['id'] !== 'string' || !Array.isArray(item['selected'])) {
        throw new Error(`${BRIDGE_METHODS.questionRespond}: each answer item needs a string id and an array selected`)
      }
      const selected: string[] = []
      for (const label of item['selected']) {
        if (typeof label !== 'string') {
          throw new Error(`${BRIDGE_METHODS.questionRespond}: selected labels must be strings`)
        }
        selected.push(label)
      }
      const custom = item['custom']
      items.push({
        id: item['id'],
        selected,
        ...(typeof custom === 'string' ? { custom } : {}),
      })
    }
    return items
  }

  async function listPlugins(): Promise<{ entries: PluginInventoryItem[] }> {
    // Read the loader directly (no cache), mirroring dsh's own PluginInventoryGateway.list()
    // (host/plugin-inventory): skip group container entries, project each leaf entry. An absent
    // loader (not composed) degrades to an empty list rather than failing the sidebar fetch.
    const loader = deps.loader
    if (loader === undefined) return { entries: [] }
    const entries: PluginInventoryItem[] = []
    for (const entry of loader.entries()) {
      if (entry.options.group === true) continue
      entries.push({
        entryId: entry.id,
        moduleName: entry.options.name,
        enabled: !entry.disabled,
        fiberPhase: entry.fiber === undefined ? null : (FIBER_PHASE[entry.fiber.state] ?? null),
      })
    }
    return { entries }
  }

  async function sessionStats(params: Record<string, unknown> | undefined): Promise<DshSessionStats> {
    const sessionId = requireString(params, BRIDGE_METHODS.sessionStats, 'sessionId')
    const empty: DshSessionStats = { inputTokens: 0, outputTokens: 0 }
    const projections = deps.sessionProjections
    const agent = deps.agents.get(sessionId)
    if (projections === undefined || agent === undefined) return empty

    const { tokenUsage, contextPressure } = projections.snapshot(agent.session).values
    const stats: {
      inputTokens: number
      outputTokens: number
      cacheReadTokens?: number
      cacheWriteTokens?: number
      contextPressure?: { tokens: number; window?: number }
    } = {
      inputTokens: tokenUsage?.uncachedInputTokens ?? 0,
      outputTokens: tokenUsage?.outputTokens ?? 0,
    }
    if (tokenUsage?.cacheReadTokens !== undefined) stats.cacheReadTokens = tokenUsage.cacheReadTokens
    if (tokenUsage?.cacheWriteTokens !== undefined) stats.cacheWriteTokens = tokenUsage.cacheWriteTokens
    if (contextPressure?.pressureTokens !== undefined) {
      stats.contextPressure = {
        tokens: contextPressure.pressureTokens,
        ...(contextPressure.contextWindow === undefined ? {} : { window: contextPressure.contextWindow }),
      }
    }
    return stats
  }

  const approvalAsk: ApprovalAskListener = (req, next) => {
    // Microtask-race guard (api-proxy.ts:1396): an abort that landed before
    // this listener ran must never register a never-firing listener.
    if (req.signal?.aborted === true) return Promise.resolve<ApprovalOutcome>('cancelled')

    const approvalId = recoverApprovalId(req.agent.session.events, new Set(pendingApprovals.keys()), req.callId)
    if (approvalId === undefined) return next()

    return new Promise<ApprovalOutcome>((resolve) => {
      const settle = (outcome: ApprovalOutcome): void => {
        if (!pendingApprovals.delete(approvalId)) return
        req.signal?.removeEventListener('abort', onAbort)
        resolve(outcome)
      }
      const onAbort = (): void => { settle('cancelled') }
      pendingApprovals.set(approvalId, { sessionId: req.agent.session.id, settle })
      req.signal?.addEventListener('abort', onAbort, { once: true })
      deps.notify(BRIDGE_NOTIFICATIONS.approvalRequested, {
        sessionId: req.agent.session.id,
        approvalId,
        toolName: req.toolName,
        ...(req.callId === undefined ? {} : { callId: req.callId }),
        ...(req.reason === undefined ? {} : { reason: req.reason }),
      })
    })
  }

  const questionProvider: QuestionProviderLike = {
    ask(request) {
      const agent = request.agent
      if (agent === undefined) {
        return Promise.reject(new Error(
          'knowme question bridge: stdio user interaction requires an agent-owned session (ASK_MISSING_AGENT)',
        ))
      }
      // Microtask-race guard mirroring approvalAsk: a signal that aborted
      // before ask() ran must never park (the registered listener would never
      // fire and the entry would dangle until teardown).
      if (request.signal?.aborted === true) {
        return Promise.reject(new Error(
          'knowme question bridge: ask was aborted before the user answered (ASK_ABORTED)',
        ))
      }
      return new Promise<QuestionAnswerLike>((resolve, reject) => {
        const requestId = randomUUID()
        const claim = (run: () => void): void => {
          if (!pendingQuestions.delete(requestId)) return
          request.signal?.removeEventListener('abort', onAbort)
          run()
        }
        const onAbort = (): void => {
          claim(() => reject(new Error('knowme question bridge: ask was aborted before the user answered (ASK_ABORTED)')))
        }
        pendingQuestions.set(requestId, {
          sessionId: agent.session.id,
          resolveAnswer: (answer) => { claim(() => resolve(answer)) },
          rejectAsk: (error) => { claim(() => reject(error)) },
        })
        request.signal?.addEventListener('abort', onAbort, { once: true })
        deps.notify(BRIDGE_NOTIFICATIONS.questionRequested, {
          sessionId: agent.session.id,
          requestId,
          questions: request.questions,
        })
      })
    },
  }

  return {
    async handleRequest(method, params) {
      switch (method) {
        case BRIDGE_METHODS.selectModel:
          return selectModel(params)
        case BRIDGE_METHODS.approvalRespond:
          return approvalRespond(params)
        case BRIDGE_METHODS.questionRespond:
          return questionRespond(params)
        case BRIDGE_METHODS.listPlugins:
          return listPlugins()
        case BRIDGE_METHODS.sessionStats:
          return sessionStats(params)
        default:
          throw new Error(`unknown knowme-dsh-bridge method: ${method}`)
      }
    },
    approvalAsk,
    questionProvider,
    disableQuestions(reason) {
      questionsUsable = false
      deps.logger?.warn(`knowme-dsh-bridge: question methods degraded: ${reason}`)
    },
    dispose() {
      for (const entry of [...pendingApprovals.values()]) entry.settle('cancelled')
      for (const entry of [...pendingQuestions.values()]) {
        entry.rejectAsk(new Error('knowme question bridge: disposed before the user answered (ASK_ABORTED)'))
      }
    },
  }
}
