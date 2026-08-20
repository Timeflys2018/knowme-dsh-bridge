# Design — dsh-bridge-session-resume

## Context

`dsh --profile knowme-sdk` composes `[@deepseek-ai/dsh-base, @knowme/dsh-bridge]`. The bridge is the sole stdio transport owner: it constructs the `JsonRpcLineTransport`, embeds a stock `HarnessSdkJsonRpcServer` over it, and routes each request — `knowme/*` to the bridge dispatcher, everything else to `server.handleRequest` (`src/index.ts:106-108`).

The stock server's `getOrCreateSession(id)` (server.ts:203) checks its private in-memory `this.sessions` map, misses on a fresh/recycled process, and calls `ctx.agents.create({sessionId})`. dsh persists each session to `~/.dsh/sessions/<cwd>/<id>/session.jsonl.zstd`; `create(sameId)` refuses to materialize over an existing on-disk log → **id-collision error** on every 续聊 turn that doesn't hit the same live process. The full history lives in that JSONL — reopenable only via `ctx.agents.resume`, which the stock server never calls.

dsh's OWN reference host, `@deepseek-ai/dsh-host-apiproxy` (used by `--profile web`), already solves this with a three-state gate (`api-proxy.ts:1572-1616`). This change ports that PROVEN gate into the bridge's stdio face for `session/prompt` only.

## Decisions

### D1 — B-plugin (bridge owns session/prompt lifecycle), NOT B-fork (patch dsh source)
The bridge is already the transport owner and request router; adding a resume gate at that layer is where dsh's own architecture puts it (apiproxy is a host-layer gate, not inside the SDK server). B-fork would patch a pinned rc.8 dev-preview source (rebase debt every dsh bump). B-plugin depends only on dsh's STABLE public service APIs (`ctx.agents.create|resume`, `ctx.sessions.get`, `ctx.get('sessionPersistence').list|inspect`, `agent.followup`, `createUserMessage`) which `verify:contract` pins. Rejected alternatives: adopting apiproxy wholesale (fetch/in-process carriers only, no stdio; 442-line RPC contract vs the 5-method stdio protocol — would force KnowMe off its stdio resident-pool architecture).

### D2 — Only `session/prompt` gains the gate; `initialize`/`shutdown` still delegate
`initialize` (adapter mount, provider/model/cwd binding, no-adapter deepseek fallback) and `shutdown` (drain choreography) stay delegated to the embedded stock server — unchanged behavior, no re-implementation. The bridge intercepts ONLY `session/prompt`. This keeps the change minimal and the adapter/shutdown machinery authoritative.

### D3 — Bridge captures initialize params from the request stream
`this.cwd/provider/model/maxTokens` are private in the stock server. The bridge's `onRequest` sees the `initialize` params before forwarding them; it records `{cwd, provider, model, maxTokens}` into bridge-local state, then still forwards to `server.handleRequest` (the stock server binds its own copy for its own `create` path, which is now unused for prompt but harmless). The bridge uses its captured copy to construct `agentOptions` for its own create/resume.

