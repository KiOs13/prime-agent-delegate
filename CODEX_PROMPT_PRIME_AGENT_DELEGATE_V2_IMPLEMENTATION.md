# PROMPT FOR CODEX IN ENGLISH

## Role

Act as the primary implementation owner for the evolution of the existing `prime-agent-delegate` skill.

Your task is to implement the architecture described in the attached `PRIME_AGENT_DELEGATE_V2_IMPLEMENTATION_PLAN.md` against the current `prime-agent-delegate` codebase, while preserving the existing working behavior and using the current implementation as the baseline rather than rewriting it from scratch.

Do not treat the plan as permission for broad refactoring. First study the existing implementation and prove how it currently works, then introduce the required changes incrementally.

## Primary objective

Evolve `prime-agent-delegate` into a **delegate-first orchestration layer** with the following architectural model:

1. Codex analyzes the user request and creates an implementation plan.
2. Codex decomposes the plan into logically complete Work Packages.
3. Delegation to Prime Agent is the default path for primary engineering work whenever Codex determines that Prime can perform useful work.
4. Only Codex decides whether a Work Package should be:
   - delegated to Prime Agent; or
   - executed directly by Codex because Prime cannot reasonably perform useful primary work.
5. Prime Agent performs investigation, draft implementation, tests, prototyping, and may use its own subagents.
6. Prime Agent output is always a candidate/draft result, never the final production authority.
7. Codex independently reviews Prime Agent output, reruns the required checks, and then:
   - accepts it;
   - makes minor fixes;
   - makes major fixes;
   - partially reuses it; or
   - rejects it and reimplements the Work Package itself.
8. A Prime Agent failure must never cause the user task to fail if Codex can continue. It must result in a Codex takeover.
9. Production deployment and final integration authority remain with Codex.
10. The system must minimize GPT-5.6 work by keeping Prime Agent responsible for as much primary engineering work as reasonably possible.

## Authoritative source material

Before changing code, study all available relevant material, especially:

- the current `prime-agent-delegate` implementation;
- `PRIME_AGENT_DELEGATE_V2_IMPLEMENTATION_PLAN.md`;
- `prime-agent-refine-hermes.txt`;
- the provided T053 run artifacts, if available;
- the current tests and existing runtime artifacts.

Treat the implementation plan as the target architecture, but validate every proposed code change against the actual current code before applying it.

Do not invent missing file names, functions, commands, technologies, paths, or interfaces. Locate the real implementation in the repository and work from confirmed evidence.

## Existing behavior that must be preserved

Before making changes, confirm the current behavior and document the baseline.

Preserve the existing working mechanisms unless the implementation plan explicitly requires changing them:

- isolated Git branch/worktree execution for Prime tasks;
- the existing Prime delegation flow;
- WSL preflight behavior;
- watchdog behavior;
- bounded infrastructure restarts;
- autonomous gates;
- existing `--require-change` and `--allow-change` behavior;
- compact event capture;
- `health.json`;
- `summary.json`;
- `audit-summary.json`;
- `events.jsonl`;
- Prime Agent execution with the current delegated `--no-session` model;
- Codex as the final reviewer and production authority.

The current watchdog test suite is part of the regression baseline. Run it before modifications and again after relevant changes. Preserve all existing passing behavior.

## Mandatory architectural invariants

Implement and document the following invariants.

### 1. Codex is the final authority

Codex owns:

- user intent;
- implementation planning;
- Work Package decomposition;
- the `DELEGATE` versus `CODEX_DIRECT` decision;
- independent review;
- final corrections;
- integration;
- production deployment.

Prime Agent must not gain commit/push/deploy authority through these changes.

### 2. Delegate-first is the default

For primary engineering Work Packages:

`DEFAULT = DELEGATE TO PRIME`

Codex may choose `CODEX_DIRECT` only when Codex determines that Prime Agent cannot reasonably perform useful primary work.

Historical Prime success/failure statistics must never independently disable delegation.

Statistics may improve **how** work is delegated, but must not decide **whether** Codex delegates.

