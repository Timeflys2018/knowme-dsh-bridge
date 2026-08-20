## MODIFIED Requirements

### Requirement: the bridge is the sole transport owner

Inside one dsh deployment, exactly one plugin SHALL own the stdio `JsonRpcLineTransport`. The bridge plugin SHALL create that transport, construct the official `HarnessSdkJsonRpcServer` over the same transport instance, and install a single request handler that dispatches by method: `knowme/*` to the bridge dispatcher; `session/prompt` to the bridge's own session-lifecycle resolver (see "session resume on prompt"); everything else (`initialize`, `shutdown`, and any other official method) to the official server. The bridge SHALL observe the `initialize` params as they pass through (capturing `cwd`/`provider`/`model`/`maxTokens`) before forwarding `initialize` to the official server. The official server's outgoing notifications (`session.event`, `session.status`, `subagent.*`) SHALL flow over the same shared transport regardless of whether the prompt's agent was created or resumed.

#### Scenario: one stdin reader

- **WHEN** a deployment loads this bridge per its cordis.yml
- **THEN** no second transport is constructed for the official server (the bridge's constructor argument is the shared instance), and stdin has exactly one reader

#### Scenario: official notifications preserved

- **WHEN** a session emits events after `initialize`
- **THEN** the client still receives `session.event` / `session.status` / `subagent.*` notifications exactly as the official standalone server would emit them, for both freshly-created and resumed sessions

#### Scenario: initialize and shutdown still delegate to the official server

- **WHEN** the client sends `initialize` or `shutdown`
- **THEN** the official server handles it unchanged (adapter mount / provider-model-cwd binding / deepseek fallback for initialize; drain choreography for shutdown), and the bridge only records the initialize params in passing

### Requirement: deployment configuration surface

The bridge plugin SHALL declare `name`, `inject = ['agents', 'sessions', 'sessionPersistence']`, and a schemastery `Config` schema accepting `maxTokensAsSuccess` (same default as the official server: `false`). A deployment mounts it IN PLACE OF `@deepseek-ai/dsh-sdk-jsonrpc-server` (not alongside), and composes the services its used methods need (`llm` for selectModel, `approval` + an ask-raising toolchain for approvals, `userQuestions` for questions, `sessions` + `sessionPersistence` for the prompt resume gate). `cordis.example.yml` SHALL show exactly this shape.

#### Scenario: config passthrough

- **WHEN** the deployment sets `maxTokensAsSuccess: true` on the bridge entry
- **THEN** the official server is constructed with that option and token-limited turns report as success, identically to setting it on the official plugin

#### Scenario: hard dependency unchanged

- **WHEN** the deployment composes no `agents` (or no `sessions` / `sessionPersistence`) service
- **THEN** the bridge fails to load, exactly as the official server would for its own hard deps

### Requirement: pinned contract snapshot

`verify:contract` SHALL fail when the pinned dsh version line or any service surface the bridge reads (`agents` registry keyed by SessionId including `agents.create` and `agents.resume`, `sessions.get`, `sessionPersistence.list`/`sessionPersistence.inspect`, `createUserMessage` + `agent.followup` for prompt delivery, `llm.resolveCallConfig`, `approval/request` waterfall + `approval/asked`/`approval/decided` audit events, `userQuestions.registerProvider`, `installModelSelection` export, `HarnessSdkJsonRpcServer` class export) changes, so dsh developer-preview churn breaks CI before it breaks the bridge silently.

#### Scenario: contract drift is loud

- **WHEN** the dsh dependency line moves past the pinned line or a required export disappears (including `agents.resume`, `sessions.get`, `sessionPersistence.list/inspect`, `createUserMessage`, `agent.followup`)
- **THEN** `pnpm verify:contract` exits non-zero naming the drifted surface

## ADDED Requirements

### Requirement: session resume on prompt (three-state lifecycle)

On each `session/prompt {sessionId, contentBlocks}`, the bridge SHALL resolve the target agent by a three-state gate (mirroring dsh's own apiproxy host gate) instead of always creating, so a persisted session reopens its on-disk log rather than colliding with it:

1. **attached (live)**: if `ctx.agents.get(sessionId)` returns a live agent, reuse it.
2. **detached-on-disk**: else if `ctx.get('sessionPersistence').list()` shows a persisted header with `id === sessionId`, the bridge SHALL `ctx.agents.resume({ resumeSessionId: sessionId, agentOptions })` to load the persisted JSONL history. Before resuming, if the persisted `meta.cwd` differs from the initialized `cwd`, the bridge SHALL reject with a clear cwd-conflict error (never resume into a different workspace).
3. **new**: else `ctx.agents.create({ sessionId, meta: { cwd }, agentOptions })`.

`agentOptions` SHALL be `{ provider, model, ...(maxTokens set → { maxTokens }) }` from the captured `initialize` params. The bridge SHALL NOT compose presets or pass a `setup` callback (the knowme-sdk deployment uses no preset roster). After resolving the agent, the bridge SHALL deliver the prompt via `createUserMessage({ content: contentBlocks, source: { kind: 'user' } })` + `agent.followup(message)` and return `{ messageId: message.id }` — the same result shape as the official server's `prompt()`. Concurrent `session/prompt` for the same `sessionId` SHALL share one in-flight create/resume (a per-id promise map), never race two registrations.

#### Scenario: second turn resumes the persisted log (no collision)

- **WHEN** a session's first turn created + persisted a JSONL log, and a later `session/prompt` for the SAME sessionId arrives when that agent is NOT live in memory (fresh/recycled process)
- **THEN** the bridge resumes via `ctx.agents.resume` (loads the JSONL), the prompt runs with prior context, and NO "already has a persisted log … id collision" error occurs

#### Scenario: first turn creates

- **WHEN** `session/prompt` arrives for a sessionId with no live agent AND no persisted log on disk
- **THEN** the bridge creates via `ctx.agents.create({ sessionId, meta:{cwd}, agentOptions })` and delivers the prompt

#### Scenario: same-process second turn reuses the live agent

- **WHEN** a session's agent is still live in memory and a second `session/prompt` arrives
- **THEN** the bridge reuses `ctx.agents.get(sessionId)` (neither create nor resume) and delivers the followup

#### Scenario: cwd conflict on resume is rejected

- **WHEN** a persisted session's `meta.cwd` differs from the cwd bound at `initialize`
- **THEN** the bridge rejects the prompt with a clear cwd-conflict error rather than resuming into the wrong workspace

#### Scenario: prompt result shape unchanged

- **WHEN** any `session/prompt` succeeds (created, resumed, or reused)
- **THEN** the response is `{ messageId }` with the id of the delivered user message, identical to the official server's contract

#### Scenario: prompt before initialize is rejected

- **WHEN** a `session/prompt` arrives before any `initialize` (no captured cwd/provider/model)
- **THEN** the bridge rejects with a clear "initialize required" error and does NOT create/resume with defaulted params

#### Scenario: a throwing persistence inspect/resume surfaces a clean error (no silent fresh-create)

- **WHEN** `inspect`/`resume` throws for a session (e.g. a persistence backend that rejects a corrupt log)
- **THEN** the bridge surfaces a clean `session/prompt` error and SHALL NOT fall back to a fresh `create` (a silent fresh-create would re-introduce id-collision/history-loss and mask corruption)
- **NOTE** the shipped dsh `persistence-jsonl` service is corruption-TOLERANT (corrupt header → excluded from `list()`; corrupt body → truncated to the committed prefix), so this throw branch is unreachable via that service and is verified at the unit layer via an injected-throw fake rather than the runtime spike

#### Scenario: concurrent same-id prompts share one create/resume

- **WHEN** two `session/prompt` for the same sessionId arrive before the first create/resume settles
- **THEN** both share one in-flight create/resume (per-id promise), neither double-registers the agent, and each receives its own `{messageId}` with its followup delivered

#### Scenario: resuming a session with a stored preset is rejected until supported

- **WHEN** a persisted session's `meta.agentPreset` is defined (a future roster deployment)
- **THEN** the bridge rejects with a clear preset-resume-unsupported error rather than resuming with no `setup` (which would rebuild a session the model can't act on)
