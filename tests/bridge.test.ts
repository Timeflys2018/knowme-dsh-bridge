import { describe, expect, it, vi } from 'vitest'

import { createBridge, type BridgeContext } from '../src/bridge.js'
import { BRIDGE_METHODS } from '../src/contract.js'

function fakeCtx(): BridgeContext {
  return {
    get: vi.fn(() => undefined),
    on: vi.fn(() => () => undefined),
  }
}

describe('knowme-dsh-bridge (scaffold)', () => {
  it('rejects unknown methods', async () => {
    const bridge = createBridge(fakeCtx())
    await expect(bridge.handleRequest('bogus/method', {})).rejects.toThrow(/unknown knowme-dsh-bridge method/)
  })

  // The three interaction-control methods are recognized (routed), but their
  // bodies are gated on dsh stable — they throw a "not implemented (gated)"
  // marker rather than "unknown method". This locks the routing contract now;
  // the real forwarding behavior lands post-stable (TDD red -> green then).
  it.each([BRIDGE_METHODS.selectModel, BRIDGE_METHODS.approvalRespond, BRIDGE_METHODS.questionRespond])(
    'routes %s (gated: not yet implemented)',
    async (method) => {
      const bridge = createBridge(fakeCtx())
      await expect(bridge.handleRequest(method, {})).rejects.toThrow(/not implemented \(gated on dsh stable\)/)
    },
  )
})
