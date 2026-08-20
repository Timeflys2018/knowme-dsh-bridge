# @knowme/dsh-bridge

> **Status**: implemented against pinned dsh `0.1.0-rc.8` (see "Version discipline"). If a future dsh
> stable release adds these methods to the official SDK surface, prefer the official methods and retire
> this bridge.
> **License**: MIT · **Visibility**: private (owner/developer use only)

A **B3-small wire-bridge** [cordis](https://github.com/cordiverse/cordis) plugin for
[DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness). It runs **inside the dsh
process**, owns the single stdio JSON-RPC transport, composes the official
`HarnessSdkJsonRpcServer` over it, and adds—on the same newline-delimited channel—the few
**interaction-control methods** the official stdio surface omits, so an
**out-of-process host** (KnowMe) can drive dsh without the "restart the runtime to change anything"
limitation.

## Why this exists

The official dsh SDK stdio surface intentionally exposes only 5 methods (`initialize`,
`session/prompt`, `shutdown` + `session.event`/`session.status`/`subagent.*` notifications). The dsh
**runtime already supports** switching models mid-session (adapter routing table + per-step model
resolution) and answering approvals/questions — the dsh **web `/api`** surface exposes these, but the
**stdio SDK does not wire them**. This plugin adds them back over stdio, keeping the host out-of-process.

It does **not** bridge information that a consumer can re-derive from the raw `session.event` stream
(tokens, footer metrics, transcript, todos) — that stays the host's job. Bridging the smallest possible
surface keeps the maintenance burden low when dsh (currently developer-preview) makes breaking changes.

## Methods added (namespaced `knowme/` to avoid clashing with the official 5)

| Method | Params | Returns | Bridges to (dsh host service) |
|---|---|---|---|
| `knowme/selectModel` | `{ sessionId, provider, model, reasoningEffort? }` | `{ selected: { provider, model, reasoningEffort? } }` | `llm.resolveCallConfig` + `installModelSelection` (next assembled step; no process restart) |
| `knowme/approval-respond` | `{ sessionId, approvalId, outcome: 'allowed-once' \| 'rejected' }` | `{ resolved: true }` | settles the parked `approval/request` waterfall promise |
| `knowme/question-respond` | `{ sessionId, requestId, answers: [{ id, selected: string[], custom? }] }` | `{ resolved: true }` | resolves the user-questions provider ask (the bridge IS the provider) |
| _(notification)_ `knowme/approval-requested` | `{ sessionId, approvalId, toolName, callId?, reason? }` | — | pushed from the `approval/request` waterfall |
| _(notification)_ `knowme/question-requested` | `{ sessionId, requestId, questions }` | — | pushed from the provider's `ask()` |

### Error taxonomy & degradation

Errors ride as JSON-RPC error messages; the kebab-case names are the stable contract:

- `session-not-found` — selectModel named a session with no live agent.
- `model-unavailable` — `llm.resolveCallConfig` rejected the provider/model/effort pair (unknown
  provider, unsupported effort). Note dsh's model catalog is advisory: an unknown model id may pass
  resolve and surface as an LLM-call error on the session's next step (same as the official web surface).
- `llm-unavailable` — no `llm` service composed (selectModel degraded).
- `approval-not-found` — no parked approval for that id: unknown, already settled (abort/teardown/prior
  respond won the race — treat a retried respond as idempotent success), or sessionId mismatch
  (deliberately the same error, so a wrong session cannot probe).
- `question-not-found` — same collapse for questions.
- `user-questions-unavailable` — no `userQuestions` service, or the provider registration collided
  (another UI registered first).

Approval degrades **passively**: the bridge never calls `ctx.get('approval')` — it only listens to the
waterfall, so an absent service simply means no asks ever park.

### Shutdown contract

On `shutdown` (or plugin teardown), parked approvals settle `'cancelled'` and parked questions reject
**silently** — no cancellation notification is pushed. The `approval/decided` audit events in the
session log are the durable record. A client MUST treat "connection drop / process exit" as "all
in-flight approvals cancelled and all open questions aborted".

**Durability is a caller-side contract** (verified by the spike): an ask that carries the active
turn's abort signal — as every production caller does (the tool executor passes `exec.signal`) —
settles during the shutdown abort dispatch while its session is still attached, so its audit pair
persists. A bare out-of-turn ask without a signal is NOT covered: dsh drops the observer dispatch
for appends onto a detached session, so its `approval/decided` never reaches disk. The bridge
neither can nor should rescue that shape (upstream documents the ask as turn-enclosed).

## Install (into a dsh deployment)

This plugin depends on dsh runtime packages as **peerDependencies** (not workspace). The rc line lives
under npm's `next` dist-tag (`latest` still points at older rcs), so pin explicitly, e.g.
`pnpm add @deepseek-ai/dsh-sdk-jsonrpc-server@0.1.0-rc.8 @knowme/dsh-bridge@<ver>`, then mount the
bridge **in place of** `@deepseek-ai/dsh-sdk-jsonrpc-server` in your `cordis.yml` — the bridge owns the
single stdio transport and routes the official 5 methods to the official server class itself. Compose
`llm` / `@deepseek-ai/dsh-user-approval` / `@deepseek-ai/dsh-user-questions` **before** the bridge row
(soft-probed at apply time). See [`cordis.example.yml`](./cordis.example.yml).

## Version discipline

Implemented and verified against dsh `0.1.0-rc.8` (developer preview). `verify:contract` pins the
version line plus every runtime surface the bridge reads, so dsh churn fails CI before the bridge
silently breaks. The standing rule from the design blueprint still applies: if an official stable SDK
surface adds `selectModel`/approval-respond, prefer it and retire this bridge (B1 wins). See
`zhiwo/DailyWork/planning/exploration/2026-08-18-dsh-runtime-plugin-integration-plan.md` §2 (Stage 1).

## Contract discipline

`pnpm verify:contract` pins the dsh version + the runtime service interfaces this bridge depends on, so a
dsh breaking change fails CI **before** the bridge silently breaks. (Borrowed from the dsh-TUI project's
`verify:contract` / `verify:patch-surface` gates.) `pnpm verify:spike` drives a real composed dsh
runtime (keyless) over real stdio through every bridge method.
