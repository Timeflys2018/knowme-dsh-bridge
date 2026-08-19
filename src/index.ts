/**
 * @knowme/dsh-bridge — B3-small wire-bridge cordis plugin entry.
 *
 * Mounts into a dsh deployment's cordis.yml (see cordis.example.yml). It runs
 * inside the dsh process and adds the `knowme/*` interaction-control methods
 * (selectModel / approval-respond / question-respond) over stdio, so an
 * out-of-process host (KnowMe) can drive dsh without restarting the runtime.
 *
 * NOTE: scaffold. Implementation is gated on dsh stable release — see README
 * "Gating". The plugin shape below is the agreed skeleton (design blueprint
 * §2.3); the bodies are TODO until dsh stabilizes and we confirm the official
 * SDK surface hasn't already added these methods.
 */

import { REQUIRED_SERVICES } from './contract.js'

/** Stable cordis plugin name (referenced from cordis.yml). */
export const name = 'knowme-sdk-bridge'

/**
 * Hard dependencies. Missing optional services degrade gracefully at runtime
 * (soft-probe with `ctx.get(x, false)`), but `agents` must be present — the
 * official jsonrpc-server already requires it.
 */
export const inject = ['agents'] as const

export { BRIDGE_METHODS, BRIDGE_NOTIFICATIONS, REQUIRED_SERVICES, PINNED_DSH_VERSION } from './contract.js'
export { createBridge } from './bridge.js'

// Re-export the required-service list so a deployment can pre-flight check them.
export const requiredServices = REQUIRED_SERVICES
