import { describe, expect, it } from 'vitest'

import { createBridge } from '../src/bridge.js'
import { BRIDGE_METHODS } from '../src/contract.js'
import { fakeBridgeDeps } from './helpers.js'

describe('knowme-dsh-bridge routing contract', () => {
  it('rejects unknown methods', async () => {
    const bridge = createBridge(fakeBridgeDeps().deps)
    await expect(bridge.handleRequest('bogus/method', {})).rejects.toThrow(/unknown knowme-dsh-bridge method/)
    await expect(bridge.handleRequest('knowme/bogus', {})).rejects.toThrow(
      /unknown knowme-dsh-bridge method: knowme\/bogus/,
    )
  })

  // Each bridge method is routed (not "unknown"); with unusable params the
  // method-specific validation error proves dispatch reached the right body.
  it.each([
    [BRIDGE_METHODS.selectModel, /sessionId/],
    [BRIDGE_METHODS.approvalRespond, /sessionId/],
    [BRIDGE_METHODS.questionRespond, /sessionId/],
  ])('routes %s to its own validation', async (method, pattern) => {
    const bridge = createBridge(fakeBridgeDeps().deps)
    await expect(bridge.handleRequest(method, {})).rejects.toThrow(pattern)
  })
})
