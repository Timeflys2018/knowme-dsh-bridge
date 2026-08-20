# Design — implement-wire-bridge

> All dsh source anchors verified against local checkout `dsh-v0.1.0-rc.8` (git `99f6f02fec`), 2026-08-19.

## Context

The bridge runs INSIDE a dsh process as a cordis plugin and speaks the same newline-delimited stdio JSON-RPC channel as the official SDK server. dsh already implements everything the bridge exposes — the runtime supports mid-session model switching, parked approvals, and UI-backed questions — only the stdio SDK surface (5 methods) does not wire them. The bridge adds the missing wiring; it does not re-implement dsh capabilities.

## D1 — Transport ownership: bridge composes the official server class

`JsonRpcLineTransport.onRequest` REPLACES the prior handler and the official plugin builds its transport inside its own `apply` closure (deepseek-harness `packages/sdk/protocol/src/transport.ts:99-101`, `packages/sdk/server/src/index.ts:59`). Two sibling plugins therefore cannot share one stdio channel — the scaffold's original `cordis.example.yml` shape was mechanically wrong.

| Option | Correctness | Dev/maintenance | Experience | Extensibility |
|---|---|---|---|---|
| (a) two sibling plugins, two transports | ❌ double stdin read, handler replacement, double responses — eliminated | — | — | — |
| **(b) bridge owns transport, constructs official `HarnessSdkJsonRpcServer`, prefix-routes** | ✅ single channel owner; official behavior delegated verbatim | ✅ reuses the official class (`export *` from `@deepseek-ai/dsh-sdk-jsonrpc-server` root), zero fork | ✅ official 5 methods unchanged + 3 new | ✅ future official methods arrive free |
| (c) fork official server code into bridge | ⚠️ possible | ❌ duplicated drift against upstream | ✅ | ❌ diverges as dsh evolves |

**Decision: (b).** The bridge's `apply` replicates the official apply's lifecycle choreography (`packages/sdk/server/src/index.ts:46-91`): build transport → construct official server over it → single `onRequest` that routes → `ctx.effect` start/close → shared `disposeAndExit` (flush → `ctx.root.fiber.dispose()` → `exit(0)`) armed after a `shutdown` response via `setImmediate`. Official notifications flow because the official server's constructor subscribes `session/event` etc. onto the SAME transport instance (`packages/sdk/server/src/server.ts:71-103`).

**Effect registration order (load-bearing, from review)**: cordis disposes effects in reverse registration order. The transport/server effect is registered FIRST, the approval/question park-teardown effects AFTER — so disposal settles parked entries BEFORE the official server's `shutdown()` disposes agents and closes the transport. This keeps the settle→`approval/decided` audit append→`session/event` notification chain alive while persistence and subscribers still run.

**Shutdown-with-parked-approvals contract (from review)**: on `shutdown` or plugin teardown, parked approvals settle `'cancelled'` and parked questions reject SILENTLY — the bridge pushes no cancellation notification (surface stays at 3 methods + 2 notifications). The `approval/decided` audit events are the durable record; a client MUST treat "connection drop / process exit" as "all in-flight approvals cancelled and all open questions aborted". Documented in the spec.

Config: `Schema.object({ maxTokensAsSuccess: Schema.boolean().default(false) })` passed through to the official constructor — identical semantics to setting it on the official plugin. `inject = ['agents']` mirrors the official hard dependency.

**Method-shadowing guard (from adversarial review)**: the bridge routes ALL `knowme/*` methods to itself; if a future dsh release adds an official `knowme/*` method, the bridge would silently shadow it. `verify:contract` therefore pins the official `handleRequest` switch case list (`initialize`/`session/prompt`/`shutdown` exactly) — a new official case (knowme-namespaced or not) fails CI and forces a re-review of the router.

## D2 — selectModel: validate via llm, install via installModelSelection

Recipe copied from the web apiproxy implementation (`packages/host/apiproxy/src/api-proxy.ts:2222-2272`), minus web-only presentation concerns:

