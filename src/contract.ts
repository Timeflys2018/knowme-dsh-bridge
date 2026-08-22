/**
 * Pinned dsh contract this bridge depends on. `verify:contract` diffs the live
 * dsh package versions + the runtime service interfaces named here, so a dsh
 * breaking change fails CI BEFORE the bridge silently breaks.
 *
 * dsh is developer-preview ("THERE WILL BE COMPATIBILITY-BREAKING CHANGES") —
 * keep this surface as small as possible (B3-small discipline).
 */

/** dsh version line this bridge is validated against. */
export const PINNED_DSH_VERSION = '0.1.0-rc.8'

/**
 * The dsh runtime cordis services this bridge reads.
 * Every entry here is a maintenance liability when dsh changes — keep minimal.
 *
 * Mechanisms differ per service (see design D5.2):
 * - `agents` is a hard inject (mirrors the official jsonrpc-server).
 * - `llm` and `userQuestions` are actively soft-probed via ctx.get; absence
 *   degrades their methods to `llm-unavailable` / `user-questions-unavailable`.
 * - `approval` is passively degraded: the bridge only listens to the
 *   `approval/request` waterfall (never calls ctx.get('approval')), so an
 *   absent service means no asks ever park and approval-respond returns
 *   `approval-not-found`. There is no `approval-unavailable` by design.
 */
export const REQUIRED_SERVICES = [
  'agents', // session create/get (hard inject; keyed by SessionId)
  'llm', // provider/model routing for knowme/selectModel
  'approval', // approval/request waterfall + audit events for knowme/approval-respond
  'userQuestions', // ask-user provider for knowme/question-respond
  'loader', // cordis-plugin-loader entry tree for knowme/listPlugins (soft-probed; absent → empty list)
  'sessionProjections', // per-session token/context telemetry for knowme/sessionStats (soft-probed; absent → empty snapshot)
  'permissionPresets', // sandbox/approval preset get/set for knowme/permission.* (soft-probed; absent → permission-unavailable / empty)
  'agentPresets', // agent mode roster/recompose for knowme/agentPreset.* (soft-probed; absent → empty read / invalid set)
  'commands', // slash-command list/execute for knowme/commands.* (soft-probed, resolved lazily per call; absent → commands-unavailable / empty)
] as const

export type RequiredService = (typeof REQUIRED_SERVICES)[number]

/** Wire method names this bridge adds, namespaced to avoid clashing with the official 5. */
export const BRIDGE_METHODS = {
  selectModel: 'knowme/selectModel',
  approvalRespond: 'knowme/approval-respond',
  questionRespond: 'knowme/question-respond',
  listPlugins: 'knowme/listPlugins',
  sessionStats: 'knowme/sessionStats',
  permissionGet: 'knowme/permission.get',
  permissionSet: 'knowme/permission.set',
  agentPresetGet: 'knowme/agentPreset.get',
  agentPresetSet: 'knowme/agentPreset.set',
  commandsList: 'knowme/commands.list',
  commandsExecute: 'knowme/commands.execute',
} as const

/** Notification method names this bridge pushes to the out-of-process client. */
export const BRIDGE_NOTIFICATIONS = {
  approvalRequested: 'knowme/approval-requested',
  questionRequested: 'knowme/question-requested',
} as const

/**
 * Error taxonomy for `knowme/*` method failures. These ride as JSON-RPC error
 * messages (the transport maps handler rejections to -32603 with the message);
 * the names are the stable wire contract.
 */
export const ERROR_NAMES = {
  sessionNotFound: 'session-not-found',
  modelUnavailable: 'model-unavailable',
  llmUnavailable: 'llm-unavailable',
  approvalNotFound: 'approval-not-found',
  questionNotFound: 'question-not-found',
  userQuestionsUnavailable: 'user-questions-unavailable',
  permissionUnavailable: 'permission-unavailable',
  unknownPreset: 'unknown-preset',
  permissionLocked: 'permission-locked',
  permissionWriteFailed: 'permission-write-failed',
  agentPresetLocked: 'agent-preset-locked',
  agentPresetNotFound: 'agent-preset-not-found',
  agentPresetInvalid: 'agent-preset-invalid',
  agentPresetAppendFailed: 'agent-preset-append-failed',
  commandsUnavailable: 'commands-unavailable',
  unknownCommand: 'unknown-command',
  commandFailed: 'command-failed',
} as const

/**
 * One answer item for `knowme/question-respond` — the full dsh
 * `AskUserQuestionAnswerItem` shape (`{id, selected, custom?}`), keyed by
 * question id so a multi-question ask maps losslessly.
 */
export interface QuestionAnswerItem {
  /** The answered question id. */
  readonly id: string
  /** Selected option labels (may accompany custom text for multi-select). */
  readonly selected: readonly string[]
  /** Optional free-text "Other" answer. */
  readonly custom?: string
}

