# Verification / challenge layer

Independently
challenging a conclusion before it can be presented as resolved, for
FindCallers and FindCallees.

## Where it lives

- `src/verification/policy.ts` — `decideVerification()`: deterministic
  not-required / recommended / required decision.
- `src/verification/challenge.ts` — the independent mechanisms themselves.
- `src/verification/compare.ts` — `compareEvidence()`: CONFIRMED /
  CONTRADICTED / PARTIALLY_CONFIRMED / CONFLICTING / UNVERIFIED.
- `src/verification/verify.ts` — orchestrates the three above into
  `VerifiedPlanOutcome` (`verification` + `finalStatus`).
- Wired into `Engine.findCallers()` / `Engine.findCallees()`. Nothing else
  changed; every other task type still returns a plain `PlanOutcome`.

## Policy: when does a challenge run?

`decideVerification()` escalates only on named, counted signals — never on
a schedule and never unconditionally:

**required** (any one of):
- evidence sources already disagree (`store.conflicts().length > 0`)
- this query's own unresolved sites include dynamic dispatch or reflection
- `risk.criticalSites` at/above `requiredRiskThreshold` (default 1)
- criticality is `"high"` and residual risk is nonzero

**recommended** (any one of, when not already required):
- unresolved sites at/above `unresolvedSiteFloor` (default 1)
- coverage was relevant to the query and wasn't ingested
- the weakest analysis that contributed evidence is HEURISTIC or OBSERVATIONAL
- criticality is `"high"`

By default `recommended` also runs the challenge
(`autoVerifyRecommended: true`); pass `{ autoVerifyRecommended: false }` to
only run it on `required`. Every decision carries `reasons: string[]` — this
is a transparent, deterministic heuristic, not a learned or calibrated one,
matching the rest of the planner.

**Known scoping gap, not fixed here:** `FindCallers`'s own `risk.criticalSites`
is scoped to the queried symbol's own unresolved sites (see
`tasks/find-callers.ts`), so `decideVerification` reacts to *this query's*
risk. `FindCallees`'s `risk.criticalSites` (`tasks/find-callees.ts`, via
`riskFromUnknowns`) is scoped to the whole repository's dynamic-dispatch/
reflection count, not the queried symbol's. That means on a repository with
any dynamic dispatch anywhere, FindCallees queries will tend to read
`residualRiskSites > 0` and trigger `required` more often than is really
warranted for that specific query. This is a pre-existing property of
`find-callees.ts`'s risk formula (not introduced by this change, and not
touched here per "do not modify unrelated working functionality") — worth
narrowing `find-callees.ts`'s risk formula to match `find-callers.ts`'s
target-scoped approach in a follow-up, not silently worked around inside
the verification layer.

## Independence

**FindCallers challenge** reuses `languageServiceOracle` from
`groundtruth/oracles.ts` (already existed, already documented there as
importing nothing from the engine's own resolution code) —
`ts.LanguageService#findReferences`.

**FindCallees challenge** is new: an independent AST walk (not reusing
`acquisition/calls.ts`) over the queried declaration's body, resolving each
call/`new` expression's callee identifier via
`ts.LanguageService#getDefinitionAtPosition` (go-to-definition) — a
different TS API surface than the checker-driven
`checker.getSymbolAtLocation` the primary path uses.

**Boundary:** both the primary path and the challenge ultimately
sit on the TypeScript compiler — there is no second, unrelated static
analyzer wired in (for example tree-sitter has not been added). What's independent is the *implementation
path inside the compiler* (checker-driven symbol resolution vs.
language-service find-references / go-to-definition, two different
algorithms TypeScript itself implements and maintains), not the toolchain.
This is stated plainly rather than described as fully independent.

## A real bug the challenge caught in itself

Running this against real repositories (see below) surfaced a genuine bug:
`challengeFindCallees`'s AST walk originally only visited
`ts.CallExpression`, so `new FastRunner()` (a `NewExpression`) was invisible
to it. Every constructor call showed up as "only in primary," which
`compareEvidence` correctly reported as `CONFLICTING` — the classification
logic worked exactly as designed, but it was correctly flagging a real gap
in the challenge's own coverage, not a defect in the primary path. Fixed in
`challenge.ts` by treating `NewExpression` the same as `CallExpression`; see
`tests/verification.test.ts`'s `[FindCallees independence]` regression test.

## Result classification

`VerifiedPlanOutcome.finalStatus`:

| finalStatus | when |
|---|---|
| `CONFLICTING` | primary verdict is `CONFLICTING_EVIDENCE`, **or** the challenge's comparison is `CONTRADICTED`/`CONFLICTING` — checked first, so a clean challenge can never override a primary conflict, and a conflicting challenge can never be waved through by a clean primary verdict |
| `HIGH_RESIDUAL_RISK` | primary verdict is `HIGH_RESIDUAL_RISK` |
| `INSUFFICIENT_EVIDENCE` | primary verdict is `INSUFFICIENT_EVIDENCE` or `ANALYSIS_UNSUPPORTED` |
| `RESOLVED_WITH_VERIFICATION` | primary verdict is `SUFFICIENT` and the challenge ran and corroborated it (`CONFIRMED`/`PARTIALLY_CONFIRMED`) |
| `RESOLVED` | primary verdict is `SUFFICIENT` and verification wasn't required |
| `PARTIAL` | primary verdict is `SUFFICIENT` but verification ran without a decisive comparison (both empty, or the challenge mechanism itself was unavailable) |

## Running it yourself

```
npx tsx src/benchmark/verification-benchmark.ts
```

Results from running it against the fixture repositories are in `docs/verification-report.md`.