1. `agent = ctx.agents.get(sessionId)` — the `agents` registry is keyed by `SessionId` (`packages/core/agent/src/index.ts:257` `store = new Map<SessionId, AgentEntry>`; public `get(id): Agent | undefined` at `:583`). Missing → `session-not-found`.
2. `resolved = await ctx.llm.resolveCallConfig({provider, model, ...(reasoningEffort?...)})` (`packages/llm/llm/src/index.ts:730`) — throws `NO_ADAPTER` for unknown provider and `UNSUPPORTED_REASONING_EFFORT`; a throw maps to `model-unavailable`. Missing llm service → `llm-unavailable` (soft-probe degradation). **Known behavior (ground-truth PARTIAL, faithful to apiproxy)**: an unknown MODEL id does NOT throw here — dsh catalog membership is advisory (`packages/llm/llm/src/index.ts:577` "catalog membership is advisory and never changes routing or request validation"); the bad pick returns `{selected}` and surfaces as an explicit LLM-call error on the session's next step. Observable, not silent; identical to the official web surface.
3. `installModelSelection(agent.ctx, ref)` (`packages/core/agent/src/model-selection.ts:39`, exported from `@deepseek-ai/dsh-agent` root) — couples the selection to prompt assembly (`system-prompt/assemble` snapshot) and request routing (`agent/request` override), so a mid-turn switch lands on a later step instead of splitting the two surfaces. The bridge memoizes one ref per agent (WeakMap keyed by Agent); a second selectModel only sets `ref.current` and never re-installs (re-installing would double-register the waterfalls). **Ref semantics**: `{current: undefined, assembled: undefined}` initially — `installModelSelection` treats `undefined` as pure pass-through (returns `assembled`/`resolved` unchanged), so installing a not-yet-selected ref never leaks "undefined selection" into routing. **Disposer discipline**: the disposer returned by `installModelSelection` is intentionally dropped — cleanup rides the agent's scoped-context disposal (agent teardown drops its scoped listeners); the WeakMap is a cache, not a lifetime owner.
4. Return `{selected: {provider, model, ...(reasoningEffort only when supplied)}}`.

**Deliberate cut**: the apiproxy's image-capability pre-check (rejecting an image-incapable model for a session that already contains images) is web-UX nicety, not a correctness gate — an unsupported pick surfaces as an explicit LLM-call error at the next step, observable, not silent. B3-small keeps the surface minimal. Registered as a documented limitation in README.

**Timing guarantee (verbatim boundary)**: "next assembled step" means the first step whose `system-prompt/assemble` fires strictly AFTER `knowme/selectModel` returns; a switch racing an in-flight assembly may land on the following step (the `assembled` snapshot is captured before `next()`). This is dsh's `installModelSelection` guarantee, not the bridge's — the spec quotes it so tests don't assert a stronger bound.

## D3 — approval: intercept the waterfall, park keyed by audit id

Recipe copied from the apiproxy approval channel (`packages/host/apiproxy/src/api-proxy.ts:1392-1450`), which is itself the production consumer of the same seam the tool executor drives (`packages/core/tools/src/index.ts:1671-1728` calls `ctx.get('approval').request({agent, toolName, callId?, reason?, signal})`):

