# Portfolio verification

This page records checks on the public export, not a new deployment or a rerun of the private historical Test set.

## Incremental update — 2026-10-21

- Review baseline: `5302bd6cad41c270519caae932c8c064d1406d93` on `main`. Only changed files and necessary callers were reviewed; unchanged model and frozen C1 evaluation conclusions were reused.
- Updated scope: bounded readiness/private archive modules, optional strictly pre-lock AI evidence bridge, compact esports UI/verified logos, and evidence-selected AI review contract. Model scoring code and parameters are unchanged.
- Source correspondence: Site `bceb3c885f05d1ac26f3479a23bd7850038768e7` / Sites Version 41. Runner parent `d6ff9df972d9e7c1086fb1340a703367fbc7385a` plus the reviewed working-tree snapshot; this is NOT a claim that its new prematch bridge is deployed.
- Public-only empty seed, placeholder bindings, private-seed test skips and frozen public C1 parameter subset retained. No database, source observation archive, raw page, historical training row, real environment file or deployment binding was added.

| Executed check | Result |
|---|---|
| Five changed Site test files, command below | 54 passed, 0 skipped |
| `npx --no-install tsc --noEmit` in `site/` | Passed |
| `test_data_readiness.py` | 17 passed |
| `test_evidence_archive.py` | 18 passed |
| `test_prematch_reader_context.py` | 2 passed |
| `test_runner_service.py` | 10 passed, 1 private-seed test skipped |
| Changed-file publication audit (source/assets) | 58 files; no credential, private path, production binding or broken local link findings |
| Private local checkpoint | Git bundles/source hashes/ZIP CRC/SQLite quick_check verified; not a cloud production database backup |

Site tests: `node --experimental-strip-types --test tests/ai-reliability.test.ts tests/analysis-repair.test.ts tests/diagnosis-queue.test.ts tests/review-provider.test.ts tests/esports-ui.test.ts`.
Runner tests: set `PYTHONPATH=src`, then run `python -m unittest discover -s tests -p <each file above>`.

The unchanged upstream Site build/109 tests and Runner105 tests were verified earlier the same day; they were not repeated as a new full export certification. No new build, deployment, provider generation, historical Test evaluation, fitting or promotion was performed during this Git synchronization.

Known unfinished work: Runner prematch-context release and a real LOUD/Vitality v18 generation/editorial acceptance. Platform/management access prevented those steps at the last attempt. Historical player aggregation is still not verified as the current starting five. Schema/citation checks constrain known errors but are not universal semantic or professional-quality guarantees.

## Incremental review policy

Start with branch/status and a named baseline; review only changed paths plus necessary upstream/downstream code. Reuse verified conclusions for unchanged code. Run relevant tests, check new sensitive-data/boundary risks, and separate independent commits. Never discard pre-existing edits or force-push. Record source SHA/deployment correspondence without treating Git push as testing or deployment.

Expand to the affected call chain only when formulas/features/as-of safety, schema/history semantics, promotion/security, dependencies/deployment/interfaces change materially, or local failures cannot be explained. A full-repository audit is not the default. This document records scope, commands, results and known limits; the latest accepted baseline is the completed synchronization commit recorded by Git and the local project state.

## Scope

- Source snapshot refreshed on 2026-10-19 from the three independent production projects.
- Reader-facing cover captured from the real public prediction-history page.
- Public configuration retains placeholder D1 bindings and an empty local seed.
- No production credentials, database, raw source pages, training rows, logs or deployment bindings are intended for publication.
- Frozen C1 scoring parameters are reused, never refitted. Public artifact subsets have their own content hashes; the original production artifact hash remains provenance metadata.

## Results

Verified locally on 2026-10-19 with Python 3.12 and Node.js 24.15. Existing dependencies were reused; no production service was redeployed.

| Check | Result | Boundary |
|---|---|---|
| Public Site unit/contract tests | 95 passed, 0 skipped | Isolated fixtures and mocked providers |
| Model test discovery | 16 passed, 13 skipped | Private historical database/artifacts and excluded desktop API unavailable |
| Runner test discovery | 60 passed, 8 skipped | Eight private-production-seed integrations intentionally skipped |
| Public Site production build | Passed | Placeholder local bindings; not a live database/provider test |

The skips are explicit, not counted as passes. The production Runner's earlier 68/68 verification used its private seed and is a separate result, not the public export's result. The public C1 scorer still loads its existing preprocessing and parameters without fitting.

The README cover is a 1440 x 900 composition of a genuine public prediction-history screenshot, not a generated or fabricated dashboard. The old decorative illustration was replaced.

The pre-publication audit reviewed 232 Git candidate files, found no credential literals, personal absolute paths, production bindings, database/raw-data files or files at least 5 MiB, and verified that local Markdown links resolve. This is a scoped export audit, not a general security certification.

## Explicitly not performed

- Historical 200-match Test evaluation or challenger selection.
- C1 retraining, promotion or Champion weight changes.
- Railway/Sites redeployment or production migrations.
- Live paid AI-provider generation or database backfill.

Known product limitations remain visible in the root README. A passing export test suite does not imply complete competition coverage or a permanently healthy AI provider.
