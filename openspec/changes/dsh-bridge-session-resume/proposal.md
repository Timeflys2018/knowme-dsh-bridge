# dsh-bridge-session-resume

## Why

Continuous chat (续聊) on a dsh session fails with a real dsh error and the transcript appears cleared:

```
session "<id>" already has a persisted log on disk that does not match this live session (id collision)
```

Root cause (traced, ground-truth): the bridge delegates `session/prompt` to the embedded `HarnessSdkJsonRpcServer`, whose `getOrCreateSession(id)` ALWAYS calls `ctx.agents.create({sessionId})` — it never resumes. dsh persists each session to `~/.dsh/sessions/<cwd>/<id>/session.jsonl.zstd`; `create(sameId)` refuses to materialize over an existing on-disk log → throws the id-collision error. So the SECOND turn of any session that lands on a fresh/recycled process (the resident-pool reality on the KnowMe side) collides. The full history lives in that JSONL (real, resumable) — it is not lost, but the create-only path can never reopen it.

The dsh SDK stdio server has no resume wire (its request switch handles only `initialize | session/prompt | shutdown`). dsh's OWN reference host (apiproxy) resolves this with a three-state create-vs-resume gate at the host layer — NOT inside the SDK server.

## What Changes

The bridge — which is already the sole stdio transport owner and already routes every request — takes over the `session/prompt` session lifecycle (mirroring apiproxy's three-state gate) instead of blindly delegating it to the embedded server:

1. Capture `initialize` params (`cwd`, `provider`, `model`, `maxTokens`) as they pass through the bridge's request router (they are private in the embedded server; the bridge needs them to construct/resume agents itself).
2. On `session/prompt`, resolve the session by three states (mirroring apiproxy):
   - **attached** (`ctx.sessions.get(id)` live) → reuse the live agent.
   - **detached-on-disk** (`sessionPersistence.list()/inspect(id)` shows a persisted log) → `ctx.agents.resume({resumeSessionId: id, agentOptions})` → loads the JSONL history → true continuity.
   - **new** → `ctx.agents.create({sessionId: id, meta:{cwd}, agentOptions})`.
   Then deliver the prompt via `agent.followup(createUserMessage(...))` and return `{messageId}`, exactly as the stock server's `prompt()` does.
3. `initialize` and `shutdown` continue to delegate to the embedded server (adapter mount, provider/model binding, shutdown drain unchanged). Only `session/prompt` gains the resume gate.

KnowMe side (separate repo): the dsh runner KEEPS reusing `spec.resume?.providerSessionId` (the pinned dsh sessionId) — that is now correct because the bridge can resume it. No KnowMe runner change is required for the fix itself; the earlier per-turn-fresh-id workaround is NOT applied.

## Impact

- Affected specs: `bridge-composition` (MODIFIED: request routing no longer blindly delegates non-`knowme/*` to the server — `session/prompt` gets a resume gate; ADDED: session lifecycle resume-vs-create contract).
- Affected code: `src/index.ts` (capture initialize params + route session/prompt to a new resolver), `src/bridge.ts` or a new `src/session-lifecycle.ts` (the three-state resolver + prompt delivery), `inject` += `['sessions','sessionPersistence']`.
- `verify:contract` extended: pin `ctx.agents.resume`, `ctx.sessions.get`, `sessionPersistence.list/inspect`, `agent.followup`, `createUserMessage` — the public dsh APIs this now depends on, so dsh churn breaks CI first.
- NO fork of dsh source. All logic in the bridge repo, against dsh's stable public service APIs.
- Version bump + real-dsh spike (multi-turn 续聊 continuity from JSONL, no collision).