### 3. Prefer degraded delegation before direct execution

Where appropriate, support the conceptual modes:

- `IMPLEMENT`
- `PROTOTYPE`
- `INVESTIGATE`

The intended preference is:

`IMPLEMENT → PROTOTYPE → INVESTIGATE → CODEX_DIRECT`

Codex remains responsible for choosing the mode.

### 4. Prime failure means Codex takeover

Prime failure is a delegation failure, not a user-task failure.

The architecture must preserve a clear path from any unusable Prime result to Codex takeover.

### 5. `summary.json` remains the normal Codex handoff

Codex must not need to read the full `events.jsonl` in the normal path.

The intended information-disclosure order is:

1. `summary.json`
2. `audit-summary.json` if needed
3. targeted extraction from `events.jsonl`
4. full `events.jsonl` only for exceptional forensic analysis

Do not introduce a design that routinely sends raw Prime trajectories to GPT-5.6.

## `.prime-delegate` corpus

Implement `.prime-delegate/` as an **evaluation/training corpus only**.

It is not project memory.

It is not runtime policy.

It must not be read by the normal launcher in order to decide how to execute the next user task.

Its purposes are:

- statistics;
- outcome tracking;
- incident evidence;
- regression evidence;
- Prime-value analysis;
- preparation of candidate trajectories/patterns for later Hermes Agent processing.

Prefer keeping `.prime-delegate/` out of project Git history without unnecessarily modifying tracked project files. Inspect the current repository behavior before selecting the safest exclusion mechanism.

The corpus must not dirty the delegated worktree or alter application behavior.

## Separate the two improvement loops

This separation is mandatory.

### A. `prime-agent-delegate` improvement

Problems owned by the delegate skill include, for example:

- CCR/task transport;
- prompt packaging;
- launcher behavior;
- WSL integration;
- watchdog behavior;
- restart logic;
- protocol parsing;
- summary generation;
- Git/worktree control;
- deterministic classification infrastructure.

These problems should follow:

`incident → confirmed reproducer → regression test → Codex fix → verification`

Do not send delegate-skill infrastructure bugs to Prime `/refine`.

### B. Prime Agent improvement

Behavioral patterns owned by Prime Agent may include:

- repeated scope expansion;
- poor or inefficient internal workflow;
- repeated misuse of subagents;
- recurring implementation mistakes;
- repeated successful reusable workflows;
- effective engineering patterns worth distilling.

The delegate skill may record and classify these patterns as `/refine` candidates, but it must not perform `/refine` itself.

## Hermes `/refine` boundary

`prime-agent-refine-hermes.txt` defines the separate refinement workflow.

Preserve this boundary:

- delegated Prime runs use `--no-session`;
- Hermes Agent later prepares selected delegated trajectories for Prime refinement;
- Hermes converts the selected `events.jsonl` trajectory to the Prime session format where required;
- Hermes invokes `/refine`;
- the `/refine` result is presented to a human;
- the human decides whether to create/update a Prime skill, memory, prompt rule, subagent behavior, or reject the suggestion.

Do **not** add the following to `prime-agent-delegate`:

- direct `/refine` execution;
- automatic Prime session conversion for refinement as part of normal delegation;
- automatic application of semantic Prime harness changes;
- automatic creation/promotion of Prime skills from collected statistics;
- automatic human-decision replacement.

The delegate skill may only create structured evidence and a curated refinement queue for Hermes.

## Required implementation areas

Implement the plan incrementally and preserve backward compatibility.

### Phase 0 — Baseline verification

Before modifying code:

1. inspect the current skill implementation;
2. run the existing tests;
3. confirm the current watchdog baseline;
4. inspect current `summary.json`, `audit-summary.json`, `health.json`, and event capture behavior;
5. inspect the current task transport logic;
6. inspect the current Prime process/lifecycle handling;
7. inspect the current Git/worktree handling;
8. inspect how secrets are currently redacted;
9. inspect the provided T053 failure/success artifacts if available.

Record the confirmed baseline in your working notes before making changes.

Do not modify code until the baseline is understood.

