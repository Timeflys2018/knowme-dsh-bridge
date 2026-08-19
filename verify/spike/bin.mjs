/**
 * Spike runtime bin — replicates dsh's dsh-jsonrpc-agent runner
 * (packages/examples/jsonrpc-demo/src/runner.ts): boot the cordis tree from
 * DSH_CORDIS_CONFIG/argv, own EOF/signal exits. Stdout = JSON-RPC.
 */
import { existsSync } from 'node:fs'
import { boot, installFailLoud, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'

const NAME = 'knowme-dsh-bridge-spike'

installFailLoud(NAME)

const fromEnv = process.env['DSH_CORDIS_CONFIG']
const fromArgv = process.argv[2]
const requested = fromEnv !== undefined && fromEnv !== '' ? fromEnv : fromArgv
const configPath = requested === undefined ? undefined : resolveConfigPath(requested, undefined)
if (configPath === undefined || !existsSync(configPath)) {
  process.stderr.write(`usage: ${NAME} <path/to/cordis.yml> (or DSH_CORDIS_CONFIG=<path>)\n`)
  process.exit(1)
}

const ctx = await boot(NAME, configPath)
let exiting = false
async function disposeAndExit(code) {
  if (exiting) return
  exiting = true
  try {
    await ctx.fiber.dispose()
  } finally {
    process.exit(code)
  }
}
process.stdin.on('end', () => { void disposeAndExit(0) })
process.on('SIGTERM', () => { void disposeAndExit(0) })
process.on('SIGINT', () => { void disposeAndExit(130) })
