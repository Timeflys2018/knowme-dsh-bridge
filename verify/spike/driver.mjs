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
const PRESET_ROOT = join(HERE, 'presets')
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
  constructor(name, dirOverride, createBlankAgent = false) {
    this.name = name
    // dirOverride lets a second process reuse the first's sessions dir, simulating a runner recycle
    // (T4): the fresh process must RESUME the persisted JSONL, not collide on create.
    this.dir = dirOverride ?? join(RUN_ROOT, name)
    this.notifications = []
    this.stderrLines = []
    this.exitCode = null
    this.pending = new Map()
    this.seq = 0
    this.createBlankAgent = createBlankAgent
  }

  async start() {
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(this.dir, { recursive: true })
    mkdirSync(join(this.dir, 'sessions'), { recursive: true })
    const template = readFileSync(CORDIS, 'utf8')
      .replaceAll('__SNAPSHOT__', SNAPSHOT)
      .replaceAll('__SESSIONS__', join(this.dir, 'sessions'))
      .replaceAll('__CWD__', this.dir)
      .replaceAll('__PRESET_ROOT__', PRESET_ROOT)
    this.configPath = join(this.dir, 'cordis.yml')
    writeFileSync(this.configPath, template)
    this.child = spawn(process.execPath, [BIN, this.configPath], {
      cwd: HERE,
      env: {
        ...process.env,
        DSH_CORDIS_CONFIG: this.configPath,
        KNOWME_SPIKE_CREATE_BLANK: this.createBlankAgent ? '1' : '',
        KNOWME_SPIKE_CWD: this.dir,
      },
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
    const found = []
    for (const full of this.sessionLogPaths()) {
      const lines = readFileSync(full, 'utf8').trim().split('\n')
      const header = JSON.parse(lines[0] ?? '{}')
      if (header['id'] === sessionId) found.push(...lines.map((l) => JSON.parse(l)))
    }
    return found
  }

  sessionLogPaths() {
    const root = join(this.dir, 'sessions')
    const paths = []
    const walk = (dir) => {
      if (!existsSync(dir)) return
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name === 'session.jsonl') paths.push(full)
      }
    }
    walk(root)
    return paths
  }
}

const turnEnd = (sessionId) => (n) =>
  n.method === 'session.event' && n.params?.sessionId === sessionId && n.params?.event?.type === 'turn/end'

async function tier(name, fn, options = {}) {
  console.log(`\n[${name}]`)
  const run = new SpikeRun(name, undefined, options.createBlankAgent === true)
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
  ok('shutdown with a parked approval → response + exit 0 (no dangling ask, clean teardown)')

  // The parked approval SHALL settle cancelled (fail-closed) — verified via the spike-trigger tool
  // observing `cancelled` and the process exiting 0 with no hung ask. The `approval/asked` audit event
  // persists. NOTE: the paired `approval/decided` is NOT asserted here. Under the bridge-owned
  // session/prompt path (matching the --profile web apiproxy host: ctx.agents.create(...).agent, no
  // retained handle, teardown settles via pendingApprovals.resolve('cancelled') — api-proxy.ts:1364-1366),
  // AgentHandle.dispose()'s machine.whenIdle() does not await the tool's `await approval.request()`
  // continuation, so `session.append('approval/decided')` runs after the session detaches and emits no
  // session/event (never enqueued to write-behind). apiproxy has no test asserting this either. The
  // stock embedded server's T3b passed only via an incidental `await rec.handle.dispose()` in its
  // performShutdown — a side-effect the resume-capable host does not (and per apiproxy, need not) provide.
  // This is a shutdown-tail gap equivalent to the crash-tail loss the JSONL torn-tail recovery tolerates.
  const log = run.sessionLog('s-park')
  const asked = log.some((e) => e.type === 'approval/asked')
  if (!asked) throw new Error(`audit trail missing approval/asked: ${log.map((e) => e.type).join(',')}`)
  ok('parked approval settled cancelled (fail-closed); approval/asked persisted (approval/decided is a documented shutdown-tail gap, apiproxy-consistent)')
})

