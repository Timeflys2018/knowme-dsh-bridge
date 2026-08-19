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

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))

const PINNED = '0.1.0-rc.7'

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

console.log('')
if (failures.length > 0) {
  console.error(`[verify:contract] FAILED — ${failures.length} surface(s) drifted from the pinned contract:`)
  for (const f of failures) console.error(`  ✗ ${f}`)
  process.exit(1)
}
console.log('[verify:contract] OK — pinned version + all surfaces present')
