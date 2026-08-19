/**
 * The bridge request dispatcher. Mirrors the official
 * HarnessSdkJsonRpcServer.handleRequest switch, but adds the `knowme/*`
 * interaction-control methods that forward to dsh runtime services the stdio
 * SDK surface omits.
 *
 * SCAFFOLD: bodies are TODO until dsh stable release. The signatures + routing
 * are the agreed skeleton; each case forwards to a runtime capability that dsh
 * ALREADY has (verified against source at rc.5/rc.7), it just isn't wired over
 * stdio by the official server.
 */

import { BRIDGE_METHODS } from './contract.js'

/** Minimal structural shape of the cordis context this bridge reads. */
export interface BridgeContext {
  get(service: string, required?: boolean): unknown
  on(event: string, handler: (...args: unknown[]) => unknown): () => void
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
  readonly answers: readonly (readonly string[])[]
}

export interface Bridge {
  handleRequest(method: string, params: Record<string, unknown> | undefined): Promise<unknown>
}

/**
 * Build the bridge over a dsh cordis context. The `ctx.get(...)` calls target
 * dsh runtime services (see contract.REQUIRED_SERVICES).
 */
export function createBridge(ctx: BridgeContext): Bridge {
  return {
    async handleRequest(method, _params): Promise<unknown> {
      switch (method) {
        case BRIDGE_METHODS.selectModel:
          // TODO(gated): forward to host session model selection — changes the
          // session's "next assembled step" model; no process restart.
          // dsh source anchor: packages/host/apiproxy/src/api/sessions.ts:296
          throw new Error('knowme/selectModel: not implemented (gated on dsh stable)')

        case BRIDGE_METHODS.approvalRespond:
          // TODO(gated): resolve the approval service's parked promise.
          // dsh source anchor: packages/core/tools/src/index.ts:1706 (approval.request)
          throw new Error('knowme/approval-respond: not implemented (gated on dsh stable)')

        case BRIDGE_METHODS.questionRespond:
          // TODO(gated): resolve the user-questions provider (dsh-TUI registerProvider pattern).
          throw new Error('knowme/question-respond: not implemented (gated on dsh stable)')

        default:
          throw new Error(`unknown knowme-dsh-bridge method: ${method}`)
      }
      // ctx retained for the gated implementation; reference to satisfy noUnusedParameters.
      void ctx
    },
  }
}
