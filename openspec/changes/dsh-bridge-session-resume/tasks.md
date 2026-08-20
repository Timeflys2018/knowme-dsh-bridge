# Tasks — dsh-bridge-session-resume

## 1. Session-lifecycle resolver (TDD, pure-ish) — all Momus WARN/NIT folded in as cases

- [ ] 1.1 `src/session-lifecycle.test.ts`: RED — `resolvePromptAgent(deps, {sessionId, cwd, agentOptions})` with injected fakes for `agents.get/create/resume`, `sessions.get`, `sessionPersistence.list/inspect`. Cases: attached→reuse (no create/resume, live-check EVERY call = W4); disk-log→resume(resumeSessionId,agentOptions); none→create({sessionId,meta:{cwd},agentOptions}); **W5** SessionId branding (create/resume/get receive branded SessionId not raw string); **D5** cwd mismatch→throws cwd-conflict; **W3** concurrent same-id→single create/resume (dedup promise), both get messageId; **W1** missing agentOptions (prompt-before-init)→throws initialize-required; **W2** inspect/resume throws (torn log)→clean error, NO fresh-create; **NIT** persisted meta.agentPreset defined→throws preset-resume-unsupported.
- [ ] 1.2 `src/session-lifecycle.ts`: implement the three-state gate + in-flight `Map<sessionId,Promise<AgentHandle>>` dedup + SessionId wrapping + W1/W2/W4/D5/NIT guards. No preset/setup. GREEN.

## 2. Prompt delivery + wiring in index.ts

- [ ] 2.1 `src/index.ts`: capture `initialize` params (cwd/provider/model/maxTokens) in the request router BEFORE forwarding initialize to the official server (bridge-local state).
- [ ] 2.2 `src/index.ts`: route `session/prompt` to the resolver → `createUserMessage({content:contentBlocks,source:{kind:'user'}})` → `agent.followup(msg)` → return `{messageId: msg.id}`. Keep `initialize`/`shutdown`/other delegated to `server.handleRequest`.
- [ ] 2.3 `src/index.ts`: `inject = ['agents','sessions','sessionPersistence']`; wire the two new services into the resolver deps.

## 3. Contract pin

- [ ] 3.1 `verify/verify-contract.mjs`: pin `ctx.agents.resume` (fn + ResumeAgentOptions.resumeSessionId), `ctx.sessions.get`, `sessionPersistence.list`+`inspect`, `createUserMessage`, `agent.followup`, **`SessionId` factory export from `@deepseek-ai/dsh-session`** (W5). Fail loudly on drift.
- [ ] 3.2 `pnpm verify:contract` exits 0 against pinned rc.8.

## 4. Real-dsh spike (multi-turn resume from JSONL)

- [ ] 4.1 `verify/spike/driver.mjs`: extend the two-turn driver — turn 1 create+persist; turn 2 (same sessionId, after disposing the live agent to force detached) MUST resume (no collision) and the model MUST see turn-1 context. Assert no id-collision error + prior-context recall.
- [x] 4.2 torn/corrupt-log (W2): FINDING (verified against persistence-jsonl rc.8) — dsh recovers corrupt logs silently at every layer the resolver touches (corrupt header → excluded from `list()`; corrupt body → truncated to committed prefix), so the "inspect throws" branch is UNREACHABLE via this service. Guard kept as defensive code; covered at the unit layer (`inspectThrows` injection); spike documents the finding inline instead of asserting an impossible error.

## 5. KnowMe side (separate repo, minimal — verify no change needed)

- [ ] 5.1 Confirm `dsh-runner.ts` keeps `dshSessionId = spec.resume?.providerSessionId ?? spec.sessionId ?? spec.taskId` (reuse pinned id is now correct) — NO per-turn-fresh-id workaround.
- [ ] 5.2 Confirm `onSessionPin` keeps pinning providerSessionId (now genuinely resumable).
- [ ] 5.3 Real dsh CDP from the KnowMe app: 3-turn 续聊 on ONE dsh session across process recycles — each turn renders, turn N sees turns 1..N-1 context, no collision error, transcript persists.

## 6. Review + close

- [ ] 6.1 4-slot artifact review (ADDED-vs-MODIFIED correctness, resolver contract completeness, cwd-conflict + torn-log edge coverage, contract-pin completeness).
- [ ] 6.2 Oracle post-impl review of the resolver + index wiring.
- [ ] 6.3 `openspec validate dsh-bridge-session-resume --strict`.
- [ ] 6.4 version bump + archive + commit (bridge repo) — on explicit authorization.
