#!/usr/bin/env node
/**
 * verify:contract — pins the dsh version line AND every runtime surface the
 * bridge reads, so a dsh developer-preview breaking change fails CI here,
 * before the bridge silently breaks. Surfaces pinned (design D1/D3/D5):
 *
 *  1. every @deepseek-ai/dsh-* dependency installed at exactly the pinned rc
 *  2. `installModelSelection` + `AgentRegistry.get(sessionId)` from dsh-agent
 *  3. `HarnessSdkJsonRpcServer` class from dsh-sdk-jsonrpc-server, whose
 *     handleRequest switch handles EXACTLY initialize/session-prompt/shutdown
 *     (a new official case — especially a `knowme/*` one — must force a
 *     re-review of the bridge router: the bridge would shadow it)
 *  4. approval surfaces: ApprovalService export, the 'approval/request'
 *     waterfall, and the approval/asked / approval/decided audit-event data
 *     field names the recovery scan reads (id / toolName / callId)
 *  5. user-questions surfaces: UserQuestionService.registerProvider + ask
 *  6. llm surface: resolveCallConfig
 *  7. the production approval caller shape still passes callId (the recovery
 *     scan's callId symmetry precondition — see design D3 latent limitation)
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))

const PINNED = '0.1.0-rc.8'

const failures = []
const check = (ok, label) => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}`)
  if (!ok) failures.push(label)
}

function libText(packageName) {
  const root = dirname(require.resolve(join(packageName, 'package.json')))
  let text = ''
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (entry.endsWith('.js')) text += readFileSync(full, 'utf8')
    }
  }
  walk(join(root, 'lib'))
  return text
}

console.log(`[verify:contract] bridge validated against dsh ${PINNED}`)

console.log('\n[1] installed dsh package versions')
const dshDeps = Object.keys({ ...pkg.peerDependencies, ...pkg.devDependencies })
  .filter((n) => n.startsWith('@deepseek-ai/dsh-'))
for (const name of dshDeps.sort()) {
  const installed = require(join(name, 'package.json')).version
  check(installed === PINNED, `${name}@${installed} === ${PINNED}`)
}

console.log('\n[2] dsh-agent surfaces')
const agent = await import('@deepseek-ai/dsh-agent')
check(typeof agent.installModelSelection === 'function', 'installModelSelection exported')
check(typeof agent.AgentRegistry?.prototype.get === 'function', 'AgentRegistry.get(sessionId) exists')

console.log('\n[3] official SDK server surface + switch-case list (shadowing guard)')
const serverPkg = await import('@deepseek-ai/dsh-sdk-jsonrpc-server')
check(typeof serverPkg.HarnessSdkJsonRpcServer === 'function', 'HarnessSdkJsonRpcServer exported')
check(typeof serverPkg.HarnessSdkJsonRpcServer?.prototype.handleRequest === 'function', 'handleRequest method exists')
const serverLib = libText('@deepseek-ai/dsh-sdk-jsonrpc-server')
const officialCases = [...serverLib.matchAll(/case ["']([^"']+)["']/g)].map((m) => m[1])
const expectedCases = ['initialize', 'session/prompt', 'shutdown'].sort().join(', ')
check(officialCases.sort().join(', ') === expectedCases,
  `official switch-case set is EXACTLY {${expectedCases}} (found: ${officialCases.join(', ')})`)

console.log('\n[4] approval surfaces')
const approval = await import('@deepseek-ai/dsh-user-approval')
check(typeof approval.ApprovalService === 'function', 'ApprovalService exported')
const approvalLib = libText('@deepseek-ai/dsh-user-approval')
check(approvalLib.includes("'approval/request'"), "'approval/request' waterfall declared")
check(approvalLib.includes('approval/asked') && approvalLib.includes('approval/decided'), 'audit events approval/asked + approval/decided')
for (const field of ['toolName', 'callId']) {
  check(approvalLib.includes(field), `asked data field '${field}'`)
}

console.log('\n[5] user-questions surfaces')
const questions = await import('@deepseek-ai/dsh-user-questions')
check(typeof questions.UserQuestionService?.prototype.registerProvider === 'function', 'registerProvider exists')
check(typeof questions.UserQuestionService?.prototype.ask === 'function', 'ask exists')

console.log('\n[6] llm surface')
const llmLib = libText('@deepseek-ai/dsh-llm')
check(llmLib.includes('resolveCallConfig'), 'resolveCallConfig exists')

console.log('\n[7] production approval caller shape (callId precondition)')
const toolsLib = libText('@deepseek-ai/dsh-tools')
check(toolsLib.includes('approval.request') || toolsLib.includes('approval?.request'), 'tool executor calls approval.request')
check(toolsLib.includes('callId: exec.callId') || /callId:\s*\w+\.callId/.test(toolsLib), 'tool executor passes callId (scan precondition)')

console.log('\n[8] session-lifecycle surfaces (bridge owns session/prompt — design D4)')
// AgentRegistry.resume + create back the three-state gate; SessionId brands every id the gate
// passes to the registry; createUserMessage delivers the prompt. The sessionPersistence.list/inspect
// service is host-composed (not bundled in the dsh-session npm package), so its shape is pinned by
// the runtime spike (verify:spike) rather than here.
check(typeof agent.AgentRegistry?.prototype.resume === 'function', 'AgentRegistry.resume(resumeSessionId) exists')
check(typeof agent.AgentRegistry?.prototype.create === 'function', 'AgentRegistry.create(sessionId) exists')
const sessionMod = await import('@deepseek-ai/dsh-session')
check(typeof sessionMod.SessionId === 'function', 'SessionId branding factory exported')
const llmMod = await import('@deepseek-ai/dsh-llm')
check(typeof llmMod.createUserMessage === 'function', 'createUserMessage exported')

console.log('\n[9] cordis FiberState enum (knowme/listPlugins fiberPhase mapping)')
// The bridge's FIBER_PHASE maps cordis FiberState numeric values → phase strings. FiberState is a
// compile-time `const enum` (erased at runtime), so pin the numeric values by scanning the type
// declaration. A dsh/cordis change to these numbers must fail CI (the mapping would silently drift).
// The loader `entries()` shape (options.name/group, disabled, fiber.state) is a host-composed surface
// validated by the runtime spike (verify:spike), mirroring sessionPersistence in [8].
{
  const cordisFiberDts = join(
    dirname(require.resolve('@deepseek-ai/cordis/package.json')),
    'lib', 'types', 'fiber.d.ts',
  )
  const fiberDts = readFileSync(cordisFiberDts, 'utf8')
  const expectedStates = [
    ['PENDING', 0], ['LOADING', 1], ['ACTIVE', 2], ['FAILED', 3], ['DISPOSED', 4], ['UNLOADING', 5],
  ]
  for (const [label, value] of expectedStates) {
    check(new RegExp(`${label}\\s*=\\s*${value}\\b`).test(fiberDts), `FiberState.${label} === ${value}`)
  }
}

console.log('\n[10] token-meter projection surfaces (knowme/sessionStats mapping)')
{
  // token-meter + session-projection are host-composed (loaded from the dsh
  // profile at runtime, NOT bridge deps), so resolve them from the profile's
  // node_modules — the exact tree dsh imports. Absent profile (e.g. bare CI)
  // degrades to a skip, mirroring how [8]/[9] defer host-composed shapes to
  // the runtime spike (verify:spike pins them for real against a live runtime).
  const profileNm = join(homedir(), '.dsh', 'profiles', 'node_modules', '@deepseek-ai')
  const projPath = join(profileNm, 'dsh-token-meter', 'src', 'projection.ts')
  const regPath = join(profileNm, 'dsh-session-projection', 'src', 'index.ts')
  if (!existsSync(projPath) || !existsSync(regPath)) {
    console.log('  ⚠ skipped — dsh profile not installed (verify:spike pins these against the live runtime)')
  } else {
    const projectionSrc = readFileSync(projPath, 'utf8')
    for (const field of ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
      check(new RegExp(`\\b${field}\\b`).test(projectionSrc), `TokenUsageProjection.${field} present`)
    }
    const [tokenUsageBlock] = projectionSrc.split('ContextPressure')
    check(!/\binputTokens\s*:/.test(tokenUsageBlock ?? projectionSrc),
      'TokenUsageProjection uses uncachedInputTokens (NOT inputTokens) for cumulative input')
    for (const field of ['pressureTokens', 'contextWindow']) {
      check(new RegExp(`\\b${field}\\b`).test(projectionSrc), `ContextPressureProjection.${field} present`)
    }
    const registrySrc = readFileSync(regPath, 'utf8')
    check(/snapshot\s*\(\s*session\s*:/.test(registrySrc), 'SessionProjectionRegistry.snapshot(session) exists')
    check(/values\s*:\s*Partial<SessionProjectionMap>/.test(registrySrc), 'ProjectionSnapshot.values keyed by projection name')
  }
}

console.log('\n[11] session-stats projection surfaces (knowme/sessionStats rich metrics)')
{
  const profileNm = join(homedir(), '.dsh', 'profiles', 'node_modules', '@deepseek-ai')
  const ssPath = join(profileNm, 'dsh-session-stats', 'src', 'projection.ts')
  if (!existsSync(ssPath)) {
    console.log('  ⚠ skipped — dsh profile not installed (verify:spike pins this against the live runtime)')
  } else {
    const src = readFileSync(ssPath, 'utf8')
    check(/key:\s*'sessionStats'/.test(src), "sessionStats projection key === 'sessionStats'")
    for (const field of ['turns', 'steps', 'llmMs', 'toolMs', 'ttftMs', 'ttftSteps', 'decodeMs', 'decodeTokens']) {
      check(new RegExp(`\\b${field}\\b`).test(src), `SessionStatsProjection.${field} present`)
    }
    const ver = require(join(profileNm, 'dsh-session-stats', 'package.json')).version
    check(ver === PINNED, `@deepseek-ai/dsh-session-stats@${ver} === ${PINNED}`)
  }
}

console.log('\n[12] permission-presets service surfaces (knowme/permission.get + set)')
{
  const profileNm = join(homedir(), '.dsh', 'profiles', 'node_modules', '@deepseek-ai')
  const ppPath = join(profileNm, 'dsh-permission-presets', 'src', 'index.ts')
  if (!existsSync(ppPath)) {
    console.log('  ⚠ skipped — dsh profile not installed (verify:spike pins this against the live runtime)')
  } else {
    const src = readFileSync(ppPath, 'utf8')
    check(/super\(ctx,\s*'permissionPresets'\)/.test(src), "service registers as 'permissionPresets'")
    check(/key:\s*'permissions'/.test(src), "session projection key === 'permissions'")
    check(/\bresolve\s*\(\s*name\s*:\s*string\s*\)\s*:\s*PresetSpec\b/.test(src), 'public resolve(name): PresetSpec present')
    check(/\bset\s*\(\s*session\s*:\s*Session\s*,\s*name\s*:\s*string\s*\)\s*:\s*void\b/.test(src), 'public set(session, name): void present')
    const ver = require(join(profileNm, 'dsh-permission-presets', 'package.json')).version
    check(ver === PINNED, `@deepseek-ai/dsh-permission-presets@${ver} === ${PINNED}`)
  }
}

console.log('')
if (failures.length > 0) {
  console.error(`[verify:contract] FAILED — ${failures.length} surface(s) drifted from the pinned contract:`)
  for (const f of failures) console.error(`  ✗ ${f}`)
  process.exit(1)
}
console.log('[verify:contract] OK — pinned version + all surfaces present')
