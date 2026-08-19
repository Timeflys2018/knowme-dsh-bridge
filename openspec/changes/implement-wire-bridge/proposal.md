# Proposal — implement-wire-bridge

## Why

`@knowme/dsh-bridge` is a scaffold: routing contract locked by tests, but every method body throws `not implemented (gated on dsh stable)`. The gate existed to avoid chasing developer-preview churn. On 2026-08-19 the owner explicitly lifted the schedule gate ("自主推进落地" — autonomous implementation now), accepting rc-pinning risk in exchange for having the B3-small accelerator ready. Risk mitigation stays: pinned contract snapshot (`verify:contract`), minimal bridge surface (3 methods + 2 notifications), and the standing rule that an official stable SDK surface supersedes this bridge (B1 wins, bridge retires).

Ground-truth reading of dsh rc.7 (see design.md anchors) confirmed every capability the bridge needs already exists in-process; only the stdio wiring is missing.

## What Changes

- **Single-transport composition**: the bridge plugin becomes the sole transport owner, directly composing the official `HarnessSdkJsonRpcServer` class; one request handler routes `knowme/*` to the bridge and everything else to the official server. (The scaffold's `cordis.example.yml` implied two sibling plugins each holding a transport — mechanically impossible: `JsonRpcLineTransport.onRequest` is replace-semantics and stdin cannot be read twice.)
- **Implement 3 methods**: `knowme/selectModel` (per-session model switch, no process restart, via `installModelSelection`), `knowme/approval-respond` (settle a parked approval promise intercepted from the `approval/request` waterfall), `knowme/question-respond` (settle a parked user-question promise; the bridge registers itself as the `userQuestions` provider).
- **Push 2 notifications**: `knowme/approval-requested`, `knowme/question-requested`.
- **Contract corrections discovered by ground truth**: question-respond `answers` shape upgraded from `string[][]` to full `AskUserQuestionAnswerItem[]` (`{id, selected, custom?}` — the scaffold shape was lossy: no question-id mapping, no custom text); `REQUIRED_SERVICES` drops `sessions` (agent lookup goes through the `agents` registry keyed by SessionId); peerDeps add `dsh-sdk-jsonrpc-server`, `dsh-user-approval`, `dsh-user-questions`, `dsh-llm`.
- **Service-dependency policy**: hard-inject `agents` only (mirrors the official server); `llm`/`approval`/`userQuestions` soft-probed — a missing service degrades its own method to a clear JSON-RPC error instead of failing plugin load.
- **Real-verification spike**: a keyless stdio harness (`verify/spike/`) that boots a composed dsh runtime (official server + bridge + approval + user-questions + a replay/mock LLM) as a real child process and drives it over real stdio.

## Capabilities

### New Capabilities
- `wire-bridge-methods`: the three `knowme/*` interaction-control methods and two notifications this bridge adds over the stdio JSON-RPC channel — param/result shapes, error taxonomy, and per-method degradation when an optional runtime service is absent.
- `bridge-composition`: how the bridge composes with the official SDK jsonrpc-server inside one dsh process — transport ownership, method routing, shutdown/exit lifecycle, and the cordis.yml shape a deployment must use.

### Modified Capabilities
<!-- none — this repo has no previously archived specs -->

## Impact

- Code: `src/{index,bridge,contract}.ts`, `tests/bridge.test.ts`, `verify/verify-contract.mjs`, `cordis.example.yml`, `package.json`, `verify/spike/**` (new), `README.md`.
- No impact on the dsh repo itself (bridge is read-only against its services).
- Explicit non-goals: KnowMe-side `DshRunner` (lives in zhiwo), L2/L3 plugin platform, npm publishing (repo stays private), and no re-litigation of the B1-vs-B3 decision — this change implements B3-small exactly as scoped in the zhiwo blueprint.
