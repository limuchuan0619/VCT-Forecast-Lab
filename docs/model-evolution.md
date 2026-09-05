# Model Evolution

This document records completed evidence. It does not invent future promotion outcomes.

## Timeline

\`\`\`mermaid
timeline
    title VCT Forecast Lab model evolution
    V1.0.0 : Explainable Champion becomes the official probability model
    V1.4A : Historical Replay Validation
           : REPLAY_VALIDATED
    V1.4B : Logistic Challenger C1
           : Historical verdict INCONCLUSIVE
    V1.4C : Frozen Prospective Shadow Evaluation
           : ACCUMULATING
\`\`\`

## V1.0.0 — Champion

The initial Champion is an interpretable rules-based model combining:

- dynamic team rating;
- opponent-adjusted recent form;
- independent map strength;
- player form;
- roster continuity;
- event-cohort context;
- international experience;
- BO3/BO5 adaptability;
- tactical matchup context.

It remains the only official online probability model.

## V1.4A — Historical Replay Validation

Goal: prove that historical features can be rebuilt without seeing the future.

Result: **REPLAY_VALIDATED**

- 30 consecutive VCT CN matches;
- strict source_time < target_time;
- minimum prior history requirement;
- prior-observed roster rule;
- explicit missingness;
- five poison-future checks;
- five manual spot checks.

No model was trained in this stage.

## V1.4B — First Data-Driven Challenger

Goal: compare Elo, the Champion replay-safe proxy and one simple Logistic Regression challenger.

Dataset:

- 1,000 chronological eligible matches;
- 650 Train;
- 150 Validation;
- 200 frozen Test.

Result: **INCONCLUSIVE**

C1 improved Brier and Log Loss slightly over the partial Champion proxy but did not satisfy the predeclared promotion rule and had lower Accuracy. The system rejected the temptation to promote on a marginal result.

## V1.4C — Prospective Shadow

Goal: run frozen C1 next to Champion on future eligible fixtures.

Current state: **ACCUMULATING**

- Champion and C1 use the same pre-match snapshot;
- both probabilities are frozen before the match;
- both are settled independently;
- historical and isolated records are excluded;
- DeepSeek may diagnose errors after settlement;
- promotion is disabled before 100 eligible resolved matches.

At the time of this portfolio publication, the prospective count is **0/100**. No result is implied.

## What comes next

Only observed evidence may extend this timeline. Valid future states include:

- continued evaluation;
- rejection;
- a separately versioned challenger experiment;
- promotion after the formal gate and governance review.

The following are deliberately not claimed:

- C1 promoted;
- C1 rejected prospectively;
- C2 created;
- LightGBM adopted;
- automatic self-improvement completed.