### Phase 1 — Metadata and versioned summary schema

Add the minimum metadata needed for later analysis without changing normal execution behavior.

Add, where compatible with the current CLI and implementation:

- a stable `runId`;
- task/work-package identifiers;
- task type;
- delegation mode;
- version metadata;
- `schemaVersion` for the summary.

Preserve all existing summary fields required by the current workflow.

Do not break old invocations that omit the new metadata.

### Phase 2 — Codex outcome recording and corpus foundation

Add a post-run mechanism for recording the result of Codex review.

Codex must be able to record a compact verdict using a fixed enum such as:

- `ACCEPTED`
- `MINOR_FIX`
- `MAJOR_FIX`
- `PARTIAL_USED`
- `REJECTED`

Also record Prime value using a small fixed enum such as:

- `HIGH`
- `MEDIUM`
- `LOW`
- `NONE`
- `NEGATIVE`

This post-run data must be separate from Prime's own summary because Prime cannot know the final Codex decision.

Create a normalized compact corpus record under `.prime-delegate/`.

Do not copy every full raw trajectory into the corpus by default.

### Phase 3 — Failure classification and ownership

Introduce structured, versioned failure classification.

At minimum distinguish ownership such as:

- `delegate_skill`
- `prime_agent`
- `task_spec`
- `provider`
- `environment`
- `project`
- `codex`
- `unknown`

Use deterministic classification wherever possible.

Known infrastructure errors must not require GPT-5.6 analysis.

Examples to classify programmatically where evidence is available:

- CCR/task transport failure;
- protocol incomplete;
- startup/idle/overall timeout;
- provider 429;
- provider 503/unavailable;
- Prime max-turn/max-token exhaustion;
- autonomous gate failure;
- no-progress/loop signals.

Only unresolved semantic/unknown cases should require Codex reasoning.

### Phase 4 — T053/CCR transport hardening

Treat T053 as a required regression case.

The current decision must not be based only on raw task-character length.

Measure the **effective Prime prompt payload**, including:

- mandatory worker rules;
- task content;
- headers;
- framing;
- transport instructions.

Use byte-aware sizing rather than assuming character count equals transport size.

Use UTF-8-safe task splitting.

Do not split Unicode incorrectly.

If task parts are used, provide a deterministic manifest or exact part names so Prime does not have to guess the file names.

Record transport telemetry in the summary, including enough information to later understand:

- transport mode;
- task bytes;
- effective initial prompt bytes;
- part count;
- maximum part size.

Add regression tests reproducing the real T053 boundary behavior.

### Phase 5 — Protocol lifecycle hardening

Separate:

- operating-system process success;
- Prime protocol success.

Track actual lifecycle evidence from the current Prime JSON event stream.

A process exiting with code `0` must not silently hide a missing/invalid Prime lifecycle.

Expose protocol completeness in the summary.

Add tests for at least:

- `exit 0` with no valid events;
- missing terminal lifecycle event;
- malformed JSON/event stream;
- normal successful lifecycle.

Preserve compatibility while tightening the evidence model.

### Phase 6 — Robust audit/redaction

Review `summarize-events.mjs`.

Keep it deterministic and compact.

Add structured signals useful to the classifier.

Fix secret redaction so common JSON-key secrets cannot leak into audit/corpus output.

Sanitize structured objects before serialization where practical.

Cover at least:

- authorization;
- API keys;
- tokens;
- access/refresh tokens;
- passwords;
- secrets;
- cookies.

Add regression tests.

### Phase 7 — Bounded self-healing for known technical failures

Only after the classification and regression foundation is reliable, add a bounded recovery layer for known technical failures.

Examples:

- CCR → switch to safe transport and retry once;
- known transient provider failure → bounded retry/backoff;
- existing startup infrastructure failure → bounded restart.

Do not use semantic self-healing to endlessly retry bad code.

Do not let recovery consume unlimited Prime turns/tokens/time.

After the recovery budget is exhausted:

`Codex takeover`

Record recovery history in the summary/corpus.

