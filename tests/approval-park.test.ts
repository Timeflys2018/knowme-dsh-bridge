import { describe, expect, it } from 'vitest'

import { createBridge, recoverApprovalId } from '../src/bridge.js'
import { BRIDGE_METHODS, BRIDGE_NOTIFICATIONS } from '../src/contract.js'
import { askedEvent, decidedEvent, fakeBridgeDeps } from './helpers.js'

function park(opts: { events?: ReturnType<typeof askedEvent>[]; callId?: string; reason?: string } = {}) {
  const harness = fakeBridgeDeps()
  const agent = harness.makeAgent('sess-1', opts.events ?? [askedEvent('appr-1', 'call-9')])
  const bridge = createBridge(harness.deps)
  const next = vi.fnNext()
  const callId = 'callId' in opts ? opts.callId : 'call-9'
  const askPromise = bridge.approvalAsk(
    {
      agent,
      toolName: 'bash',
      callId,
      ...(opts.reason === undefined ? {} : { reason: opts.reason }),
    },
    next,
  )
  return { harness, bridge, askPromise, next }
}

const vi = {
  fnNext: () => {
    let calls = 0
    const fn = async () => { calls += 1; return 'unavailable' as const }
    Object.defineProperty(fn, 'calls', { get: () => calls })
    return fn
  },
}

describe('recoverApprovalId (pure scan)', () => {
  it('picks the newest undecided unclaimed asked with matching callId', () => {
    const events = [
      askedEvent('appr-old', 'call-1'),
      decidedEvent('appr-old'),
      askedEvent('appr-2', 'call-2'),
      askedEvent('appr-1', 'call-1'),
    ]
    expect(recoverApprovalId(events, new Set(), 'call-1')).toBe('appr-1')
    expect(recoverApprovalId(events, new Set(), 'call-2')).toBe('appr-2')
  })

  it('skips ids already decided later in the log', () => {
    const events = [askedEvent('appr-1', 'call-1'), askedEvent('appr-2', 'call-1'), decidedEvent('appr-2')]
    expect(recoverApprovalId(events, new Set(), 'call-1')).toBe('appr-1')
  })

  it('skips ids claimed by other parked entries', () => {
    const events = [askedEvent('appr-1', 'call-1'), askedEvent('appr-2', 'call-1')]
    expect(recoverApprovalId(events, new Set(['appr-2']), 'call-1')).toBe('appr-1')
    expect(recoverApprovalId(events, new Set(['appr-1', 'appr-2']), 'call-1')).toBeUndefined()
  })

  it('enforces callId symmetry (callId-less request only takes callId-less asked)', () => {
    const events = [askedEvent('appr-with-call', 'call-1'), askedEvent('appr-no-call')]
    expect(recoverApprovalId(events, new Set(), undefined)).toBe('appr-no-call')
    expect(recoverApprovalId(events, new Set(), 'call-1')).toBe('appr-with-call')
    expect(recoverApprovalId(events, new Set(), 'call-other')).toBeUndefined()
  })

  it('returns undefined for an empty or unrelated log (delegation signal)', () => {
    expect(recoverApprovalId([], new Set(), 'call-1')).toBeUndefined()
    expect(recoverApprovalId([{ type: 'session/message', data: {} }], new Set(), 'call-1')).toBeUndefined()
  })
})

describe('approval park round-trip', () => {
  it('parks an ask, pushes approval-requested, and settles via respond', async () => {
    const { harness, bridge, askPromise } = park({ reason: 'dangerous' })
    await Promise.resolve()
    expect(harness.notifications).toEqual([{
      method: BRIDGE_NOTIFICATIONS.approvalRequested,
      params: { sessionId: 'sess-1', approvalId: 'appr-1', toolName: 'bash', callId: 'call-9', reason: 'dangerous' },
    }])
    await expect(bridge.handleRequest(BRIDGE_METHODS.approvalRespond, {
      sessionId: 'sess-1', approvalId: 'appr-1', outcome: 'allowed-once',
    })).resolves.toEqual({ resolved: true })
    await expect(askPromise).resolves.toBe('allowed-once')
  })

  it('omits callId/reason keys from the notification when absent', async () => {
    const { harness } = park({ events: [askedEvent('appr-1')], callId: undefined })
    await Promise.resolve()
    expect(harness.notifications[0]?.params).not.toHaveProperty('callId')
    expect(harness.notifications[0]?.params).not.toHaveProperty('reason')
  })

  it('reject outcome denies the parked promise', async () => {
    const { bridge, askPromise } = park()
    await bridge.handleRequest(BRIDGE_METHODS.approvalRespond, {
      sessionId: 'sess-1', approvalId: 'appr-1', outcome: 'rejected',
    })
    await expect(askPromise).resolves.toBe('rejected')
  })

  it('respond with a smuggled internal outcome is a validation error', async () => {
    const { bridge, askPromise } = park()
    await expect(bridge.handleRequest(BRIDGE_METHODS.approvalRespond, {
      sessionId: 'sess-1', approvalId: 'appr-1', outcome: 'cancelled',
    })).rejects.toThrow(/outcome must be/)
    await bridge.handleRequest(BRIDGE_METHODS.approvalRespond, {
      sessionId: 'sess-1', approvalId: 'appr-1', outcome: 'allowed-once',
    })
    await expect(askPromise).resolves.toBe('allowed-once')
  })
})

