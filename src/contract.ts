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
] as const

export type RequiredService = (typeof REQUIRED_SERVICES)[number]

/** Wire method names this bridge adds, namespaced to avoid clashing with the official 5. */
export const BRIDGE_METHODS = {
  selectModel: 'knowme/selectModel',
  approvalRespond: 'knowme/approval-respond',
  questionRespond: 'knowme/question-respond',
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
