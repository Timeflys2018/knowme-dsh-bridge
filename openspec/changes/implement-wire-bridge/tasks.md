# Tasks — implement-wire-bridge

> TDD discipline: every implementation task writes/updates its failing test first, then greens it. Tick `- [x]` immediately upon completion, never in batches.
> Post-review note: findings from the 4-slot review round 1 are folded in (atomic delete-as-test settle, teardown ordering, DUPLICATE_PROVIDER catchability, T3.b shutdown-while-parked, contract pins incl. official switch-case list).

## Phase 0 — contract & deps groundwork

- [x] 0.1 Record the peerDep decision: npm availability of `@deepseek-ai/dsh-sdk-jsonrpc-server`, `@deepseek-ai/dsh-user-approval`, `@deepseek-ai/dsh-user-questions`, `@deepseek-ai/dsh-llm` on the `0.1.0-rc.7` line is review-CONFIRMED (dist-tag `next`; `latest` points at older rcs so installs must resolve the explicit range); keep existing `dsh-agent`/`dsh-session`/`dsh-sdk-protocol` peers. defines: final peerDep list. uses: design D5.3.
- [x] 0.2 Update `src/contract.ts`: fix `QuestionRespondParams.answers` to full answer items (`{id, selected, custom?}[]`); drop `'sessions'` from `REQUIRED_SERVICES`; add error-name constants (`session-not-found`, `model-unavailable`, `llm-unavailable`, `approval-not-found`, `question-not-found`, `user-questions-unavailable`). Hard check: `grep -c "'sessions'" src/contract.ts` → 0 after edit. defines: contract surface. uses: design D5.
- [x] 0.3 Update `package.json` peerDeps per 0.1 (green immediately). Keep `tests/bridge.test.ts` routing assertions intact — the scaffold tests never locked the old answers shape (nothing to un-red); new shape assertions arrive red-first with Phase 1. defines: green deps + test baseline. uses: 0.1, 0.2.

## Phase 1 — bridge state machines (pure, unit-tested)

- [x] 1.1 Write failing unit tests for the approval park: id-recovery scan (fresh ask; decided pair; claimed exclusion; callId symmetry; callId-less ask — documented latent LIFO limitation; no-ask-delegation), respond settle via delete-as-test (idempotent first-settle-wins: respond vs abort vs teardown race matrix), abort settle-cancelled with no respond round-trip, teardown parity settling 'cancelled'. uses: contract 0.2, design D3.
- [x] 1.2 Write failing unit tests for the question park: provider ask → notification + park; respond resolve returning `{resolved: true}`; malformed answers; unknown requestId; abort reject; teardown reject-all; DUPLICATE_PROVIDER caught at the registerProvider call site → warning + `user-questions-unavailable` degradation (mount two providers back-to-back to pin catchability). uses: design D4.
- [x] 1.3 Write failing unit tests for selectModel: ref install via captured `agent/request` + `system-prompt/assemble` handlers (stub `next`; assert undefined-current is a pure pass-through), memoized second switch (no re-install), error taxonomy incl. unknown provider → model-unavailable. uses: design D2.
- [x] 1.4 Implement the three bodies in `src/bridge.ts` against dsh rc.7 service shapes (branded `ReasoningEffortId` cast at the boundary is explicit, not `as any`); all Phase-1 tests green; keep typecheck clean. defines: bridge logic. uses: 1.1-1.3 tests.

## Phase 2 — plugin composition & lifecycle

- [x] 2.1 Write failing unit tests for `apply()`: single transport constructed, official server constructed over it, prefix routing (`knowme/*` vs passthrough), `Config` schema (`maxTokensAsSuccess` default false) passthrough to the official constructor, shutdown→disposeAndExit choreography (injected input/output/exit hooks), park-teardown effects registered AFTER the transport effect (disposed first). uses: design D1.
- [x] 2.2 Implement `apply()` + `Config` in `src/index.ts` (transport owner + router + lifecycle + teardown ordering); Phase-2 tests green; `pnpm typecheck` + `pnpm test` clean. defines: plugin entry. uses: 2.1 tests, bridge 1.4.
- [x] 2.3 Update `cordis.example.yml` to the single-owner shape (bridge IN PLACE OF the official server entry) and `README.md` (methods table with corrected answers shape + return values, degradation table incl. passive approval degradation, shutdown-cancels-parked contract, gating note updated to "implemented against pinned rc.7", install note about the `next` dist-tag). uses: design D1/D5.

## Phase 3 — contract snapshot & spike (real verification)

- [x] 3.1 Update `verify/verify-contract.mjs`: pin the surfaces actually read — agents-by-SessionId, `llm.resolveCallConfig`, `approval/request` waterfall + the audit-event DATA shapes (`{id, toolName, callId?, reason?}` / `{id, outcome}`), `userQuestions.registerProvider`, `installModelSelection` + `HarnessSdkJsonRpcServer` exports, the tool-executor call shape still including `callId`, and the official `handleRequest` switch case list (exactly initialize/session-prompt/shutdown — catches future official `knowme/*` shadowing); `pnpm verify:contract` green. uses: design D1/D3/D5.
- [x] 3.2 Build `verify/spike/`: cordis.yml composition + keyless LLM base (replay from local checkout, else spike-local mock adapter) + in-process trigger fixture (production call shape, field-for-field) + driver script; add `verify:spike` npm script to package.json; deps installed gitignored. defines: spike harness. uses: design D6.
- [x] 3.3 T1 protocol/lifecycle spike passes: initialize, official prompt/event flow, knowme error taxonomy, shutdown exit 0. uses: 3.2.
- [x] 3.4 T2 selectModel spike passes: live-session switch lands on next step in the same process (assert via session events). uses: 3.2.
- [x] 3.5 T3 + T3.b approval/question round-trip spike passes: notification → respond → settle; abort path without respond; shutdown-while-parked settles cancelled + audit event in log + exit 0. uses: 3.2, trigger fixture.
- [x] 3.6 RED proof: `git stash` implementation revert → Phase-1/2 tests red → pop → green; record output in the change dir (evidence file). uses: all tests.

## Phase 4 — review & close

- [x] 4.1 Review round 1 (4-slot parallel) COMPLETE — findings folded into artifacts; final integration pass over all findings confirmed mutually consistent; PEF summary: 0 blocker / latent callId-less swap + knowme-shadowing → contract pins + README / DUPLICATE_PROVIDER collision → degradation path. Implementation review pass still owed after Phase 1-3.
- [x] 4.2 Full local gate: typecheck + test + verify:contract + spike T1-T3b all green in one run; update tasks/proposal if scope shifted.
- [ ] 4.3 Commit (logical grouping), update zhiwo handoff pointer (bridge no longer "bodies gated"; note pinned rc.7 + owner gate-lift decision).
