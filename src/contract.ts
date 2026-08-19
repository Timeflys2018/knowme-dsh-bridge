/**
 * Pinned dsh contract this bridge depends on. `verify:contract` diffs the live
 * dsh package versions + the runtime service interfaces named here, so a dsh
 * breaking change fails CI BEFORE the bridge silently breaks.
 *
 * dsh is developer-preview ("THERE WILL BE COMPATIBILITY-BREAKING CHANGES") —
 * keep this surface as small as possible (B3-small discipline).
 */

/** dsh version line this bridge is validated against. */
export const PINNED_DSH_VERSION = '0.1.0-rc.7'

/**
 * The dsh runtime cordis services this bridge reads via `ctx.get(...)`.
 * Every entry here is a maintenance liability when dsh changes — keep minimal.
 */
export const REQUIRED_SERVICES = [
  'agents', // session create/get (already required by the official jsonrpc-server)
  'llm', // provider/model routing for knowme/selectModel
  'approval', // parked approval requests for knowme/approval-respond
  'userQuestions', // ask-user provider for knowme/question-respond
  'sessions', // session lookup for model selection
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
