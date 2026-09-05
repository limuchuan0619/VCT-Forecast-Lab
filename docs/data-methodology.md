# Data Methodology

The central data problem is not merely whether a field exists today. It is whether the field can be reconstructed as it was known immediately before a historical match.

## Granularity

The internal normalized model is:

\`\`\`text
Event
└── Match
    ├── teams, time, format and result
    └── Map
        ├── map result and order
        └── Player
            ├── agent
            ├── ACS / ADR / KAST
            └── K / D / A / FK / FD
\`\`\`

VLR is treated as a community secondary source. The production system retains provenance and content hashes, but this public repository does not redistribute the historical archive.

## Strict as-of rule

For target match **T**, every dynamic feature must satisfy:

\`\`\`text
source_time < target_match_time
\`\`\`

The target match itself and all later events are forbidden. Equality is also forbidden because a snapshot observed at the target timestamp may already contain the target result.

Historical Replay recalculates dynamic state instead of reading today's final team rows. In particular, it does not backfill historical predictions from current:

- team rating;
- player form;
- roster continuity;
- patch fit;
- map rating.

## Replay-safe features

V1.4A validated the following features under an exclusive cutoff:

- historical team rating;
- recent form;
- prior match count;
- historical active-map strength;
- previous observed roster;
- roster continuity;
- player form;
- ACS;
- ADR;
- FK-FD.

The expanded V1.4B dataset also retained KAST and player-rating differences when prior observations were available.

## Roster rule

The roster for Match T is the most recently observed roster before T:

\`\`\`text
Observed roster at T-1
        ↓
Feature snapshot for T
\`\`\`

The actual five players who appear in Match T are not treated as pre-match evidence unless they had already been observed in a prior match. This is conservative, but it avoids learning from information confirmed only after play began.

## Missing data

Raw missing values are never silently turned into zero. Each feature has one of three states:

| State | Meaning |
|---|---|
| observed | Derived directly from prior observations |
| imputed_team_mean | Replaced using a mean calculated from prior-only team data |
| feature_unavailable | No defensible prior value exists |

Logistic C1 uses train-only imputation parameters and explicit status indicators, allowing the model to distinguish an observed number from a filled value.

## Poison Future Test

The replay generator is tested by:

1. generating features for historical Match T;
2. cloning the database in isolation;
3. adding an extreme future result after T;
4. adding extreme future map and player statistics;
5. changing future roster observations and current team state;
6. rebuilding the features for T;
7. requiring equality within a small floating-point tolerance.

V1.4A passed five manually inspected poison tests. V1.4B expanded the check to 20 boundary/random matches and all 1,000 dataset rows passed source-time and forbidden-input assertions.

## Not replay-safe

The following fields are not used as formal Challenger features with the current archive:

- exact historical BP/veto;
- true VALORANT patch;
- official pre-match roster announcements;
- stable attack/defense splits across the full sample;
- target-match map selections;
- target-match actual lineup;
- complete round-level events;
- economy, pistol and clutch history.

The stored **event_cohort** is context only. It must not be described as a true game patch.

## Temporal leakage risks

| Risk | Mitigation |
|---|---|
| Current team state copied into the past | Rebuild dynamic state from prior matches |
| Target match included in form | Exclusive timestamp cutoff |
| Target lineup used as known roster | Previous-observed-roster rule |
| Imputation learned from validation/test | Fit imputation on Train only |
| Feature changed after result import | Immutable pre-match snapshot |
| Historical prediction counted as prospective | Record-kind and freeze eligibility filters |

## Public data boundary

This portfolio contains schemas, feature logic, tests and synthetic examples. It excludes:

- the formal SQLite database;
- full historical match JSONL;
- raw VLR HTML;
- source cookies or authorization material;
- production logs;
- D1 local state.

The absence of raw data is intentional and prevents this code publication from being presented as a redistribution license for third-party data.
