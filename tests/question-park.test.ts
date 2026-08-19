import { describe, expect, it } from 'vitest'

import { createBridge } from '../src/bridge.js'
import { BRIDGE_METHODS, BRIDGE_NOTIFICATIONS } from '../src/contract.js'
import { fakeBridgeDeps } from './helpers.js'

const QUESTIONS = [{ id: 'q1', question: 'Deploy now?', options: [{ label: 'yes' }, { label: 'no' }] }]

describe('question provider ask', () => {
  it('parks the ask and pushes question-requested with a fresh requestId', async () => {
    const harness = fakeBridgeDeps()
    const agent = harness.makeAgent('sess-1')
    const bridge = createBridge(harness.deps)
    const promise = bridge.questionProvider.ask({ questions: QUESTIONS, agent })
    expect(harness.notifications).toHaveLength(1)
    const note = harness.notifications[0]
    expect(note?.method).toBe(BRIDGE_NOTIFICATIONS.questionRequested)
    expect(note?.params['sessionId']).toBe('sess-1')
    expect(note?.params['questions']).toEqual(QUESTIONS)
    expect(typeof note?.params['requestId']).toBe('string')

    const requestId = note?.params['requestId'] as string
    await expect(bridge.handleRequest(BRIDGE_METHODS.questionRespond, {
      sessionId: 'sess-1',
      requestId,
      answers: [{ id: 'q1', selected: ['yes'] }],
    })).resolves.toEqual({ resolved: true })
    await expect(promise).resolves.toEqual({ answers: [{ id: 'q1', selected: ['yes'] }] })
  })

  it('forwards custom text verbatim', async () => {
    const harness = fakeBridgeDeps()
    const agent = harness.makeAgent('sess-1')
    const bridge = createBridge(harness.deps)
    const promise = bridge.questionProvider.ask({ questions: QUESTIONS, agent })
    const requestId = harness.notifications[0]?.params['requestId'] as string
    await bridge.handleRequest(BRIDGE_METHODS.questionRespond, {
      sessionId: 'sess-1', requestId,
      answers: [{ id: 'q1', selected: [], custom: 'later' }],
    })
    await expect(promise).resolves.toEqual({ answers: [{ id: 'q1', selected: [], custom: 'later' }] })
  })

  it('agentless asks reject without notifying', async () => {
    const harness = fakeBridgeDeps()
    const bridge = createBridge(harness.deps)
    await expect(bridge.questionProvider.ask({ questions: QUESTIONS })).rejects.toThrow(/ASK_MISSING_AGENT/)
    expect(harness.notifications).toEqual([])
  })
})

describe('question-respond validation', () => {
  it('malformed answers reject without settling the parked ask', async () => {
    const harness = fakeBridgeDeps()
    const agent = harness.makeAgent('sess-1')
    const bridge = createBridge(harness.deps)
    let settled: unknown = 'unsettled'
    const promise = bridge.questionProvider.ask({ questions: QUESTIONS, agent }).then(
      (v) => { settled = v; return v },
      (e) => { settled = e; throw e },
    )
    const requestId = harness.notifications[0]?.params['requestId'] as string

    await expect(bridge.handleRequest(BRIDGE_METHODS.questionRespond, {
      sessionId: 'sess-1', requestId, answers: 'yes',
    })).rejects.toThrow(/answers must be an array/)
    await expect(bridge.handleRequest(BRIDGE_METHODS.questionRespond, {
      sessionId: 'sess-1', requestId, answers: [{ selected: ['yes'] }],
    })).rejects.toThrow(/string id/)
    await expect(bridge.handleRequest(BRIDGE_METHODS.questionRespond, {
      sessionId: 'sess-1', requestId, answers: [{ id: 'q1', selected: 'yes' }],
    })).rejects.toThrow(/selected/)
    expect(settled).toBe('unsettled')

    await bridge.handleRequest(BRIDGE_METHODS.questionRespond, {
      sessionId: 'sess-1', requestId, answers: [{ id: 'q1', selected: ['yes'] }],
    })
    await expect(promise).resolves.toEqual({ answers: [{ id: 'q1', selected: ['yes'] }] })
  })

  it('unknown requestId rejects with question-not-found', async () => {
    const harness = fakeBridgeDeps()
    const bridge = createBridge(harness.deps)
    await expect(bridge.handleRequest(BRIDGE_METHODS.questionRespond, {
      sessionId: 'sess-1', requestId: 'nope', answers: [],
    })).rejects.toThrow(/question-not-found/)
  })

  it('sessionId mismatch collapses into question-not-found', async () => {
    const harness = fakeBridgeDeps()
    const agent = harness.makeAgent('sess-1')
    const bridge = createBridge(harness.deps)
    bridge.questionProvider.ask({ questions: QUESTIONS, agent })
    const requestId = harness.notifications[0]?.params['requestId'] as string
    await expect(bridge.handleRequest(BRIDGE_METHODS.questionRespond, {
      sessionId: 'other', requestId, answers: [],
    })).rejects.toThrow(/question-not-found/)
  })
})

describe('abort and teardown semantics', () => {
  it('an already-aborted signal rejects ASK_ABORTED without parking', async () => {
    const harness = fakeBridgeDeps()
    const agent = harness.makeAgent('sess-1')
    const bridge = createBridge(harness.deps)
    const controller = new AbortController()
    controller.abort()
    await expect(bridge.questionProvider.ask({ questions: QUESTIONS, agent, signal: controller.signal }))
      .rejects.toThrow(/ASK_ABORTED/)
    expect(harness.notifications).toEqual([])
  })

  it('abort rejects the parked ask with ASK_ABORTED', async () => {
    const harness = fakeBridgeDeps()
    const agent = harness.makeAgent('sess-1')
    const bridge = createBridge(harness.deps)
    const controller = new AbortController()
    const promise = bridge.questionProvider.ask({ questions: QUESTIONS, agent, signal: controller.signal })
    controller.abort()
    await expect(promise).rejects.toThrow(/ASK_ABORTED/)
    const requestId = harness.notifications[0]?.params['requestId'] as string
    await expect(bridge.handleRequest(BRIDGE_METHODS.questionRespond, {
      sessionId: 'sess-1', requestId, answers: [],
    })).rejects.toThrow(/question-not-found/)
  })

  it('dispose rejects every parked question', async () => {
    const harness = fakeBridgeDeps()
    const a1 = harness.makeAgent('sess-1')
    const a2 = harness.makeAgent('sess-2')
    const bridge = createBridge(harness.deps)
    const p1 = bridge.questionProvider.ask({ questions: QUESTIONS, agent: a1 })
    const p2 = bridge.questionProvider.ask({ questions: QUESTIONS, agent: a2 })
    bridge.dispose()
    await expect(p1).rejects.toThrow(/disposed/)
    await expect(p2).rejects.toThrow(/disposed/)
  })
})

describe('degradation', () => {
  it('disableQuestions turns question-respond into user-questions-unavailable', async () => {
    const harness = fakeBridgeDeps()
    const bridge = createBridge(harness.deps)
    bridge.disableQuestions('provider registration failed')
    await expect(bridge.handleRequest(BRIDGE_METHODS.questionRespond, {
      sessionId: 'sess-1', requestId: 'any', answers: [],
    })).rejects.toThrow(/user-questions-unavailable/)
  })
})
