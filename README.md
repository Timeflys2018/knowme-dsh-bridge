# @knowme/dsh-bridge

> **Status**: scaffold / blueprint — implementation gated on DeepSeek Harness stable release (see below).
> **License**: MIT · **Visibility**: private (owner/developer use only)

A **B3-small wire-bridge** [cordis](https://github.com/cordiverse/cordis) plugin for
[DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness). It runs **inside the dsh
process** and exposes—over the same newline-delimited stdio JSON-RPC channel—the few
**interaction-control methods** the official `@deepseek-ai/dsh-sdk-jsonrpc-server` surface omits, so an
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

| Method | Params | Bridges to (dsh host service) |
|---|---|---|
| `knowme/selectModel` | `{ sessionId, provider, model, reasoningEffort? }` | host session model selection (next assembled step; no process restart) |
| `knowme/approval-respond` | `{ sessionId, approvalId, outcome: 'allowed-once' \| 'rejected' }` | resolves the approval service's parked promise |
| `knowme/question-respond` | `{ sessionId, requestId, answers }` | resolves the user-questions provider |
| _(notification)_ `knowme/approval-requested` | `{ sessionId, approvalId, toolName, callId?, reason? }` | pushed from `ctx.on('approval/request')` |
| _(notification)_ `knowme/question-requested` | `{ sessionId, requestId, questions }` | pushed from the user-questions provider |

## Install (into a dsh deployment)

This plugin depends on dsh runtime packages as **peerDependencies** (not workspace) — install alongside a
published dsh version, then add it to your `cordis.yml`. See [`cordis.example.yml`](./cordis.example.yml).

## Gating

Implementation is deliberately deferred until dsh ships a **stable release**. At that point, first check
whether the official SDK surface already added `selectModel`/approval-respond — if so, this plugin may be
unnecessary (use the official methods). See the KnowMe design blueprint:
`zhiwo/DailyWork/planning/exploration/2026-08-18-dsh-runtime-plugin-integration-plan.md` §2 (Stage 1).

## Contract discipline

`pnpm verify:contract` pins the dsh version + the runtime service interfaces this bridge depends on, so a
dsh breaking change fails CI **before** the bridge silently breaks. (Borrowed from the dsh-TUI project's
`verify:contract` / `verify:patch-surface` gates.)
