import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import { apply, Config, inject, name, type JsonRpcConfig } from '../src/index.js'
import type { BridgePluginContext } from '../src/bridge.js'

interface Mounted {
  ctx: FakePluginContext
  input: PassThrough
  output: PassThrough
  frames: Array<Record<string, unknown>>
  exitCode: Promise<number>
  config: JsonRpcConfig
}

class FakePluginContext implements BridgePluginContext {
  readonly agents: { get(sessionId: string): unknown }
  readonly services = new Map<string, unknown>()
  readonly listeners = new Map<string, Array<(...args: never[]) => unknown>>()
  readonly effectOrder: string[] = []
  readonly disposeLog: string[] = []
  readonly warn = vi.fn()
  private readonly effects: Array<{ name: string; dispose: () => void | Promise<void> }> = []

  constructor(agentTable?: Map<string, unknown>) {
    this.agents = { get: (id: string) => agentTable?.get(id) }
  }

  get(service: string): unknown { return this.services.get(service) }

  on(event: string, handler: (...args: never[]) => unknown): () => void {
    const list = this.listeners.get(event) ?? []
    list.push(handler)
    this.listeners.set(event, list)
    return () => {
      const current = this.listeners.get(event) ?? []
      const index = current.indexOf(handler)
      if (index >= 0) current.splice(index, 1)
    }
  }

  effect(setup: () => void | (() => void | Promise<void>), effectName?: string): void {
    const dispose = setup() ?? (() => undefined)
    const label = effectName ?? 'anonymous'
    this.effectOrder.push(label)
    this.effects.push({ name: label, dispose })
  }

  plugin(): Promise<unknown> {
    // HarnessSdkJsonRpcServer.initialize calls ctx.plugin(LlmDeepSeek) only
    // when no adapter owns the provider; tests always mount FAKE_LLM listing
    // 'deepseek-official', so this stub exists purely to fail loud if a future
    // test uses an unowned provider.
    return Promise.resolve(undefined)
  }

  readonly logger = { warn: (message: string) => { this.warn(message) } }
  readonly root = {
    fiber: {
      dispose: async (): Promise<void> => {
        for (const effect of [...this.effects].reverse()) {
          this.disposeLog.push(effect.name)
          await effect.dispose()
        }
      },
    },
  }
}

function mount(services: Record<string, unknown> = {}, agentTable?: Map<string, unknown>): Mounted {
  const ctx = new FakePluginContext(agentTable)
  for (const [key, value] of Object.entries(services)) ctx.services.set(key, value)
  const input = new PassThrough()
  const output = new PassThrough()
  const frames: Array<Record<string, unknown>> = []
  output.on('data', (chunk: Buffer | string) => {
    for (const line of chunk.toString().split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      frames.push(JSON.parse(trimmed) as Record<string, unknown>)
    }
  })
  let resolveExit!: (code: number) => void
  const exitCode = new Promise<number>((resolve) => { resolveExit = resolve })
  const config: JsonRpcConfig = { input, output, exit: (code) => resolveExit(code) }
  apply(ctx, config)
  return { ctx, input, output, frames, exitCode, config }
}

function send(input: PassThrough, message: Record<string, unknown>): void {
  input.write(`${JSON.stringify(message)}\n`)
}

