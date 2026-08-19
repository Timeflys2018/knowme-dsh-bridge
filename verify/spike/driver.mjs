#!/usr/bin/env node
/**
 * verify:spike — drives a REAL composed dsh runtime (keyless llm-replay) as a
 * child process over real stdio, through every bridge method. One child per
 * tier for clean state. Exits non-zero on any assertion failure.
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SNAPSHOT = join(HERE, 'fixtures', 'two-turn.session.jsonl')
const BIN = join(HERE, 'bin.mjs')
const CORDIS = join(HERE, 'cordis.yml')
const RUN_ROOT = mkdtempSync(join('/tmp/opencode', 'knowme-dsh-bridge-spike-'))
const TIMEOUT_MS = 30_000

const failures = []
const ok = (label) => console.log(`  ✓ ${label}`)
const bad = (label, detail) => {
  console.error(`  ✗ ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  failures.push(label)
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

class SpikeRun {
  constructor(name) {
    this.name = name
    this.dir = join(RUN_ROOT, name)
    this.notifications = []
    this.stderrLines = []
    this.exitCode = null
    this.pending = new Map()
    this.seq = 0
  }

  async start() {
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(this.dir, { recursive: true })
    mkdirSync(join(this.dir, 'sessions'), { recursive: true })
    const template = readFileSync(CORDIS, 'utf8')
      .replaceAll('__SNAPSHOT__', SNAPSHOT)
      .replaceAll('__SESSIONS__', join(this.dir, 'sessions'))
      .replaceAll('__CWD__', this.dir)
    this.configPath = join(this.dir, 'cordis.yml')
    writeFileSync(this.configPath, template)
    this.child = spawn(process.execPath, [BIN, this.configPath], {
      cwd: HERE,
      env: { ...process.env, DSH_CORDIS_CONFIG: this.configPath },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let buffer = ''
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk) => {
      buffer += chunk
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line === '') continue
        this.handleFrame(JSON.parse(line))
      }
    })
    let errBuffer = ''
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk) => {
      errBuffer += chunk
      let index
      while ((index = errBuffer.indexOf('\n')) >= 0) {
        const line = errBuffer.slice(0, index).trim()
        errBuffer = errBuffer.slice(index + 1)
        if (line !== '') this.stderrLines.push(line)
      }
    })
    this.exitPromise = new Promise((resolve) => {
      this.child.on('exit', (code) => { this.exitCode = code; resolve(code) })
    })
    await sleep(500)
    if (this.exitCode !== null) throw new Error(`${this.name}: runtime exited early with ${this.exitCode}: ${this.stderrLines.slice(-10).join(' | ')}`)
  }

  request(method, params) {
    const id = `drv-${++this.seq}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method}: response timeout`)) }, TIMEOUT_MS)
      this.pending.set(id, (frame) => { clearTimeout(timer); resolve(frame) })
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  handleFrame(frame) {
    if (frame.id !== undefined && (frame.result !== undefined || frame.error !== undefined)) {
      const waiter = this.pending.get(frame.id)
      if (waiter) { this.pending.delete(frame.id); waiter(frame) }
    } else if (frame.method !== undefined) {
      this.notifications.push(frame)
    }
  }

  async waitFor(predicate, label) {
    const deadline = Date.now() + TIMEOUT_MS
    while (Date.now() < deadline) {
      const found = this.notifications.find(predicate)
      if (found) return found
      await sleep(50)
    }
    throw new Error(`waitFor timeout: ${label}`)
  }

  sessionLog(sessionId) {
    const root = join(this.dir, 'sessions')
    const found = []
    const walk = (dir) => {
      if (!existsSync(dir)) return
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name === 'session.jsonl') {
          const lines = readFileSync(full, 'utf8').trim().split('\n')
          const header = JSON.parse(lines[0] ?? '{}')
          if (header['id'] === sessionId) found.push(...lines.map((l) => JSON.parse(l)))
        }
      }
    }
    walk(root)
    return found
  }
}

const turnEnd = (sessionId) => (n) =>
  n.method === 'session.event' && n.params?.sessionId === sessionId && n.params?.event?.type === 'turn/end'

async function tier(name, fn) {
  console.log(`\n[${name}]`)
  const run = new SpikeRun(name)
  try {
    await run.start()
    await fn(run)
    ok(`${name} passed`)
  } catch (error) {
    bad(name, String(error))
    console.error(`  --- ${name} child stderr tail ---`)
    for (const line of run.stderrLines.slice(-20)) console.error(`  | ${line.slice(0, 300)}`)
    run.child?.kill('SIGKILL')
  }
}

await tier('T1 protocol/lifecycle', async (run) => {
  const init = await run.request('initialize', { cwd: run.dir, provider: 'deepseek-official', model: 'deepseek-v4-flash' })
  ok(`initialize → ${init.result?.serverInfo?.name}`)
  if (init.error) throw new Error(JSON.stringify(init.error))

  const prompt = await run.request('session/prompt', { sessionId: 't1', contentBlocks: [{ type: 'text', text: 'Reply with exactly: SDK snapshot OK' }] })
  ok(`session/prompt → messageId ${prompt.result?.messageId !== undefined}`)
  await run.waitFor(turnEnd('t1'), 'turn/end for t1')
  ok('official session.event stream flows over the shared transport')

  const bogus = await run.request('knowme/bogus', {})
  if (!bogus.error?.message?.includes('unknown knowme-dsh-bridge method')) throw new Error(JSON.stringify(bogus.error))
  ok('knowme/bogus → bridge unknown-method error')

  const ghost = await run.request('knowme/selectModel', { sessionId: 'ghost', provider: 'deepseek-official', model: 'deepseek-v4-flash' })
  if (!ghost.error?.message?.includes('session-not-found')) throw new Error(JSON.stringify(ghost.error))
  ok('selectModel on ghost session → session-not-found')

  const shutdown = await run.request('shutdown', {})
  if (shutdown.result === undefined) throw new Error(JSON.stringify(shutdown.error))
  const code = await run.exitPromise
  if (code !== 0) throw new Error(`exit code ${code}`)
  ok('shutdown → {} and clean exit 0')
})

await tier('T2 selectModel no-restart', async (run) => {
  await run.request('initialize', { cwd: run.dir, provider: 'deepseek-official', model: 'deepseek-v4-flash' })
  await run.request('session/prompt', { sessionId: 't2', contentBlocks: [{ type: 'text', text: 'first turn under flash' }] })
  await run.waitFor(turnEnd('t2'), 'turn 1 end')

  const before = run.sessionLog('t2').filter((e) => e.type === 'request/header').map((e) => e.data?.header?.config?.model)
  if (before[before.length - 1] !== 'deepseek-v4-flash') throw new Error(`turn-1 model was ${before.join(',')}`)

  const switched = await run.request('knowme/selectModel', { sessionId: 't2', provider: 'deepseek-official', model: 'deepseek-v4-pro' })
  if (switched.result?.selected?.model !== 'deepseek-v4-pro') throw new Error(JSON.stringify(switched))
  ok('knowme/selectModel → {selected: deepseek-v4-pro} (same process)')

  await run.request('session/prompt', { sessionId: 't2', contentBlocks: [{ type: 'text', text: 'second turn should run under pro' }] })
  await run.waitFor((n) => turnEnd('t2')(n) && run.sessionLog('t2').filter((e) => e.type === 'turn/end').length >= 2, 'turn 2 end')

  const models = run.sessionLog('t2').filter((e) => e.type === 'request/header').map((e) => e.data?.header?.config?.model)
  if (models.length < 2 || models[models.length - 1] !== 'deepseek-v4-pro') {
    throw new Error(`request/header models: ${models.join(' → ')}`)
  }
  ok(`model switch landed on next turn in the SAME process: ${models.join(' → ')}`)

  const shutdown = await run.request('shutdown', {})
  if (shutdown.result === undefined) throw new Error('shutdown failed')
  const code = await run.exitPromise
  if (code !== 0) throw new Error(`exit code ${code}`)
})

await tier('T3 approval + question round-trip', async (run) => {
  await run.request('initialize', { cwd: run.dir, provider: 'deepseek-official', model: 'deepseek-v4-flash' })

  await run.request('session/prompt', { sessionId: 's-appr', contentBlocks: [{ type: 'text', text: 'SPIKE_TRIGGER_APPROVAL please' }] })
  const approvalNote = await run.waitFor((n) => n.method === 'knowme/approval-requested', 'approval-requested')
  const approvalParams = approvalNote.params
  if (approvalParams.sessionId !== 's-appr' || approvalParams.toolName !== 'spike-bash' || approvalParams.callId !== 'call-spike-1') {
    throw new Error(JSON.stringify(approvalParams))
  }
  ok(`approval-requested pushed over stdio (approvalId ${approvalParams.approvalId})`)

  const respond = await run.request('knowme/approval-respond', { sessionId: 's-appr', approvalId: approvalParams.approvalId, outcome: 'allowed-once' })
  if (respond.result?.resolved !== true) throw new Error(JSON.stringify(respond))
  let settled = false
  for (let i = 0; i < 100 && !settled; i++) {
    await sleep(50)
    settled = run.stderrLines.some((l) => l.includes('approval settled: allowed-once'))
  }
  if (!settled) throw new Error(`trigger never observed settle; stderr tail: ${run.stderrLines.slice(-8).join(' | ')}`)
  ok('approval-respond settled the parked promise (trigger observed allowed-once)')

  await run.request('session/prompt', { sessionId: 's-q', contentBlocks: [{ type: 'text', text: 'SPIKE_TRIGGER_QUESTION please' }] })
  const questionNote = await run.waitFor((n) => n.method === 'knowme/question-requested', 'question-requested')
  if (questionNote.params.sessionId !== 's-q' || questionNote.params.questions?.[0]?.id !== 'q1') {
    throw new Error(JSON.stringify(questionNote.params))
  }
  const answer = await run.request('knowme/question-respond', {
    sessionId: 's-q', requestId: questionNote.params.requestId,
    answers: [{ id: 'q1', selected: ['yes'] }],
  })
  if (answer.result?.resolved !== true) throw new Error(JSON.stringify(answer))
  let answered = false
  for (let i = 0; i < 100 && !answered; i++) {
    await sleep(50)
    answered = run.stderrLines.some((l) => l.includes('question answered') && l.includes('yes'))
  }
  if (!answered) throw new Error(`trigger never observed the answer; stderr tail: ${run.stderrLines.slice(-8).join(' | ')}`)
  ok('question-respond resolved the provider ask (trigger observed yes)')

  const shutdown = await run.request('shutdown', {})
  if (shutdown.result === undefined) throw new Error('shutdown failed')
  const code = await run.exitPromise
  if (code !== 0) throw new Error(`exit code ${code}`)
})

await tier('T3b shutdown-while-parked', async (run) => {
  await run.request('initialize', { cwd: run.dir, provider: 'deepseek-official', model: 'deepseek-v4-flash' })
  await run.request('session/prompt', { sessionId: 's-park', contentBlocks: [{ type: 'text', text: 'SPIKE_TRIGGER_APPROVAL hold this' }] })
  await run.waitFor((n) => n.method === 'knowme/approval-requested', 'approval-requested')

  const shutdown = await run.request('shutdown', {})
  if (shutdown.result === undefined) throw new Error(JSON.stringify(shutdown.error))
  const code = await run.exitPromise
  if (code !== 0) throw new Error(`exit code ${code}`)
  ok('shutdown with a parked approval → response + exit 0')

  const log = run.sessionLog('s-park')
  const asked = log.some((e) => e.type === 'approval/asked')
  const decidedCancelled = log.some((e) => e.type === 'approval/decided' && e.data?.outcome === 'cancelled')
  if (!asked || !decidedCancelled) {
    throw new Error(`audit trail incomplete: asked=${asked} decidedCancelled=${decidedCancelled}`)
  }
  ok('parked approval settled cancelled with a durable approval/decided audit event')
})

console.log('')
if (failures.length > 0) {
  console.error(`[verify:spike] FAILED: ${failures.join(', ')} (run root: ${RUN_ROOT})`)
  process.exit(1)
}
console.log('[verify:spike] OK — T1 T2 T3 T3b all passed')
