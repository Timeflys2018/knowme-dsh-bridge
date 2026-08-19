/**
 * Spike-only cordis plugin: drives the approval seam and the user-questions
 * service with the EXACT production call shapes so the bridge is exercised
 * against real askers, not test doubles.
 *
 * Production shapes pinned here (see verify:contract section 7):
 * - approval: packages/core/tools/src/index.ts:1706 — request({agent, toolName, callId, reason?, signal})
 * - questions: the ask-user tool's service call — ask({questions, agent, signal?})
 *
 * Triggers fire from the agent/pre-step waterfall (payload carries the turn
 * abort signal) and AWAIT the ask before next(), mirroring how the tool
 * executor holds its turn open across a pending approval/question. Asking
 * from outside a held turn loses the approval/decided audit pair at shutdown
 * (session detach drops the append) — the turn-enclosed shape is the contract.
 */
const APPROVAL_MARKER = 'SPIKE_TRIGGER_APPROVAL'
const QUESTION_MARKER = 'SPIKE_TRIGGER_QUESTION'

export const name = 'knowme-spike-trigger'
export const inject = ['agents']

export function apply(ctx) {
  const fired = new Set()

  ctx.on('agent/pre-step', async (payload, next) => {
    const agent = payload.agent
    const text = JSON.stringify(agent.session.events)
    const shouldFire = (marker) => {
      if (!text.includes(marker) || fired.has(marker + agent.id)) return false
      fired.add(marker + agent.id)
      return true
    }

    if (shouldFire(APPROVAL_MARKER)) {
      const approval = ctx.get('approval')
      if (approval === undefined) {
        process.stderr.write('[spike] approval service not composed\n')
      } else {
        try {
          const outcome = await approval.request({
            agent,
            toolName: 'spike-bash',
            callId: 'call-spike-1',
            reason: 'spike approval drill',
            signal: payload.signal,
          })
          process.stderr.write(`[spike] approval settled: ${outcome}\n`)
        } catch (error) {
          process.stderr.write(`[spike] approval failed: ${String(error)}\n`)
        }
      }
    }

    if (shouldFire(QUESTION_MARKER)) {
      const userQuestions = ctx.get('userQuestions')
      if (userQuestions === undefined) {
        process.stderr.write('[spike] user-questions service not composed\n')
      } else {
        try {
          const answer = await userQuestions.ask({
            questions: [{ id: 'q1', question: 'Proceed with the spike?', options: [{ label: 'yes' }, { label: 'no' }] }],
            agent,
            signal: payload.signal,
          })
          process.stderr.write(`[spike] question answered: ${JSON.stringify(answer)}\n`)
        } catch (error) {
          process.stderr.write(`[spike] question failed: ${String(error)}\n`)
        }
      }
    }

    return next()
  })
}