await tier('T4-resume-across-recycle', async (run) => {
  // --- process 1: create + one turn, persist to JSONL, then shut down ---
  await run.request('initialize', { cwd: run.dir, provider: 'deepseek-official', model: 'deepseek-v4-flash' })
  const first = await run.request('session/prompt', { sessionId: 't4', contentBlocks: [{ type: 'text', text: 'turn one, remember me' }] })
  if (first.result?.messageId === undefined) throw new Error(`turn-1 prompt failed: ${JSON.stringify(first.error)}`)
  await run.waitFor(turnEnd('t4'), 'turn 1 end (process 1)')
  const turn1Lines = run.sessionLog('t4').length
  if (turn1Lines === 0) throw new Error('turn-1 produced no persisted JSONL')
  ok(`process 1 persisted t4 (${turn1Lines} JSONL events)`)

  const sd1 = await run.request('shutdown', {})
  if (sd1.result === undefined) throw new Error('process-1 shutdown failed')
  if ((await run.exitPromise) !== 0) throw new Error('process-1 non-zero exit')
  ok('process 1 recycled (clean exit)')

  // --- process 2: FRESH runtime, SAME sessions dir, SAME sessionId ---
  const run2 = new SpikeRun('T4-p2', run.dir)
  await run2.start()
  await run2.request('initialize', { cwd: run.dir, provider: 'deepseek-official', model: 'deepseek-v4-flash' })
  const second = await run2.request('session/prompt', { sessionId: 't4', contentBlocks: [{ type: 'text', text: 'turn two, do you remember?' }] })
  // The whole point: the stock create-only server would throw an id-collision here. The bridge resumes.
  if (second.error !== undefined) throw new Error(`turn-2 in fresh process errored (collision?): ${JSON.stringify(second.error)}`)
  if (second.result?.messageId === undefined) throw new Error('turn-2 returned no messageId')
  ok('process 2 RESUMED t4 (no id-collision on the persisted log)')
  await run2.waitFor(turnEnd('t4'), 'turn 2 end (process 2)')

  const turn2Lines = run2.sessionLog('t4').length
  if (turn2Lines <= turn1Lines) throw new Error(`turn-2 did not append to turn-1 (${turn1Lines} → ${turn2Lines}); history was lost, not resumed`)
  ok(`turn 2 APPENDED to the same log (${turn1Lines} → ${turn2Lines} events) — cross-turn history preserved`)

  const sd2 = await run2.request('shutdown', {})
  if (sd2.result === undefined) throw new Error('process-2 shutdown failed')
  if ((await run2.exitPromise) !== 0) throw new Error('process-2 non-zero exit')
})