async function waitForFrames(frames: Array<Record<string, unknown>>, count: number): Promise<void> {
  const deadline = Date.now() + 2000
  while (frames.length < count && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
  expect(frames.length).toBeGreaterThanOrEqual(count)
}

const FAKE_LLM = {
  listProviders: () => [{ id: 'deepseek-official' }],
  resolveCallConfig: async (config: { provider: string; model: string }) => config,
}

describe('plugin declaration', () => {
  it('keeps the stable name and the official hard dependency', () => {
    expect(name).toBe('knowme-sdk-bridge')
    expect(inject).toEqual(['agents'])
  })

  it('Config defaults maxTokensAsSuccess to false (official parity)', () => {
    expect(Config({}).maxTokensAsSuccess).toBe(false)
    expect(Config({ maxTokensAsSuccess: true }).maxTokensAsSuccess).toBe(true)
  })
})

describe('single-transport composition', () => {
  it('attaches exactly one data listener to the input stream', () => {
    const { input } = mount()
    expect(input.listenerCount('data')).toBe(1)
  })

  it('routes knowme/* to the bridge and everything else to the official server', async () => {
    const { input, frames } = mount({ llm: FAKE_LLM })
    send(input, { jsonrpc: '2.0', id: 'r1', method: 'knowme/bogus', params: {} })
    send(input, { jsonrpc: '2.0', id: 'r2', method: 'initialize', params: { cwd: '/tmp', provider: 'deepseek-official', model: 'm1' } })
    await waitForFrames(frames, 2)
    const bridgeError = frames[0]
    expect(bridgeError?.['id']).toBe('r1')
    expect((bridgeError?.['error'] as { message: string }).message).toMatch(/unknown knowme-dsh-bridge method: knowme\/bogus/)
    const init = frames[1]
    expect(init?.['id']).toBe('r2')
    expect((init?.['result'] as { serverInfo: { name: string } }).serverInfo.name).toBe('deepseek-harness-sdk-runtime')
  })

  it('knowme/selectModel flows through the transport with the llm soft-probe', async () => {
    const { input, frames } = mount()
    send(input, { jsonrpc: '2.0', id: 'r3', method: 'knowme/selectModel', params: { sessionId: 's1', provider: 'p', model: 'm' } })
    await waitForFrames(frames, 1)
    expect((frames[0]?.['error'] as { message: string }).message).toMatch(/llm-unavailable/)
  })
})

describe('question provider wiring', () => {
  it('registers the bridge provider when the service is composed', () => {
    const registered: unknown[] = []
    mount({ userQuestions: { registerProvider: (p: unknown) => { registered.push(p); return () => undefined } } })
    expect(registered).toHaveLength(1)
  })

  it('a synchronous registerProvider failure degrades questions instead of crashing', async () => {
    const { input, frames, ctx } = mount({
      userQuestions: { registerProvider: () => { throw new Error('a user-questions provider is already registered') } },
    })
    expect(ctx.warn).toHaveBeenCalledTimes(1)
    send(input, { jsonrpc: '2.0', id: 'q1', method: 'knowme/question-respond', params: { sessionId: 's', requestId: 'r', answers: [] } })
    await waitForFrames(frames, 1)
    expect((frames[0]?.['error'] as { message: string }).message).toMatch(/user-questions-unavailable/)
  })

  it('no userQuestions service degrades questions', () => {
    const { ctx } = mount()
    expect(ctx.warn).toHaveBeenCalledTimes(1)
  })
})

describe('approval wiring over the transport', () => {
  it('approval/request listener parks and answers over real frames', async () => {
    const { input, frames, ctx } = mount({ llm: FAKE_LLM })
    const events = [{ type: 'approval/asked', data: { id: 'appr-1', toolName: 'bash', callId: 'call-1' } }]

    const handler = ctx.listeners.get('approval/request')?.[0]
    expect(handler).toBeDefined()
    const next = vi.fn(async () => 'unavailable' as const)
    const askPromise = (handler as unknown as (...args: never[]) => unknown)(
      { agent: { id: 'sess-1', session: { id: 'sess-1', events }, ctx: {} }, toolName: 'bash', callId: 'call-1' },
      next,
    ) as Promise<string>

    await waitForFrames(frames, 1)
    const note = frames[0]
    expect(note?.['method']).toBe('knowme/approval-requested')
    expect((note?.['params'] as Record<string, unknown>)['approvalId']).toBe('appr-1')

    send(input, {
      jsonrpc: '2.0', id: 'a1', method: 'knowme/approval-respond',
      params: { sessionId: 'sess-1', approvalId: 'appr-1', outcome: 'allowed-once' },
    })
    await waitForFrames(frames, 2)
    expect(frames[1]?.['result']).toEqual({ resolved: true })
    await expect(askPromise).resolves.toBe('allowed-once')
    expect(next).not.toHaveBeenCalled()
  })
})

describe('shutdown lifecycle', () => {
  it('shutdown responds, disposes parks before serve, flushes, and exits 0', async () => {
    const { input, frames, exitCode, ctx } = mount({ llm: FAKE_LLM })
    send(input, { jsonrpc: '2.0', id: 's1', method: 'shutdown' })
    await waitForFrames(frames, 1)
    expect(frames[0]?.['result']).toEqual({})
    const code = await exitCode
    expect(code).toBe(0)
    // NOTE: this assertion is self-referential against the fake (it disposes
    // in reverse by construction). The LOAD-BEARING evidence for the real
    // cordis ordering is spike T3b (parked approval settles 'cancelled' with
    // a durable approval/decided pair before exit 0) — do not delete T3b on
    // the belief this unit test proves the same thing.
    expect(ctx.disposeLog.indexOf('knowme-bridge.parks')).toBeLessThan(ctx.disposeLog.indexOf('knowme-bridge.serve'))
  })
})
