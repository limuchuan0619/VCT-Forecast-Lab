# Portfolio verification

This page records checks on the public export, not a new deployment or a rerun of the private historical Test set.

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