1. `ctx.on('approval/request', (req, next) => ...)` — waterfall listener (`packages/interaction/user-approval/src/index.ts` Events declaration).
2. Microtask-race guard: `req.signal?.aborted === true` → settle `'cancelled'` synchronously (no listener registered after the signal fired).
3. **Approval-id recovery**: the service appends the `approval/asked` audit event BEFORE dispatch, so several asks can be pending; the id for THIS request is the newest `approval/asked` that is undecided (`approval/decided` pairs), unclaimed by another parked entry, and callId-symmetric (`(req.callId ?? null) === (event.data.callId ?? null)`). Scan `req.agent.session.events` backwards. No match → `next()` (fail-closed default; not our question).
4. Park: `Map<ApprovalRequestId, {settle, sessionId, signal}>`; push `knowme/approval-requested {sessionId, approvalId, toolName, callId?, reason?}` over the shared transport; `signal.addEventListener('abort', once)` → settle `'cancelled'`.
5. `knowme/approval-respond {sessionId, approvalId, outcome}`: validate outcome ∈ {'allowed-once','rejected'} (wire exposes only the human decisions), then settle atomically — the settle is **idempotent by set-membership**: `if (!parked.delete(approvalId)) → approval-not-found` (first-settle-wins via `Map.delete` as the test, mirroring apiproxy `api-proxy.ts:1434`); the delete-check-settle sequence is synchronous with no awaits between the wire read and the settle, so teardown/abort cannot interleave. Return `{resolved: true}`. **Error collapse is intentional**: unknown-id and already-settled (abort/teardown/prior respond won the race) both return `approval-not-found` — the bridge keeps no settled-id history; a client retrying a succeeded respond gets `approval-not-found` and MUST treat it as idempotent success. **sessionId mismatch** (right approvalId, wrong session) also returns `approval-not-found` — deliberately the same error so a wrong-session caller cannot probe that an approval exists in another session.
6. Teardown parity: park-teardown effects (registered after the transport effect, so disposed first — see D1) settle every parked entry `'cancelled'` (the service's fail-closed vocabulary) — no dangling promise past the plugin's lifetime. Settled silently per D1's shutdown contract; the `approval/decided` audit events are the durable record.

**Known latent limitation (PEF, from adversarial review)**: the recovery scan's callId-less arm (an asker that passes no `callId`) can LIFO-swap outcomes when two callId-less asks are parked concurrently — inherited verbatim from the apiproxy, which carries the same latent behavior. Today's only producer (the tool executor, `packages/core/tools/src/index.ts:1706`) always passes `callId`, so the scan is deterministic. `verify:contract` pins this precondition by asserting the tool-executor call shape still includes `callId`.

## D4 — questions: bridge IS the provider

Recipe copied from the apiproxy provider (`packages/host/apiproxy/src/api-proxy.ts:1332-1374`):

1. Soft-probe `ctx.get('userQuestions')`; if present, call `service.registerProvider({ask})` (`packages/interaction/user-questions/src/index.ts:64-75`, single active provider) **wrapped in try/catch at the call site** — a `DUPLICATE_PROVIDER` throw (another UI registered first; the service throws inside its effect generator, which propagates to the caller) degrades to a loud `ctx.logger.warn` and question methods returning `user-questions-unavailable`; selectModel/approval are unaffected. Absent service → same degradation. Unit test pins that the throw is catchable at the call site (mounting two providers back-to-back).
2. `ask(request)`: `sessionId = request.agent?.id` — agentless asks reject (`ASK_MISSING_AGENT` semantics: stdio interaction requires an agent-owned session). Park keyed by fresh `requestId`; push `knowme/question-requested {sessionId, requestId, questions}`; abort listener rejects with the ask-aborted `UserQuestionError`. Same microtask-race guard and delete-as-test idempotent settle as D3 step 2/5.
3. `knowme/question-respond {sessionId, requestId, answers}`: `answers` is the FULL `AskUserQuestionAnswerItem[]` (`{id, selected: string[], custom?}` — `packages/interaction/user-questions/src/types.ts:53-60`). Malformed items (missing id/selected) → validation error; unknown/settled requestId → `question-not-found` (same intentional collapse as D3 step 5). Resolve the parked promise; return `{resolved: true}` (symmetric with approval-respond).
4. Teardown: dispose the provider registration, then reject every parked question (registered in the same after-transport effect group as D3 step 6, disposed before the official server).

## D5 — Contract corrections (ground-truth-driven, breaking vs scaffold)

1. **QuestionRespondParams.answers**: scaffold had `readonly (readonly string[])[]` — lossy (no question-id mapping, no custom text; the real provider contract is keyed by id). Changed to full answer items. Scaffold tests that asserted the old shape are updated in the same task as the contract change.
2. **REQUIRED_SERVICES**: drop `sessions` (lookup is `ctx.agents.get(sessionId)`; nothing reads a `sessions` service). Keep the list as documentation, but note the mechanisms differ: `llm` and `userQuestions` are actively soft-probed via `ctx.get` (their absence produces `llm-unavailable` / `user-questions-unavailable`); `approval` is **passively degraded** — the bridge registers a waterfall listener, never calls `ctx.get('approval')`, so an absent service simply means no asks ever park and `approval-respond` returns `approval-not-found`. No `approval-unavailable` error exists by design.
3. **peerDeps add**: `@deepseek-ai/dsh-sdk-jsonrpc-server`, `@deepseek-ai/dsh-user-approval`, `@deepseek-ai/dsh-user-questions`, `@deepseek-ai/dsh-llm` (all `^0.1.0-rc.8` — npm availability of all four on the rc.7 line CONFIRMED by review, under the `next` dist-tag; `latest` still points at older rcs, so installs must resolve the explicit range). Existing peerDeps stay: `dsh-agent` (installModelSelection), `dsh-session`/`dsh-sdk-protocol` (transitive type surface; re-evaluate at 0.1 if redundant).

## D6 — Real verification (keyless, real process, real stdio)

Test-methodology adaptation: this repo has no Electron; the e2e ground truth is a **real dsh child process driven over real stdio**.

- Harness: `verify/spike/` — driver script (spawns the composed runtime, speaks JSON-RPC over stdin/stdout), `cordis.yml` (based on `examples/jsonrpc-agent/cordis.yml` + `@deepseek-ai/dsh-user-approval` + `@deepseek-ai/dsh-user-questions` + bridge entry IN PLACE of the official server entry), deps installed in a gitignored `node_modules`.
- LLM base (keyless): prefer `@deepseek-ai/dsh-llm-replay` from the local dsh checkout (`packages/test-support/llm-replay`, file: dependency) serving a recorded/fixture transcript; fallback: a ~20-line mock-llm cordis plugin local to the spike (test fixture, not shipped) registering a provider catalog + canned turn responses.
- Tiers:
  - **T1 protocol/lifecycle**: initialize handshake; official `session/prompt` + `session.event` flow; `knowme/*` error taxonomy (unknown method, session-not-found, approval-not-found); `shutdown` → exit 0.
  - **T2 selectModel no-restart**: with a live session, `knowme/selectModel` to a different catalog model → `{selected}`; assert the session keeps working and the switch took effect (via session events' logged model or a second turn) in the SAME process. Optional: fire selectModel mid-step to empirically document the assembled/current land-on-later-step boundary.
  - **T3 approval/question round-trip**: a tiny in-process trigger plugin (spike fixture) calls `approval.request(...)` / drives a question through the `userQuestions` service with the exact production call shape (`packages/core/tools/src/index.ts:1706` field-for-field — guards the dead-code-fixture trap); driver asserts `knowme/approval-requested` → `knowme/approval-respond` → parked promise settles; same for questions; abort path settles cancelled with NO respond round-trip (driver asserts no further frames expected).
  - **T3.b shutdown-while-parked**: send `shutdown` while an approval is parked; assert the parked promise settles `'cancelled'`, the audit `approval/decided` event lands in the session log, and the process exits 0 — the observable path for the D1 shutdown contract.
- Owner dogfood (真机) is substituted per methodology §0.5 by the above; runtime-specific phenomena go to a follow-up observation list.

## Risks / trade-offs

| Risk | Mitigation |
|---|---|
| dsh rc churn breaks service shapes (developer-preview) | `verify:contract` pins version + surface (CI gate); surface kept at 3 methods; official-stable-supersedes rule stands (B1 wins) |
| approval-id recovery depends on audit-event ordering (`approval/asked` appended before dispatch) | copied verbatim from the apiproxy's battle-tested scan incl. the microtask-race and callId-symmetry guards; unit tests pin the scan algorithm |
| single-provider collision: another UI registers `userQuestions` first | `registerProvider` throws DUPLICATE_PROVIDER → bridge logs a loud warning and degrades question methods; selectModel/approval unaffected |
| mock LLM fixture could mask real adapter behavior | T2 asserts via session event log (durable, adapter-independent); replay adapter is dsh's own test-support package, not a hand-rolled fake, when available |
| peerDep not actually published to npm | task explicitly checks `npm view` before pinning; unpublished → local file:/link documented in README (owner/developer-only distribution anyway) |

## Testing strategy

- **Unit (vitest, mock ctx)**: routing + error taxonomy; approval-id recovery scan (synthetic event logs: parallel asks, decided/undecided, callId symmetry, claimed exclusion); park/settle/abort/teardown lifecycles; question provider mapping + validation; selectModel ref installation (captured waterfall handlers invoked with stub `next`). TDD: these tests are written FIRST against the scaffold (red: `not implemented (gated)`), then greened.
- **RED proof**: revert bodies to scaffold throws → new tests fail (per test-methodology §9.2, executed during implementation review).
- **Real spike (above)**: T1/T2/T3 as scripts with pass/fail exit codes; wired into `verify:spike` npm script.