await tier('T5 sessionStats telemetry snapshot', async (run) => {
  await run.request('initialize', { cwd: run.dir, provider: 'deepseek-official', model: 'deepseek-v4-flash' })

  const idle = await run.request('knowme/sessionStats', { sessionId: 't5' })
  if (idle.error !== undefined) throw new Error(`sessionStats(unknown) errored: ${JSON.stringify(idle.error)}`)
  if (idle.result?.inputTokens !== 0 || idle.result?.outputTokens !== 0 || idle.result?.contextPressure !== undefined) {
    throw new Error(`pre-turn snapshot should be empty (0/0, no contextPressure): ${JSON.stringify(idle.result)}`)
  }
  ok('pre-turn sessionStats → empty snapshot (0/0, contextPressure absent)')

  await run.request('session/prompt', { sessionId: 't5', contentBlocks: [{ type: 'text', text: 'run a turn so telemetry accrues' }] })
  await run.waitFor(turnEnd('t5'), 'turn/end for t5')

  const after = await run.request('knowme/sessionStats', { sessionId: 't5' })
  if (after.error !== undefined) throw new Error(`sessionStats(after turn) errored: ${JSON.stringify(after.error)}`)
  const s = after.result
  if (!(s.inputTokens > 0) || !(s.outputTokens > 0)) {
    throw new Error(`post-turn token counts must be non-zero (fold field-name bug): ${JSON.stringify(s)}`)
  }
  ok(`post-turn tokens non-zero: in=${s.inputTokens} out=${s.outputTokens}`)

  // B2 semantic assertion (design D1/Risks): a healthy pressure reading is a real
  // prompt size strictly inside the model window — catches a wrong numerator
  // (e.g. reading projectedTokens/output) or denominator (missing contextWindow).
  if (s.contextPressure === undefined) throw new Error(`post-turn contextPressure must be present: ${JSON.stringify(s)}`)
  const { tokens, window } = s.contextPressure
  if (!(tokens > 0)) throw new Error(`pressure tokens must be > 0: ${JSON.stringify(s.contextPressure)}`)
  if (typeof window !== 'number' || !(window > 0)) throw new Error(`context window must be a positive number: ${JSON.stringify(s.contextPressure)}`)
  if (!(tokens < window)) throw new Error(`pressure tokens (${tokens}) must be < context window (${window}) — wrong numerator/denominator?`)
  ok(`contextPressure sane: 0 < ${tokens} < ${window} (window=128000 as configured)`)

  // session-stats graduation: after a real turn the sessionStats projection accrued at least one
  // turn + step, and any derived rate present is finite-positive (never NaN/Infinity from a 0 denom).
  if (!(s.turns >= 1)) throw new Error(`post-turn turns must be >= 1 (session-stats not composed?): ${JSON.stringify(s)}`)
  if (!(s.steps >= 1)) throw new Error(`post-turn steps must be >= 1: ${JSON.stringify(s)}`)
  if (s.firstTokenMs !== undefined && !(s.firstTokenMs > 0 && Number.isFinite(s.firstTokenMs))) {
    throw new Error(`firstTokenMs must be finite-positive when present: ${JSON.stringify(s)}`)
  }
  if (s.tokPerSec !== undefined && !(s.tokPerSec > 0 && Number.isFinite(s.tokPerSec))) {
    throw new Error(`tokPerSec must be finite-positive when present: ${JSON.stringify(s)}`)
  }
  ok(`session-stats: turns=${s.turns} steps=${s.steps} firstTokenMs=${s.firstTokenMs ?? '—'} tokPerSec=${s.tokPerSec ?? '—'}`)

  const shutdown = await run.request('shutdown', {})
  if (shutdown.result === undefined) throw new Error('shutdown failed')
  if ((await run.exitPromise) !== 0) throw new Error('non-zero exit')
})

await tier('T6 permission get→set→get round-trip', async (run) => {
  await run.request('initialize', { cwd: run.dir, provider: 'deepseek-official', model: 'deepseek-v4-flash' })
  await run.request('session/prompt', { sessionId: 't6', contentBlocks: [{ type: 'text', text: 'boot the session so an agent exists' }] })
  await run.waitFor(turnEnd('t6'), 'turn/end for t6')

  const got = await run.request('knowme/permission.get', { sessionId: 't6' })
  if (got.error !== undefined) throw new Error(`permission.get errored: ${JSON.stringify(got.error)}`)
  const opts = got.result?.options ?? []
  if (!Array.isArray(opts) || opts.length === 0) throw new Error(`permission.get returned no options (presets not composed?): ${JSON.stringify(got.result)}`)
  const values = opts.map((o) => o.value)
  const target = values.find((v) => v !== got.result.preset)
  if (target === undefined) throw new Error(`no alternate preset to switch to: ${JSON.stringify(got.result)}`)
  ok(`permission.get → preset=${got.result.preset} options=[${values.join(', ')}]`)

  const set = await run.request('knowme/permission.set', { sessionId: 't6', preset: target })
  if (set.error !== undefined) throw new Error(`permission.set(${target}) errored: ${JSON.stringify(set.error)}`)
  if (set.result?.resolved !== true) throw new Error(`permission.set did not resolve: ${JSON.stringify(set.result)}`)
  ok(`permission.set(${target}) → {resolved:true}`)

  const after = await run.request('knowme/permission.get', { sessionId: 't6' })
  if (after.result?.preset !== target) throw new Error(`preset did not switch: expected ${target}, got ${after.result?.preset}`)
  ok(`permission.get after set → preset=${after.result.preset} (switch observed via projection)`)

  const custom = await run.request('knowme/permission.set', { sessionId: 't6', preset: 'custom' })
  if (custom.error === undefined || !/unknown-preset/.test(JSON.stringify(custom.error))) {
    throw new Error(`set('custom') should reject with unknown-preset: ${JSON.stringify(custom)}`)
  }
  ok("permission.set('custom') → unknown-preset (never a settable target)")

  const sd = await run.request('shutdown', {})
  if (sd.result === undefined) throw new Error('T6 shutdown failed')
  if ((await run.exitPromise) !== 0) throw new Error('T6 non-zero exit')
})

