/**
 * @knowme/dsh-bridge — B3-small wire-bridge cordis plugin entry.
 *
 * Mounts into a dsh deployment's cordis.yml (see cordis.example.yml) IN PLACE
 * of `@deepseek-ai/dsh-sdk-jsonrpc-server`: this plugin owns the single stdio
 * JsonRpcLineTransport, constructs the official HarnessSdkJsonRpcServer over
 * that same instance, and routes by method prefix — `knowme/*` to the bridge,
 * everything else to the official server. Official notifications
 * (session.event / session.status / subagent.*) flow over the shared
 * transport unchanged.
 *
 * dsh source anchors (pinned by verify:contract):
 * - official apply lifecycle replicated here: packages/sdk/server/src/index.ts:46-92
 * - shutdown→flush→root-dispose→exit choreography: same file, disposeAndExit
 */

import Schema from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import type { SessionPromptParams } from '@deepseek-ai/dsh-sdk-protocol'
import { HarnessSdkJsonRpcServer } from '@deepseek-ai/dsh-sdk-jsonrpc-server'
import type { Readable, Writable } from 'node:stream'
import {
  createBridge,
  type AgentLike,
  type BridgePluginContext,
  type LlmLike,
  type LoaderLike,
  type PermissionPresetsLike,
  type ApprovalServiceLike,
  type CommandsServiceLike,
  type ModelSelectionInstaller,
  type QuestionProviderLike,
  type SessionProjectionsLike,
} from './bridge.js'
import { resolvePromptAgent, type AgentOptionsLike, type SessionLifecycleDeps } from './session-lifecycle.js'

export { createBridge, recoverApprovalId } from './bridge.js'
export type {
  AgentLike, ApprovalAskListener, ApprovalRequestLike, Bridge, BridgeDeps, LlmLike,
  LoaderLike, LoaderEntryLike,
  ModelSelectionInstaller, ModelSelectionRefLike, QuestionProviderLike, QuestionRequestLike,
  SessionProjectionsLike, ProjectionSnapshotLike, TokenUsageProjectionLike, ContextPressureProjectionLike,
} from './bridge.js'
export { BRIDGE_METHODS, BRIDGE_NOTIFICATIONS, ERROR_NAMES, REQUIRED_SERVICES, PINNED_DSH_VERSION } from './contract.js'
export type { PluginFiberPhase, PluginInventoryItem, DshSessionStats, DshPermission, DshCommand, DshCommandExecution } from './contract.js'

/** Stable cordis plugin name (referenced from cordis.yml). */
export const name = 'knowme-sdk-bridge'

/**
 * Hard dependencies. The official jsonrpc-server already requires `agents`;
 * the optional services (`llm`, `userQuestions`) are soft-probed — a missing
 * service degrades its own method instead of failing plugin load. `approval`
 * is consumed passively through the `approval/request` waterfall.
 */
export const inject = ['agents', 'sessions', 'sessionPersistence'] as const

/** JSON-RPC deployment config plus runtime-only test hooks (mirrors the official server). */
export interface JsonRpcConfig {
  /** Report max-token turn/subagent termination as a successful SDK result. */
  maxTokensAsSuccess?: boolean
  /** Transport input override; production uses `process.stdin`. */
  input?: Readable
  /** Transport output override; production uses `process.stdout`. */
  output?: Writable
  /** Process-exit override; production uses `process.exit`. */
  exit?: (code: number) => void
}

export const Config: Schema<JsonRpcConfig> = Schema.object({
  maxTokensAsSuccess: Schema.boolean().default(false),
})