/**
 * Lifecycle phase of a plugin entry's root cordis Fiber, or null when it has no
 * live root fiber (disposed). Mirrors dsh host/plugin-inventory PluginFiberPhase.
 */
export type PluginFiberPhase = 'pending' | 'loading' | 'active' | 'failed' | 'unloading' | null

/**
 * One loaded dsh plugin entry, projected from the cordis loader entry tree for
 * `knowme/listPlugins`. Field-identical to dsh's own PluginInventoryEntry
 * (host/plugin-inventory/src/types.ts), which its Web Plugins settings tab uses.
 */
export interface PluginInventoryItem {
  /** Stable loader-tree id of the entry. */
  readonly entryId: string
  /** Exact module specifier the loader imported, e.g. '@deepseek-ai/dsh-agent'. */
  readonly moduleName: string
  /** Effective loader enablement (false if the entry or an ancestor group is disabled). */
  readonly enabled: boolean
  /** Root fiber phase, or null when disposed. */
  readonly fiberPhase: PluginFiberPhase
}

/**
 * Normalized per-session telemetry snapshot for `knowme/sessionStats`, read
 * in-process from dsh's `sessionProjections` (the cordis token-meter
 * projections composed in dsh-base). Field-identical to the KnowMe-side
 * `DshSessionStats` (no shared package — the two declarations are kept in sync
 * by a drift guard + post-impl mirror review).
 *
 * DELIVERED this change (token-meter-derived, always present as numbers):
 * `inputTokens`/`outputTokens`/`cacheReadTokens`/`cacheWriteTokens`, and
 * `contextPressure` WHEN the session has produced provider usage.
 *
 * RESERVED-OPTIONAL (session-stats-derived; `@deepseek-ai/dsh-session-stats` is
 * NOT composed in the knowme-sdk profile, so these are ABSENT this change — the
 * fields exist so composing session-stats later is zero-rework): turns, steps,
 * timing, throughput, cache-hit ratio.
 */
export interface DshSessionStats {
  /** Cumulative uncached input tokens (mapped from `tokenUsage.uncachedInputTokens`). */
  readonly inputTokens: number
  /** Cumulative output tokens (from `tokenUsage.outputTokens`). */
  readonly outputTokens: number
  /** Cumulative cache-read tokens, when the projection carries them. */
  readonly cacheReadTokens?: number
  /** Cumulative cache-write tokens, when the projection carries them. */
  readonly cacheWriteTokens?: number
  /**
   * Context-window occupancy. PRESENT iff the session produced provider usage
   * (dsh `ContextPressureProjection.pressureTokens` is set). `undefined`
   * distinguishes "runtime not started / no data" from a real "0 tokens".
   */
  readonly contextPressure?: {
    /** Prompt size of the most recent request (`pressureTokens`). */
    readonly tokens: number
    /** Model context window (`contextWindow`), when the adapter advertised one. */
    readonly window?: number
  }
  readonly turns?: number
  readonly steps?: number
  readonly llmMs?: number
  readonly toolMs?: number
  readonly firstTokenMs?: number
  readonly tokPerSec?: number
  readonly cacheHitRatio?: number
}

/**
 * A dsh session's permission preset snapshot for `knowme/permission.get` — the
 * current preset id and the selectable options, projected from dsh's
 * `permissions` projection. `preset` is null when the projection is absent
 * (permission-presets not composed) or the session has no live agent, so the
 * consumer hides the control. `preset` may be `'custom'` (a fold that matches no
 * named preset) — a valid read value but never a `knowme/permission.set` target.
 */
export interface DshPermission {
  readonly preset: string | null
  readonly options: readonly { readonly value: string; readonly name: string; readonly description?: string }[]
}

/**
 * A dsh session's agent preset snapshot for `knowme/agentPreset.get` — the
 * current composition id, live roster, default, and whether the blank-only
 * switch is locked by a recorded turn.
 */
export interface DshAgentPreset {
  readonly preset: string | null
  readonly options: readonly { readonly value: string; readonly name: string; readonly description?: string }[]
  readonly default: string | null
  readonly locked: boolean
}

/**
 * One dsh slash command for `knowme/commands.list`, projected from a
 * `CommandDescriptor`. `input` is present when the command takes an argument
 * (its `hint` is the placeholder; `images` whether it accepts attachments).
 */
export interface DshCommand {
  readonly name: string
  readonly description: string
  readonly input?: { readonly hint: string; readonly images?: boolean }
}

/**
 * The result of `knowme/commands.execute` — the dsh `CommandExecution` verbatim.
 * `result.text` is the ONLY user-visible output (a dsh command is log-only: it
 * writes command/run+command/done session events but runs no turn, so nothing
 * is mirrored into the KnowMe transcript). `commandId` is the dsh command id.
 */
export interface DshCommandExecution {
  readonly commandId: string
  readonly result: { readonly kind: 'success'; readonly text?: string } | { readonly kind: 'error'; readonly text: string }
}