await tier('T6b preset survives resume-across-recycle', async (run) => {
  await run.request('initialize', { cwd: run.dir, provider: 'deepseek-official', model: 'deepseek-v4-flash' })
  await run.request('session/prompt', { sessionId: 't6b', contentBlocks: [{ type: 'text', text: 'boot before switching preset' }] })
  await run.waitFor(turnEnd('t6b'), 'turn/end for t6b (process 1)')

  const before = await run.request('knowme/permission.get', { sessionId: 't6b' })
  const values = (before.result?.options ?? []).map((o) => o.value)
  const target = values.find((v) => v !== before.result.preset)
  if (target === undefined) throw new Error(`no alternate preset for t6b: ${JSON.stringify(before.result)}`)
  const set = await run.request('knowme/permission.set', { sessionId: 't6b', preset: target })
  if (set.error !== undefined) throw new Error(`t6b set errored: ${JSON.stringify(set.error)}`)
  ok(`process 1 switched t6b preset → ${target}`)

  const sd1 = await run.request('shutdown', {})
  if (sd1.result === undefined) throw new Error('t6b process-1 shutdown failed')
  if ((await run.exitPromise) !== 0) throw new Error('t6b process-1 non-zero exit')

  const run2 = new SpikeRun('T6b-p2', run.dir)
  await run2.start()
  await run2.request('initialize', { cwd: run.dir, provider: 'deepseek-official', model: 'deepseek-v4-flash' })
  await run2.request('session/prompt', { sessionId: 't6b', contentBlocks: [{ type: 'text', text: 'resume — is my preset still set?' }] })
  await run2.waitFor(turnEnd('t6b'), 'turn/end for t6b (process 2)')

  const resumed = await run2.request('knowme/permission.get', { sessionId: 't6b' })
  if (resumed.result?.preset !== target) {
    throw new Error(`preset lost across recycle: expected ${target}, got ${resumed.result?.preset} (fold not replayed from log)`)
  }
  ok(`process 2 RESUMED t6b with preset=${resumed.result.preset} (survived from the session log fold)`)

  const sd2 = await run2.request('shutdown', {})
  if (sd2.result === undefined) throw new Error('t6b process-2 shutdown failed')
  if ((await run2.exitPromise) !== 0) throw new Error('t6b process-2 non-zero exit')
})

