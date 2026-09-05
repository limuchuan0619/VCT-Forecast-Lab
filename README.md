# VCT Forecast Lab

> A VCT forecasting product that shows how predictive models can be tested, challenged and improved through real competitive matches.

[![Champion](https://img.shields.io/badge/Champion-V1.0.0-2563eb)](#current-model-status)
[![Challenger](https://img.shields.io/badge/Challenger-Logistic_C1_Frozen_Shadow-7c3aed)](#current-model-status)
[![Prospective gate](https://img.shields.io/badge/Prospective-0%2F100_ACCUMULATING-f59e0b)](#current-model-status)

## Live Demo

**[Open the VCT Forecast Lab](https://vct-forecast-lab.limuchuan128.chatgpt.site/)**

![VCT Forecast Lab product interface](docs/assets/product-overview.png)

## What is VCT Forecast Lab?

VCT Forecast Lab is an **AI/Data Product + Machine Learning + SportsTech portfolio project** built around one question:

> Can a VCT forecasting system visibly learn from real matches and improve itself over time?

It is not presented as the world's most accurate VALORANT model. The product is designed to make the full forecasting lifecycle inspectable: pre-match evidence, feature snapshots, locked probabilities, result settlement, calibration metrics, challenger comparison and AI-assisted diagnosis.

The defining behavior is restraint. A challenger is not promoted because it looks promising in one backtest. It must survive chronological replay, temporal-leakage tests, a frozen test set and a prospective gate built from predictions that were genuinely frozen before future matches began.

## The Learning Loop

\`\`\`mermaid
flowchart TD
    A[Real VCT Match] --> B[Pre-match Data]
    B --> C[Strict as-of Feature Snapshot]
    C --> D[Champion V1.0.0]
    C --> E[Shadow Challenger]
    D --> F[Prediction Freeze]
    E --> F
    F --> G[Confirmed Match Result]
    G --> H[Brier / Log Loss / Accuracy / ECE]
    G --> I[DeepSeek Model Diagnosis]
    I --> J[Research Hypotheses]
    H --> K[Challenger Evaluation]
    J --> K
    K --> L{Evidence gate passed?}
    L -->|Yes, after governance review| M[Promote]
    L -->|No or insufficient| N[Reject or keep evaluating]
\`\`\`

DeepSeek may explain signals and propose hypotheses. It cannot change official probabilities, retrain a model, modify coefficients, edit code or promote a challenger.

## Current Model Status

Status verified from the production project state on **2026-09-04**:

| Role | Model / state |
|---|---|
| Champion | V1.0.0 |
| Current challenger | Logistic C1 |
| Challenger mode | FROZEN SHADOW |
| Historical verdict | INCONCLUSIVE |
| Prospective status | ACCUMULATING |
| Eligible prospective resolved matches | 0 |
| Promotion gate | 100 eligible prospective resolved matches |
| Automatic promotion | Disabled |

The zero is intentional. Historical matches and simulations are not backfilled into the prospective counter.

## Historical Evaluation

The first data-driven challenger was evaluated on a strictly chronological **650 Train / 150 Validation / 200 frozen Test** split.

| Model | Brier | Log Loss | Accuracy |
|---|---:|---:|---:|
| Elo | 0.252311 | 0.703687 | 56.0% |
| Champion Partial Replay Proxy | 0.243952 | 0.683014 | 61.0% |
| Logistic C1 | 0.243037 | 0.679587 | 59.0% |

**Verdict: INCONCLUSIVE**

C1 clearly outperformed Elo, but its improvement over the frozen Champion historical proxy was too small to satisfy the predeclared promotion threshold. Therefore C1 was **not promoted**.

The Champion row is explicitly a **partial replay proxy**, not a claim that the complete online Champion was reconstructed. Exact historical veto/BP, true game patch, official pre-match roster, stable attack/defense splits and several contextual factors were not replay-safe in the available historical database.

This result is a feature of the project:

- the test set was locked before the final evaluation;
- test-set retuning is prohibited;
- accuracy is not used alone;
- insufficient evidence produces no promotion;
- historical and prospective evaluation remain separate.

See [Evaluation](docs/evaluation.md) for the protocol and [Model Evolution](docs/model-evolution.md) for the version history.

## Architecture

VCT Forecast Lab has three production layers, represented here as a curated, security-reviewed code snapshot:

| Layer | Responsibility | Portfolio path |
|---|---|---|
| Model | Explainable ratings, form, maps, historical replay, Challenger C1 and metrics | [model/](model/) |
| Cloud Runner | Fixture discovery, quality gates, freeze, settlement and frozen shadow evaluation | [runner/](runner/) |
| Public Site | Prediction UI, D1 ledger, reviews and DeepSeek diagnosis boundaries | [site/](site/) |

Read the full [Architecture](docs/architecture.md).

## Data and Leakage Controls

The core historical rule is:

\`\`\`text
source_time < target_match_time
\`\`\`

Historical features are rebuilt from observations that existed before each target match. Missing statistics are never silently replaced with zero; each value retains one of three states:

- **observed**
- **imputed_team_mean**
- **feature_unavailable**

An extreme **Poison Future Test** injects future results, player statistics and roster changes into an isolated copy. A historical feature passes only if its value remains unchanged.

See [Data Methodology](docs/data-methodology.md).

## AI Governance

Post-match diagnosis separates evidence into:

1. **FACT** — confirmed database or source evidence;
2. **MODEL SIGNAL** — frozen inputs, probabilities and contributions;
3. **HYPOTHESIS** — a possible explanation that still requires testing.

> AI proposes hypotheses; statistical evaluation decides whether they are useful.

See [AI Governance](docs/ai-governance.md).

## Repository Map

\`\`\`text
.
├── README.md
├── docs/
│   ├── architecture.md
│   ├── model-evolution.md
│   ├── data-methodology.md
│   ├── evaluation.md
│   └── ai-governance.md
├── model/       # Model, replay and Challenger code
├── runner/      # Automation and frozen shadow code
├── site/        # Public UI, APIs and D1 schema
├── tests/       # Navigation for selected component tests
└── examples/    # Synthetic, non-production records
\`\`\`

## Reviewing the Code

Useful starting points:

- [Historical replay builder](model/src/vct_prediction/replay.py)
- [Logistic Challenger evaluation](model/src/vct_prediction/challenger.py)
- [Frozen shadow scorer and prospective metrics](runner/src/vct_prediction/shadow.py)
- [Automation lifecycle](runner/src/vct_prediction/automation.py)
- [Public prediction and diagnosis ledger](site/lib/prediction-store.ts)
- [DeepSeek evidence schema](site/lib/deepseek.ts)
- [Temporal leakage tests](model/tests/test_historical_replay.py)
- [Shadow immutability tests](runner/tests/test_shadow_challenger.py)

The repository intentionally excludes the formal SQLite database and raw third-party match archive. Database-dependent replay tests therefore skip or require a separately authorized local dataset. Synthetic examples are available under [examples/](examples/).

## Limitations

- VLR is a community secondary source, not an official Riot data API.
- Exact historical BP/veto is not yet consistently replay-safe.
- The stored event cohort is not claimed to be the true game patch.
- Official pre-match roster timelines are incomplete.
- Complete round-level, economy, pistol and clutch history is unavailable.
- Attack/defense splits are not consistently usable across the full historical sample.
- Prospective Challenger evidence is currently 0/100; no promotion claim is made.

## Roadmap

The active system is accumulating genuine pre-match Champion/C1 prediction pairs. Future work is conditional on evidence:

1. accumulate eligible prospective resolved matches;
2. monitor calibration and blocker coverage;
3. evaluate only at the 100-match gate;
4. promote, reject or continue evaluation through an explicit governance decision.

No future promotion or rejection is asserted in this repository.

## Data and Affiliation Notice

No complete VLR history, production database, raw scrape cache or production credential is distributed here. Third-party marks and source material remain the property of their respective owners.

This project is an independent portfolio/research project and is not affiliated with Riot Games, VALORANT Champions Tour, or VLR.gg.

## License

No open-source license has been selected for this repository. Publication does not grant rights to redistribute third-party data.