Known technical recovery should not require GPT-5.6 reasoning.

### Phase 8 — Corpus analytics

Add an offline analyzer for `.prime-delegate`.

The analyzer may calculate:

- delegation coverage;
- Codex verdict distribution;
- Prime value distribution;
- takeover reasons;
- failure classes;
- failure owners;
- results by Prime version;
- results by delegate-skill version;
- results by model/provider;
- results by task type;
- Work Package size/complexity proxies.

The analyzer must **not** directly modify runtime delegation decisions.

It is observational and improvement-oriented.

### Phase 9 — Refinement candidate queue for Hermes

Add only the delegate-side preparation required for later Hermes processing.

Support both:

- repeated negative Prime patterns;
- repeated positive/reusable Prime patterns.

Do not treat retries of the same Work Package as independent evidence.

Group evidence by incident/pattern family.

Produce a small curated queue for Hermes containing:

- pattern identifier;
- positive/negative type;
- source runs;
- whether required trajectory evidence is available;
- status.

Store compressed trajectories only for selected candidates or incidents where they are actually needed.

Do not call `/refine`.

### Phase 10 — Delegate-skill regression/self-improvement framework

For failures owned by `delegate_skill`, create the workflow:

`incident → reproducer → failing regression → candidate fix → full test suite → replay`

Do not automatically patch delegate-skill code from an incident unless there is a confirmed reproducible test.

Use low-risk automatic adjustments only where deterministic and safe.

Changes to Git isolation, credentials, security boundaries, production behavior, or deployment require explicit review.

## Worktree and Git safety

Preserve the current isolated branch/worktree architecture.

Confirm that launcher artifacts do not accidentally dirty the delegated repository.

If the current default output directory can create untracked files inside the delegated worktree, fix the root cause rather than masking it.

Do not treat `--allow-change` as a security sandbox. It is a validation policy.

Where necessary, independently validate the final changed-file set outside Prime's own gate.

Do not perform unrelated Git refactoring.

## Watchdog and process hardening

Preserve all existing watchdog guarantees.

Do not change watchdog semantics without regression tests.

Later hardening may distinguish activity from real progress, but do not introduce speculative complexity before the existing behavior is covered.

Inspect process termination behavior for Prime subagents/descendants in WSL.

If process-tree termination is incomplete, implement a verified fix with integration tests.

Do not introduce process-management changes without proving they work.

## Backward compatibility

The implementation must preserve:

- existing CLI usage where new options are not supplied;
- existing summary fields consumed by current workflows;
- current Prime Agent invocation behavior unless the plan explicitly changes it;
- current branch/worktree model;
- current autonomous gates;
- current Codex review responsibility.

Any intentional compatibility break must be justified by a confirmed root cause and explicitly documented before being introduced.

## Testing requirements

Do not rely only on the existing watchdog unit tests.

Keep all existing tests passing and add coverage for the new behavior.

Create a fake Prime Agent/test fixture capable of simulating relevant lifecycle/error scenarios without consuming real LLM tokens.

At minimum add regression/integration coverage for:

- T053 effective-payload CCR case;
- worker rules included in transport sizing;
- UTF-8-safe task splitting;
- normal Prime lifecycle;
- exit `0` with no events;
- missing terminal lifecycle event;
- malformed event stream;
- provider transient failures;
- gate failure;
- max-turn/max-token conditions where detectable;
- secret redaction;
- corpus normal record;
- corpus incident record;
- retry/incident deduplication;
- refine eligibility classification;
- launcher artifacts not dirtying the project;
- final changed-file validation where applicable.

Run syntax checks and all available relevant tests after changes.

## Implementation strategy

Do not perform one monolithic rewrite.

Implement this as a sequence of small, reviewable changes.

For each significant phase:

1. inspect the exact current code path;
2. establish a failing test or confirmed requirement;
3. make the smallest necessary change;
4. run focused tests;
5. run the broader relevant suite;
6. inspect the resulting diff;
7. verify that unrelated behavior did not change.

