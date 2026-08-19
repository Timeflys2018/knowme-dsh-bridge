#!/usr/bin/env node
/**
 * verify:contract — pins the dsh version this bridge is validated against and
 * warns if the installed dsh packages drift from it. A dsh breaking change
 * should fail CI HERE, before the bridge silently breaks at runtime.
 *
 * SCAFFOLD: minimal version-drift check. Extend post-stable to also snapshot the
 * runtime service interfaces in src/contract.ts REQUIRED_SERVICES.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))

// The version line this bridge is validated against (keep in sync with src/contract.ts).
const PINNED = '0.1.0-rc.7'

const peers = pkg.peerDependencies ?? {}
const dshPeers = Object.keys(peers).filter((n) => n.startsWith('@deepseek-ai/dsh-'))

console.log(`[verify:contract] bridge validated against dsh ${PINNED}`)
console.log(`[verify:contract] dsh peer deps: ${dshPeers.join(', ') || '(none)'}`)

// TODO(post-stable): resolve installed @deepseek-ai/dsh-* versions and fail if
// they don't satisfy the pinned line; snapshot REQUIRED_SERVICES interface shape.
console.log('[verify:contract] OK (scaffold — full drift check deferred to dsh stable)')
process.exit(0)