### D4 — Three-state resolver on `session/prompt` (mirror apiproxy 1572-1616, minus presets)
On **every** `session/prompt {sessionId, contentBlocks}` entry (the live check MUST run per-prompt, not once per session — this also naturally handles the stock server's agent-disposed-outside guard, server.ts:137, since a disposed agent is no longer returned by `ctx.agents.get`):
1. **attached**: `ctx.agents.get(SessionId(sessionId))` (live agent) → reuse.
2. **detached-on-disk**: `persistence = ctx.get('sessionPersistence')`; if `(await persistence.list()).some(h => h.id === sessionId)` → `inspected = await persistence.inspect(SessionId(sessionId))`; guard cwd (D5) + preset (NIT below); then `ctx.agents.resume({ resumeSessionId: SessionId(sessionId), agentOptions })`. This loads the JSONL → real continuity.
3. **new**: `ctx.agents.create({ sessionId: SessionId(sessionId), meta: { cwd }, agentOptions })`.

**SessionId branding (W5)**: `ctx.agents.create/resume` and `ctx.agents.get` take the branded `SessionId`, not a raw string. Import the `SessionId` factory from `@deepseek-ai/dsh-session` and wrap the wire string at every call site (as the stock server does, server.ts:224). `verify:contract` pins the `SessionId` export.

`agentOptions = { provider, model, ...(maxTokens !== undefined ? { maxTokens } : {}) }` from D3's captured initialize params. **NO preset composition / no `setup` callback** — the knowme-sdk stock server itself uses none (server.ts:219 "No preset composition"), so resume/create mirror that minimal form. No `resolveSessionPreset`/`assertPresetUnchanged` needed (that is apiproxy roster machinery irrelevant to knowme-sdk).

**Confirmed `sessionPersistence` surface (rc.8, was an Open Question — now resolved by source read)**: service key `'sessionPersistence'`; `list(signal?): Promise<SessionHeader[]>`; `inspect(id, signal?): Promise<{ meta: SessionHeader; events: readonly SessionEvent[] }>`; `SessionHeader` has `.id` and `.cwd`.

Then deliver the prompt exactly as the stock server does: `const msg = createUserMessage({ content: contentBlocks, source: { kind: 'user' } }); agentHandle.agent.followup(msg); return { messageId: msg.id }`.

### D4a — prompt-before-initialize guard (W1)
The bridge captures `cwd/provider/model/maxTokens` only when `initialize` passes through. If `session/prompt` arrives BEFORE `initialize` (misbehaving client / test harness), the resolver has no `agentOptions` → `create/resume` would reject opaquely. The resolver SHALL throw a clear `initialize required before session/prompt` error when no initialize params are captured. (The stock server side-steps this by seeding construction-time defaults `cwd=process.cwd()`, `provider='deepseek-official'`; the bridge does NOT silently default — an unconfigured prompt is a client contract violation and must surface loudly.)

### D4b — torn/corrupt JSONL policy (W2, owner-approved: clean error, NO auto fresh-create)
If `persistence.inspect`/`ctx.agents.resume` throws on a torn/corrupt log, the bridge SHALL surface it as a clean `session/prompt` JSON-RPC error and SHALL NOT fall back to a fresh `create`. Rationale: a silent fresh-create over a persisted-but-corrupt log would re-introduce exactly the id-collision/history-loss class this change fixes (and mask real corruption). The user sees a clear error and can act (retry / inspect / delete the session).

**EMPIRICAL FINDING (verified against persistence-jsonl rc.8 in the spike):** dsh's JSONL loader is corruption-TOLERANT at every layer the resolver touches, so this throw branch is **unreachable via the persistence-jsonl service in practice**:
- A corrupt **header** line → `parseHeaderMeta` returns `undefined` → the session is silently EXCLUDED from `list()` → the resolver never sees it and takes the `create` path (dsh's own recovery, not our fresh-create-over-corrupt).
- A corrupt **body** record → `readPrefix`/`scanLog` RECOVER by truncating to the last committed byte (`tornMarker.truncateTo`); `inspect`/`resume` succeed with the clean prefix. A mid-log bad record only throws if a *later decoded* record carries `turn/end`, but the seq-gap after the corruption stops decoding before that — so no throw reaches the resolver.

Consequence: the guard remains as **correct defensive code** (if a future persistence backend DID throw from `inspect`/`resume`, we do not swallow it into a fresh-create), but it is covered at the **unit layer** (`session-lifecycle.test.ts` injects `inspectThrows`), NOT the runtime spike — the right layer for an unreachable-in-practice throw. The spike documents this finding inline instead of asserting an impossible error.

### D5 — cwd match guard (safety, from apiproxy)
apiproxy throws `SessionCwdConflict` if `inspected.meta.cwd !== cwd` before resuming. The bridge SHALL mirror this: if the persisted session's `meta.cwd` differs from the initialized `cwd`, reject with a clear error rather than resume into the wrong workspace. (dsh binds cwd process-globally; a mismatched resume is a real hazard.)

### D6 — Concurrency: one creation per id in flight
Mirror the stock server's `sessionCreations` dedup (server.ts:207): the bridge keeps an in-flight `Map<sessionId, Promise<AgentHandle>>` so two fast `session/prompt` on the same id share one resolve, not two racing create/resume (which would double-register → conflict).

## KnowMe side (separate repo, minimal)
- `dsh-runner.ts` KEEPS `dshSessionId = spec.resume?.providerSessionId ?? spec.sessionId ?? spec.taskId` — reusing the pinned id is now CORRECT (bridge resumes it). The per-turn-fresh-id workaround (option A) is NOT applied.
- `onSessionPin` KEEPS pinning `providerSessionId: dshSessionId` — it is now a genuinely resumable pointer.
- No other KnowMe change required for the fix.

## Risks / boundaries

- **verify:contract must be extended** to pin the new dependencies (`ctx.agents.resume` signature, `sessionPersistence.list/inspect`, `agent.followup`, `createUserMessage`) so a dsh bump that changes them breaks CI first. This is the primary guard against the dev-preview churn risk.
- **The embedded stock server still handles initialize/shutdown** — we do NOT remove it; the bridge-composition "delegate everything non-knowme to the server" invariant narrows to "delegate everything non-knowme EXCEPT session/prompt."
- **subagent.* / session.event / session.status notifications** still flow from the resumed/created agent over the same transport (agent handles emit them regardless of create vs resume) — no change to the notification path or KnowMe's demux.
- **Torn/corrupt JSONL (W2, resolved)**: clean error, NO auto fresh-create — see D4b.
- **NIT — subagent-owned persisted session**: apiproxy checks `hasSubagentOwner(inspected.meta)` before resume (api-proxy.ts:1588). KnowMe sessionIds are UUIDs, so colliding with a dsh subagent-child id is negligible; the bridge trusts caller-supplied sessionIds are top-level (documented assumption, not a runtime guard).
- **NIT — agentPreset in persisted header**: knowme-sdk composes no preset, so persisted headers always have `agentPreset === undefined`. If a future deployment adds a roster, a `setup:undefined` resume would rebuild a session the model can't act on. Guard: if `inspected.meta.agentPreset !== undefined`, reject with a clear `preset-resume-unsupported` error until a bridge preset story exists.

## Migration Plan
1. `src/session-lifecycle.ts` (new): pure-ish `resolvePromptAgent(deps, {sessionId, cwd, agentOptions})` implementing D4/D4a/D4b/D5/D6 (+ NIT guards) three-state + dedup, with `SessionId` wrapping. Unit-tested with fake agents/sessions/persistence.
2. `src/index.ts`: capture initialize params (D3); route `session/prompt` to the resolver + `followup` delivery; keep initialize/shutdown delegated. `inject` += `['sessions','sessionPersistence']`.
3. `verify:contract`: pin the new API surface (incl. `SessionId` factory export).
4. `verify:spike`: extend the real-dsh two-turn driver to assert turn-2 RESUMES (no collision) and sees turn-1 history from the JSONL (T4, PASSING: 38→42 events appended across a process recycle). Torn-log (W2) is NOT spiked — dsh recovers corrupt logs silently at every reachable layer (see D4b finding); covered at the unit layer instead.
5. KnowMe: confirm no runner change; real dsh CDP multi-turn 续聊 from the app.

## Open Questions
- None remaining. `sessionPersistence` surface confirmed (D4); torn-log policy decided (D4b); SessionId branding pinned (D4/W5).