Use the current stable `prime-agent-delegate` baseline for delegation of isolated implementation work where appropriate, but do not rely on an unverified newly modified version to prove itself correct.

Keep a stable baseline available while modifying the skill.

## Constraints

Do not:

- rewrite the skill from scratch without demonstrated necessity;
- introduce a database or service unless the existing architecture actually requires it;
- use `.prime-delegate` as project memory;
- let corpus statistics automatically disable delegation;
- move `/refine` into this skill;
- automatically apply semantic `/refine` output;
- automatically create Prime skills without human approval;
- expose raw `events.jsonl` to GPT-5.6 by default;
- expand Prime production privileges;
- commit, push, deploy, or modify production without separate explicit authorization;
- make unrelated refactors;
- change unrelated functions;
- change public interfaces or protocols without necessity;
- fix only the visible symptom when the root cause has not been confirmed.

## Root-cause requirement

For every bug or design flaw found during implementation:

1. reproduce or confirm it;
2. identify the exact code path responsible;
3. explain why the current behavior occurs;
4. fix the root cause;
5. add a regression test where practical;
6. verify related scenarios.

Do not apply arbitrary thresholds, retries, timeouts, or CSS-style "patches" equivalent in logic without evidence.

For T053 specifically, prove the actual effective transport-size problem and validate the new behavior against the reproduced boundary.

## Acceptance criteria

The task is complete only when all mandatory criteria below are met.

### Architecture

- Delegate-first is explicitly documented.
- Only Codex owns `DELEGATE / CODEX_DIRECT`.
- Prime failure leads to Codex takeover, not user-task failure.
- `/refine` remains outside `prime-agent-delegate`.
- Hermes/human responsibilities are clearly separated.
- `.prime-delegate` is corpus-only and not runtime memory.

### Compatibility

- Existing successful delegation behavior remains functional.
- Existing required tests remain passing.
- Existing normal CLI usage remains supported unless an intentional, justified change is documented.
- Current summary consumers remain compatible.

### Corpus

- Codex can record a compact post-review outcome.
- Normal runs create compact corpus records.
- Incident/refine evidence can retain selected trajectories without storing every raw run indefinitely.
- Corpus storage does not dirty the application worktree.

### Classification

- Known infrastructure errors can be classified without GPT-5.6.
- Failure ownership distinguishes delegate-skill problems from Prime Agent behavior.
- Unknown cases remain explicit rather than guessed.

### T053 / transport

- Effective payload size, not only task length, is used.
- Mandatory worker rules are included in sizing.
- UTF-8 splitting is safe.
- A real T053-style regression test passes.
- Transport details are visible in the summary.

### Protocol

- Prime lifecycle completeness is measurable.
- `exit 0` alone is not treated as sufficient protocol evidence.
- Incomplete/malformed lifecycle cases are tested.

### Security

- Audit/corpus secret redaction is verified.
- No new production/deployment authority is given to Prime.
- No raw credentials are intentionally persisted into the corpus.

### Verification

- All relevant unit/integration/regression tests pass.
- Syntax checks pass.
- The final diff contains no unrelated changes.
- No production deployment is performed.

## Final report

At the end, provide a concise but complete implementation report containing:

1. **Confirmed baseline**
   - what was inspected;
   - which tests were run before changes;
   - relevant existing behavior.

2. **Confirmed root causes**
   - each important problem found;
   - evidence for the diagnosis;
   - especially T053/CCR if modified.

3. **Implemented changes**
   - grouped by phase/component;
   - changed files;
   - new files;
   - intentional compatibility changes, if any.

4. **Testing**
   - exact tests/checks executed;
   - pass/fail results;
   - new regression coverage.

5. **Architecture verification**
   - confirmation that delegate-first remains Codex-controlled;
   - confirmation that `.prime-delegate` is corpus-only;
   - confirmation that Hermes `/refine` remains separate.

6. **Remaining risks / deferred work**
   - anything from the implementation plan intentionally not completed;
   - why it was deferred;
   - what evidence or follow-up is needed.

7. **Deployment status**
   - explicitly state that no production deployment was performed unless separately authorized.
