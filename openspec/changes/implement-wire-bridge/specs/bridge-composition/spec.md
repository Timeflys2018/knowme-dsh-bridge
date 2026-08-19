# bridge-composition — single-transport composition with the official SDK server

## ADDED Requirements

### Requirement: the bridge is the sole transport owner

Inside one dsh deployment, exactly one plugin SHALL own the stdio `JsonRpcLineTransport`. The bridge plugin SHALL create that transport, construct the official `HarnessSdkJsonRpcServer` over the same transport instance, and install a single request handler that dispatches by method prefix: `knowme/*` to the bridge dispatcher, everything else to the official server. The official server's outgoing notifications (`session.event`, `session.status`, `subagent.*`) SHALL flow over the same shared transport.

#### Scenario: one stdin reader

- **WHEN** a deployment loads this bridge per its cordis.yml
- **THEN** no second transport is constructed for the official server (the bridge's constructor argument is the shared instance), and stdin has exactly one reader

#### Scenario: official notifications preserved

- **WHEN** a session emits events after `initialize`
- **THEN** the client still receives `session.event` / `session.status` / `subagent.*` notifications exactly as the official standalone server would emit them

### Requirement: shutdown lifecycle preserved

The bridge SHALL replicate the official apply() exit choreography: after the `shutdown` request's response is written, flush the transport, dispose the root fiber (awaiting persistence), and exit 0; stdin EOF and signals keep the app-bin-owned semantics. The `knowme/*` methods SHALL NOT trigger process exit.

#### Scenario: clean shutdown

- **WHEN** the client sends `shutdown`
- **THEN** the official handler's result is flushed, the root runtime is disposed, and the process exits 0

### Requirement: deployment configuration surface

The bridge plugin SHALL declare `name`, `inject = ['agents']`, and a schemastery `Config` schema accepting `maxTokensAsSuccess` (same default as the official server: `false`). A deployment mounts it IN PLACE OF `@deepseek-ai/dsh-sdk-jsonrpc-server` (not alongside), and composes the services its used methods need (`llm` for selectModel, `approval` + an ask-raising toolchain for approvals, `userQuestions` for questions). `cordis.example.yml` SHALL show exactly this shape.

#### Scenario: config passthrough

- **WHEN** the deployment sets `maxTokensAsSuccess: true` on the bridge entry
- **THEN** the official server is constructed with that option and token-limited turns report as success, identically to setting it on the official plugin

#### Scenario: hard dependency unchanged

- **WHEN** the deployment composes no `agents` service
- **THEN** the bridge fails to load, exactly as the official server would

### Requirement: pinned contract snapshot

`verify:contract` SHALL fail when the pinned dsh version line or any service surface the bridge reads (`agents` registry keyed by SessionId, `llm.resolveCallConfig`, `approval/request` waterfall + `approval/asked`/`approval/decided` audit events, `userQuestions.registerProvider`, `installModelSelection` export, `HarnessSdkJsonRpcServer` class export) changes, so dsh developer-preview churn breaks CI before it breaks the bridge silently.

#### Scenario: contract drift is loud

- **WHEN** the dsh dependency line moves past the pinned line or a required export disappears
- **THEN** `pnpm verify:contract` exits non-zero naming the drifted surface