export function apply(ctx: BridgePluginContext, config: JsonRpcConfig): void {
  const input = config.input ?? process.stdin
  const output = config.output ?? process.stdout
  const exit = config.exit ?? ((code: number): void => { process.exit(code) })

  const transport = new JsonRpcLineTransport(input, output)

  const installRealSelection: ModelSelectionInstaller = (agentCtx, ref) =>
    // Boundary downcast: agentCtx is a real agent Context and ref is
    // field-identical to dsh's ModelSelectionRef; the bridge types
    // deliberately avoid importing the full cordis Context shape.
    installModelSelection(agentCtx as unknown as Context, ref as unknown as ModelSelectionRef)

  const llm = ctx.get('llm') as LlmLike | undefined
  // Soft-probe the cordis loader (present in every booted profile) for knowme/listPlugins;
  // absent → the bridge degrades that method to an empty list (see bridge.ts listPlugins).
  const loader = ctx.get('loader') as LoaderLike | undefined
  const sessionProjections = ctx.get('sessionProjections') as SessionProjectionsLike | undefined
  // Resolve permission-presets (composed in dsh-base) + the approval service LAZILY, per knowme/permission.set
  // call — NOT once here. This apply() runs before those fibers reach ACTIVE state, so ctx.get(strict) returns
  // undefined at boot; by the time a user switches a preset every fiber is active. A late probe is the only
  // reliable read (proven by CDP: an apply()-time cache returned permission-unavailable in the bundled profile).
  const bridge = createBridge({
    agents: ctx.agents as { get(sessionId: string): AgentLike | undefined },
    ...(llm === undefined ? {} : { llm }),
    ...(loader === undefined ? {} : { loader }),
    ...(sessionProjections === undefined ? {} : { sessionProjections }),
    resolvePermissionPresets: () => ctx.get('permissionPresets') as PermissionPresetsLike | undefined,
    resolveApprovalService: () => ctx.get('approval') as ApprovalServiceLike | undefined,
    resolveCommands: () => ctx.get('commands') as CommandsServiceLike | undefined,
    notify: (method, params) => { transport.notify(method, params) },
    installModelSelection: installRealSelection,
    logger: ctx.logger,
  })

  const server = new HarnessSdkJsonRpcServer(
    // Boundary downcast: same rationale as installRealSelection.
    ctx as unknown as Context,
    transport,
    { maxTokensAsSuccess: config.maxTokensAsSuccess === true },
  )

  let exitTask: Promise<void> | undefined
  const disposeAndExit = (): Promise<void> => {
    exitTask ??= (async () => {
      await Promise.allSettled([Promise.resolve().then(() => transport.flush())])
      await Promise.allSettled([Promise.resolve().then(() => ctx.root.fiber.dispose())])
      exit(0)
    })()
    return exitTask
  }

  // The stock server's cwd/provider/model are private (set at initialize); the bridge captures them
  // from the request stream so it can construct/resume agents itself for session/prompt (design D3).
  let initParams: { cwd: string; agentOptions: AgentOptionsLike } | undefined
  const lifecycleDeps: SessionLifecycleDeps = {
    agents: ctx.agents as SessionLifecycleDeps['agents'],
    sessions: ctx.get('sessions') as SessionLifecycleDeps['sessions'],
    persistence: ctx.get('sessionPersistence') as SessionLifecycleDeps['persistence'],
  }

  transport.onRequest(async (method, params) => {
    if (method.startsWith('knowme/')) return bridge.handleRequest(method, params)
    if (method === 'initialize') {
      // Capture params for our own create/resume, THEN delegate initialize to the stock server
      // unchanged (adapter mount, provider/model/cwd binding, deepseek fallback).
      const p = (params ?? {}) as { cwd?: string; provider?: string; model?: string; maxTokens?: number }
      if (typeof p.cwd === 'string' && typeof p.provider === 'string' && typeof p.model === 'string') {
        initParams = {
          cwd: p.cwd,
          agentOptions: { provider: p.provider, model: p.model, ...(typeof p.maxTokens === 'number' ? { maxTokens: p.maxTokens } : {}) },
        }
      }
      return server.handleRequest(method, params)
    }
    if (method === 'session/prompt') {
      // Bridge owns session/prompt lifecycle: three-state resolve (reuse/resume/create) so a persisted
      // session reopens its JSONL instead of colliding on create (design D4). Delivery mirrors the stock
      // server's prompt(): createUserMessage + agent.followup → { messageId }.
      const p = (params ?? {}) as Partial<SessionPromptParams>
      if (typeof p.sessionId !== 'string') throw new Error('session/prompt: sessionId must be a string')
      const agent = await resolvePromptAgent(lifecycleDeps, {
        sessionId: p.sessionId,
        cwd: initParams?.cwd ?? '',
        agentOptions: initParams?.agentOptions,
      })
      const message = createUserMessage({ content: p.contentBlocks ?? [], source: { kind: 'user' } })
      agent.followup(message)
      return { messageId: message.id }
    }
    const result = await server.handleRequest(method, params)
    if (method === 'shutdown') {
      setImmediate(() => { void disposeAndExit() })
    }
    return result
  })

  // Registration order is load-bearing (cordis disposes effects in reverse):
  // the serve effect is registered FIRST so it is disposed LAST — the parks
  // teardown below settles pending approvals/questions BEFORE the official
  // server's shutdown disposes agents and closes the transport, keeping the
  // settle → approval/decided audit append → session/event chain alive while
  // persistence and subscribers still run (design D1). The bridge does NOT
  // dispose the agents it creates: they are owned by the AgentRegistry service
  // ctx and drained on ITS unload (composed before the bridge, disposed after),
  // which fires agent/disposed AFTER this settle enqueues approval/decided —
  // an explicit bridge-side dispose here races that append and drops it.
  ctx.effect(() => {
    transport.start()
    return async () => {
      await server.shutdown()
      transport.close()
    }
  }, 'knowme-bridge.serve')

  ctx.effect(() => () => { bridge.dispose() }, 'knowme-bridge.parks')

  ctx.on('approval/request', bridge.approvalAsk)

  const userQuestions = ctx.get('userQuestions') as { registerProvider(provider: QuestionProviderLike): () => void } | undefined
  if (userQuestions === undefined) {
    bridge.disableQuestions('userQuestions service not composed before the bridge')
    return
  }
  try {
    ctx.effect(() => {
      const disposeProvider = userQuestions.registerProvider(bridge.questionProvider)
      return () => { disposeProvider() }
    }, 'knowme-bridge.questions')
  } catch (error) {
    // Best-effort catch for a synchronously-throwing registerProvider (e.g.
    // DUPLICATE_PROVIDER); if the host defers the throw into fiber startup the
    // plugin load fails loudly, which the spike exercises for real.
    bridge.disableQuestions(`provider registration failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}