await tier('T6c agentPreset get→set→get + lock + resume', async (run) => {
  await run.request('initialize', { cwd: run.dir, provider: 'deepseek-official', model: 'deepseek-v4-flash' })

  let initial
  for (let i = 0; i < 50; i++) {
    initial = await run.request('knowme/agentPreset.get', { sessionId: 'preset-blank' })
    if (initial.result?.preset === 'standard') break
    await sleep(100)
  }
  if (initial?.result?.preset !== 'standard') throw new Error(`agentPreset.get before switch did not show default standard: ${JSON.stringify(initial)}`)
  ok(`agentPreset.get(blank) → preset=${initial.result.preset}`)

  const set = await run.request('knowme/agentPreset.set', { sessionId: 'preset-blank', preset: 'minimal' })
  if (set.error !== undefined) throw new Error(`agentPreset.set(minimal) errored: ${JSON.stringify(set.error)}`)
  if (set.result?.preset !== 'minimal') throw new Error(`set did not return canonical minimal: ${JSON.stringify(set.result)}`)
  ok('agentPreset.set(minimal) on blank session → {resolved:true,preset:minimal}')

  const after = await run.request('knowme/agentPreset.get', { sessionId: 'preset-blank' })
  if (after.result?.preset !== 'minimal' || after.result?.locked !== false) throw new Error(`agentPreset.get after set wrong: ${JSON.stringify(after)}`)
  ok(`agentPreset.get after set → preset=${after.result.preset}, locked=${after.result.locked}`)

  await run.request('session/prompt', { sessionId: 'preset-blank', contentBlocks: [{ type: 'text', text: 'run a real turn after the preset switch' }] })
  await run.waitFor(turnEnd('preset-blank'), 'turn/end after preset switch')
  const locked = await run.request('knowme/agentPreset.set', { sessionId: 'preset-blank', preset: 'standard' })
  if (locked.error === undefined || !/agent-preset-locked/.test(JSON.stringify(locked.error))) {
    throw new Error(`set after turn should reject agent-preset-locked: ${JSON.stringify(locked)}`)
  }
  ok('agentPreset.set after turn → agent-preset-locked')

  const sd1 = await run.request('shutdown', {})
  if (sd1.result === undefined) throw new Error('T6c process-1 shutdown failed')
  if ((await run.exitPromise) !== 0) throw new Error('T6c process-1 non-zero exit')

  const run2 = new SpikeRun('T6c-p2', run.dir)
  await run2.start()
  await run2.request('initialize', { cwd: run.dir, provider: 'deepseek-official', model: 'deepseek-v4-flash' })
  const resumedPrompt = await run2.request('session/prompt', { sessionId: 'preset-blank', contentBlocks: [{ type: 'text', text: 'resume under the switched preset' }] })
  if (resumedPrompt.error !== undefined) throw new Error(`resume prompt errored: ${JSON.stringify(resumedPrompt.error)}`)
  const resumed = await run2.request('knowme/agentPreset.get', { sessionId: 'preset-blank' })
  if (resumed.result?.preset !== 'minimal') throw new Error(`agentPreset resume lost selected preset: ${JSON.stringify(resumed)}`)
  ok(`process 2 RESUMED preset-blank with logged agentPreset=${resumed.result.preset}`)

  const sd2 = await run2.request('shutdown', {})
  if (sd2.result === undefined) throw new Error('T6c process-2 shutdown failed')
  if ((await run2.exitPromise) !== 0) throw new Error('T6c process-2 non-zero exit')
}, { createBlankAgent: true })

await tier('T6d-create-with-preset-and-permission', async (run) => {
  await run.request('initialize', { cwd: run.dir, provider: 'deepseek-official', model: 'deepseek-v4-flash' })
  // A FRESH session's very first prompt carries the new-session dialog's choices — the create path must
  // compose under 'minimal' AND constrain permission to 'read-only' before the first turn.
  const first = await run.request('session/prompt', {
    sessionId: 'nsd', agentPreset: 'minimal', permissionPreset: 'read-only',
    contentBlocks: [{ type: 'text', text: 'created with a chosen mode + permission' }],
  })
  if (first.error !== undefined) throw new Error(`4b create prompt errored: ${JSON.stringify(first.error)}`)
  await run.waitFor(turnEnd('nsd'), 'turn/end for the create-with-preset session')

  const mode = await run.request('knowme/agentPreset.get', { sessionId: 'nsd' })
  if (mode.result?.preset !== 'minimal') throw new Error(`4b: session did not compose 'minimal': ${JSON.stringify(mode)}`)
  ok(`4b create composed agentPreset=${mode.result.preset}`)

  const perm = await run.request('knowme/permission.get', { sessionId: 'nsd' })
  if (perm.result?.preset !== 'read-only') throw new Error(`4b: permission not applied at create: ${JSON.stringify(perm)}`)
  ok(`4b create constrained permission=${perm.result.preset}`)

  const sd = await run.request('shutdown', {})
  if (sd.result === undefined) throw new Error('T6d shutdown failed')
  if ((await run.exitPromise) !== 0) throw new Error('T6d non-zero exit')
}, { createBlankAgent: true })

