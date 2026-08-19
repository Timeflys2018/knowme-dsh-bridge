# RED Proof — 2026-08-19

Cross-check per test-methodology §9.2 (a regression test that has not failed
on un-fixed code proves nothing):

```
$ git stash push -- src/          # revert implementation only, keep tests
$ pnpm test
  Test Files  5 failed (5)
  Tests       46 failed | 2 passed (48)     # RED — tests genuinely lock behavior

$ git stash pop && pnpm build
$ pnpm test
  Test Files  5 passed (5)
  Tests       48 passed (48)                # GREEN
```

Spike evidence (real dsh rc.7 child process over real stdio, keyless
llm-replay): T1 protocol/lifecycle, T2 same-process model switch
(flash → pro asserted via persisted request/header), T3 approval +
question round-trip through the production call shape, T3b shutdown-while-
parked (ask settles 'cancelled', durable approval/decided audit pair).

T3b root-cause note (Oracle consultation): the initial fixture asked without
the turn's abort signal, so the settle continuation appended approval/decided
onto a detached session and persistence never saw it. Fix was fixture-side
(carry the agent/pre-step turn signal, mirroring the tool executor's
exec.signal); no bridge change. The bridge-side 250ms settle-wait added
during debugging was removed after proving unnecessary (T3b green without it)
— dead code eliminated, not papered over.
