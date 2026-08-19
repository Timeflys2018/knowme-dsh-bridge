# wire-bridge-methods Specification

## Purpose
TBD - created by archiving change implement-wire-bridge. Update Purpose after archive.
## Requirements
### Requirement: selectModel switches a live session's model without restart

`knowme/selectModel` with `{sessionId, provider, model, reasoningEffort?}` SHALL resolve the call config through the `llm` service, install (or update) an agent-scoped model selection via dsh's `installModelSelection`, and return `{selected: {provider, model, reasoningEffort?}}` (reasoningEffort only when supplied). The switch SHALL take effect on the session's next assembled step without restarting the process or recreating the session. "Next assembled step" means the first step whose prompt assembly begins strictly after the method returns; a switch racing an in-flight assembly may land on the following step (a dsh `installModelSelection` guarantee, quoted so tests do not assert a stronger bound).

Param validation errors SHALL surface as JSON-RPC errors (handler rejection), not as silent no-ops.

Known advisory-catalog behavior (intentional, mirrors the official web surface): an unknown MODEL id that the provider adapter does not reject at resolve time returns `{selected}` and surfaces as an explicit LLM-call error on the session's next step — model catalog membership is advisory in dsh and is not a selection gate.

#### Scenario: model switch on an existing session

- **WHEN** a session exists (created via `session/prompt`) and the client sends `knowme/selectModel` with a provider/model the `llm` service can resolve
- **THEN** the bridge returns `{selected}` reflecting the resolved provider/model (and reasoningEffort only when supplied)
- **AND** a subsequent turn for that session assembles under the selected model, in the same process

#### Scenario: unknown session

- **WHEN** the client sends `knowme/selectModel` for a `sessionId` with no live agent in the `agents` registry
- **THEN** the bridge rejects with a `session-not-found` error carrying the sessionId

#### Scenario: unroutable model

- **WHEN** `llm.resolveCallConfig` cannot resolve the provider/model pair
- **THEN** the bridge rejects with a `model-unavailable` error carrying provider and model

#### Scenario: llm service absent

- **WHEN** the deployment composes no `llm` service and the client calls `knowme/selectModel`
- **THEN** the bridge rejects with a `llm-unavailable` error (method-level degradation; the plugin stays loaded)

### Requirement: approval-respond settles a pending approval

The bridge SHALL intercept the `approval/request` waterfall, park the decision promise keyed by the approval id recovered from the session's latest undecided `approval/asked` audit event, and push `knowme/approval-requested` with `{sessionId, approvalId, toolName, callId?, reason?}`. `knowme/approval-respond` with `{sessionId, approvalId, outcome: 'allowed-once' | 'rejected'}` SHALL settle the parked promise with exactly that outcome, letting the blocked tool call proceed or deny.

The wire contract SHALL expose only `'allowed-once'` and `'rejected'`; `'cancelled'` and `'unavailable'` remain internal (abort/teardown/fail-closed) outcomes.

#### Scenario: approval round-trip allows a tool call

- **WHEN** a tool call raises an ask, the bridge has pushed `knowme/approval-requested`, and the client replies `knowme/approval-respond` with `outcome: 'allowed-once'`
- **THEN** the parked promise settles `'allowed-once'` and the tool call proceeds
- **AND** the respond returns `{resolved: true}`

#### Scenario: rejection denies with model-readable reason

- **WHEN** the client replies `knowme/approval-respond` with `outcome: 'rejected'`
- **THEN** the approval resolves `'rejected'` and the tool call is denied with a reason naming the tool and the user's rejection

#### Scenario: unknown or already-settled approvalId

- **WHEN** `knowme/approval-respond` names an approvalId that is not parked (never seen, or already settled by an abort, a teardown, or a prior respond that won the race)
- **THEN** the bridge rejects with `approval-not-found`
- **AND** the bridge keeps no settled-id history — a client retrying an already-succeeded respond gets `approval-not-found` and MUST treat it as idempotent success

#### Scenario: sessionId mismatch

- **WHEN** `knowme/approval-respond` carries a correct approvalId but a sessionId that does not match the parked entry
- **THEN** the bridge rejects with the same `approval-not-found` as an unknown id, so a wrong-session caller cannot probe that an approval exists in another session

#### Scenario: shutdown or teardown cancels parked approvals silently

- **WHEN** the runtime receives `shutdown` (or the bridge plugin is disposed) while approvals or questions are parked
- **THEN** every parked approval settles `'cancelled'` and every parked question rejects, with no cancellation notification pushed
- **AND** each settled approval leaves an `approval/decided` audit event in the session log as the durable record
- **AND** the client contract is: connection drop or process exit means all in-flight approvals are cancelled and all open questions aborted

#### Scenario: abort settles cancelled without a client round-trip

- **WHEN** the owning step's abort signal fires while an approval is parked
- **THEN** the bridge settles the promise `'cancelled'`, removes the entry, and needs no `knowme/approval-respond`

#### Scenario: ask bypassing the audit path

- **WHEN** an `approval/request` arrives whose session log has no matching undecided `approval/asked` event
- **THEN** the bridge calls `next()` (fail-closed default) instead of parking an unanswerable entry

### Requirement: question-respond settles a pending user question

The bridge SHALL register itself as the single `userQuestions` provider (when that service is composed). On `ask`, it parks a promise keyed by a fresh requestId and pushes `knowme/question-requested` with `{sessionId, requestId, questions}`. `knowme/question-respond` with `{sessionId, requestId, answers}` — where `answers` is the full `AskUserQuestionAnswerItem[]` (`{id, selected, custom?}`) — SHALL resolve the parked promise.

#### Scenario: question round-trip

- **WHEN** the model calls the ask-user tool and the client replies `knowme/question-respond` with answers keyed by question id (including optional custom text)
- **THEN** the provider promise resolves with exactly those answers, the tool call completes with them, and the respond returns `{resolved: true}`

#### Scenario: answer items must be complete

- **WHEN** a respond carries an answer item missing `id` or `selected`, or answers no parked requestId
- **THEN** the bridge rejects (`question-not-found` for unknown requestId; a validation error for malformed items)

#### Scenario: aborted question

- **WHEN** the owning tool call aborts before the human answers
- **THEN** the bridge rejects the parked promise with the ask-aborted error and drops the entry

#### Scenario: teardown parity

- **WHEN** the bridge plugin (or its context) is disposed while approvals or questions are parked
- **THEN** every parked approval settles `'cancelled'` and every parked question rejects, with no dangling promises

### Requirement: routing contract preserved

The bridge dispatcher SHALL route exactly the three `knowme/*` methods and reject any other method with the dispatcher's unknown-method error; the official five methods (`initialize`, `session/prompt`, `shutdown` + notifications) SHALL keep their official behavior unchanged.

#### Scenario: unknown knowme method

- **WHEN** the client sends `knowme/bogus`
- **THEN** the bridge rejects with `unknown knowme-dsh-bridge method: knowme/bogus`

#### Scenario: official method passthrough is not bridge business

- **WHEN** the client sends `initialize`, `session/prompt`, or `shutdown`
- **THEN** the request is served by the official `HarnessSdkJsonRpcServer` with its documented semantics (verified end-to-end in the spike, not re-implemented here)