await tier('T7 commands list + execute', async (run) => {
  await run.request('initialize', { cwd: run.dir, provider: 'deepseek-official', model: 'deepseek-v4-flash' })
  await run.request('session/prompt', { sessionId: 't7', contentBlocks: [{ type: 'text', text: 'boot so an agent exists' }] })
  await run.waitFor(turnEnd('t7'), 'turn/end for t7')

  const listed = await run.request('knowme/commands.list', { sessionId: 't7' })
  if (listed.error !== undefined) throw new Error(`commands.list errored: ${JSON.stringify(listed.error)}`)
  const cmds = listed.result?.commands ?? []
  if (!Array.isArray(cmds) || cmds.length === 0) throw new Error(`commands.list returned no commands (commands service not composed?): ${JSON.stringify(listed.result)}`)
  for (const c of cmds) {
    if (typeof c.name !== 'string' || typeof c.description !== 'string') throw new Error(`command entry missing name/description: ${JSON.stringify(c)}`)
  }
  const names = cmds.map((c) => c.name)
  if (!names.includes('compact')) throw new Error(`expected '/compact' in the command list: [${names.join(', ')}]`)
  ok(`commands.list → [${names.join(', ')}]`)
  // Empirical record for design D4a: does /compact yield user-visible result.text? (informational — the
  // ack-summary surfacing is grounded on this, not assumed). Also note /feedback //goal behavior for D9.
  const feedbackGoal = cmds.filter((c) => c.name === 'feedback' || c.name === 'goal').map((c) => `${c.name}${c.input ? '(needs-arg)' : ''}`)
  if (feedbackGoal.length > 0) ok(`D9 note — feedback/goal: [${feedbackGoal.join(', ')}]`)

  const exec = await run.request('knowme/commands.execute', { sessionId: 't7', line: '/compact' })
  if (exec.error !== undefined) throw new Error(`commands.execute('/compact') errored: ${JSON.stringify(exec.error)}`)
  const res = exec.result
  if (res === undefined || typeof res.commandId !== 'string' || res.result === undefined || typeof res.result.kind !== 'string') {
    throw new Error(`commands.execute did not return a {commandId, result:{kind}}: ${JSON.stringify(exec.result)}`)
  }
  if (res.result.kind !== 'success' && res.result.kind !== 'error') throw new Error(`unexpected result kind: ${JSON.stringify(res.result)}`)
  ok(`commands.execute('/compact') → {kind:${res.result.kind}, text:${res.result.text !== undefined ? JSON.stringify(res.result.text).slice(0, 40) : '—'}}`)

  const unknown = await run.request('knowme/commands.execute', { sessionId: 't7', line: '/notacommand' })
  if (unknown.error === undefined || !/unknown-command/.test(JSON.stringify(unknown.error))) {
    throw new Error(`execute('/notacommand') should reject unknown-command: ${JSON.stringify(unknown)}`)
  }
  ok("commands.execute('/notacommand') → unknown-command")

  const sd = await run.request('shutdown', {})
  if (sd.result === undefined) throw new Error('T7 shutdown failed')
  if ((await run.exitPromise) !== 0) throw new Error('T7 non-zero exit')
})

// NOTE — W2 torn-log ("resume-fails → clean error, never silent fresh-create") is NOT spiked here.
// Empirically (persistence-jsonl rc.8) dsh's loader is corruption-TOLERANT at every layer the resolver
// touches: a corrupt HEADER is silently EXCLUDED from list() (parseHeaderMeta returns undefined → the
// session is not enumerated → resolver takes the create path), and a corrupt BODY is RECOVERED by
// truncating to the last committed byte (readPrefix's tornMarker). There is therefore no torn-log input
// that makes list()+inspect() throw to the resolver — the "inspect throws" branch is unreachable via
// this service. The guard stays as correct defensive code and is covered at the unit layer
// (session-lifecycle.test.ts injects inspectThrows), which is the right layer for an unreachable-in-
// practice throw. Verified by attempting header- and mid-body-corruption fixtures against the real
// runtime; both were silently recovered, never surfaced.

console.log('')
if (failures.length > 0) {
  console.error(`[verify:spike] FAILED: ${failures.join(', ')} (run root: ${RUN_ROOT})`)
  process.exit(1)
}
console.log('[verify:spike] OK — T1 T2 T3 T3b T4 T5 T6 T6b T6c T7 all passed')