describe('approval-not-found taxonomy', () => {
  it('unknown approvalId rejects with approval-not-found', async () => {
    const { bridge } = park()
    await expect(bridge.handleRequest(BRIDGE_METHODS.approvalRespond, {
      sessionId: 'sess-1', approvalId: 'nope', outcome: 'rejected',
    })).rejects.toThrow(/approval-not-found/)
  })

  it('sessionId mismatch collapses into the same approval-not-found', async () => {
    const { bridge } = park()
    await expect(bridge.handleRequest(BRIDGE_METHODS.approvalRespond, {
      sessionId: 'other-session', approvalId: 'appr-1', outcome: 'rejected',
    })).rejects.toThrow(/approval-not-found/)
  })

  it('a second respond for an already-settled approval rejects (idempotent collapse)', async () => {
    const { bridge } = park()
    await bridge.handleRequest(BRIDGE_METHODS.approvalRespond, {
      sessionId: 'sess-1', approvalId: 'appr-1', outcome: 'allowed-once',
    })
    await expect(bridge.handleRequest(BRIDGE_METHODS.approvalRespond, {
      sessionId: 'sess-1', approvalId: 'appr-1', outcome: 'rejected',
    })).rejects.toThrow(/approval-not-found/)
  })
})

describe('abort and teardown semantics', () => {
  it('an already-aborted signal settles cancelled synchronously without parking', async () => {
    const harness = fakeBridgeDeps()
    const agent = harness.makeAgent('sess-1', [askedEvent('appr-1', 'call-9')])
    const bridge = createBridge(harness.deps)
    const controller = new AbortController()
    controller.abort()
    const next = vi.fnNext()
    await expect(bridge.approvalAsk({ agent, toolName: 'bash', callId: 'call-9', signal: controller.signal }, next))
      .resolves.toBe('cancelled')
    expect(next.calls).toBe(0)
    expect(harness.notifications).toEqual([])
  })

  it('abort while parked settles cancelled and needs no respond', async () => {
    const harness = fakeBridgeDeps()
    const agent = harness.makeAgent('sess-1', [askedEvent('appr-1', 'call-9')])
    const bridge = createBridge(harness.deps)
    const controller = new AbortController()
    const askPromise = bridge.approvalAsk({ agent, toolName: 'bash', callId: 'call-9', signal: controller.signal }, vi.fnNext())
    controller.abort()
    await expect(askPromise).resolves.toBe('cancelled')
    await expect(bridge.handleRequest(BRIDGE_METHODS.approvalRespond, {
      sessionId: 'sess-1', approvalId: 'appr-1', outcome: 'allowed-once',
    })).rejects.toThrow(/approval-not-found/)
    expect(harness.notifications).toHaveLength(1)
  })

  it('first settle wins: respond then abort keeps allowed-once', async () => {
    const harness = fakeBridgeDeps()
    const agent = harness.makeAgent('sess-1', [askedEvent('appr-1', 'call-9')])
    const bridge = createBridge(harness.deps)
    const controller = new AbortController()
    const askPromise = bridge.approvalAsk({ agent, toolName: 'bash', callId: 'call-9', signal: controller.signal }, vi.fnNext())
    await bridge.handleRequest(BRIDGE_METHODS.approvalRespond, {
      sessionId: 'sess-1', approvalId: 'appr-1', outcome: 'allowed-once',
    })
    controller.abort()
    await expect(askPromise).resolves.toBe('allowed-once')
  })

  it('dispose settles every parked approval cancelled', async () => {
    const harness = fakeBridgeDeps()
    const agent = harness.makeAgent('sess-1', [askedEvent('appr-1', 'call-1'), askedEvent('appr-2', 'call-2')])
    const bridge = createBridge(harness.deps)
    const p1 = bridge.approvalAsk({ agent, toolName: 'bash', callId: 'call-1' }, vi.fnNext())
    const p2 = bridge.approvalAsk({ agent, toolName: 'bash', callId: 'call-2' }, vi.fnNext())
    bridge.dispose()
    await expect(p1).resolves.toBe('cancelled')
    await expect(p2).resolves.toBe('cancelled')
  })
})

describe('audit-path delegation', () => {
  it('delegates to next() when the log has no matching undecided asked', async () => {
    const harness = fakeBridgeDeps()
    const agent = harness.makeAgent('sess-1', [])
    const bridge = createBridge(harness.deps)
    const next = vi.fnNext()
    await expect(bridge.approvalAsk({ agent, toolName: 'bash', callId: 'call-x' }, next)).resolves.toBe('unavailable')
    expect(next.calls).toBe(1)
    expect(harness.notifications).toEqual([])
  })
})
