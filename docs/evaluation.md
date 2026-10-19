# Evaluation

VCT Forecast Lab evaluates probability quality, not only whether the predicted winner was correct.

## Chronological split

The V1.4B historical dataset was sorted by match time and fixed as:

| Split | Matches | Role |
|---|---:|---|
| Train | 650 | Fit imputation, scaling and Logistic coefficients |
| Validation | 150 | Select bounded regularization |
| Frozen Test | 200 | One final historical comparison |

There is no random shuffle:

```text
earliest ───────────────► latest
Train 650 | Validation 150 | Frozen Test 200
```

The ordered Test IDs were hashed before final evaluation. Once inspected, this Test set may not be used to repeatedly change features, tune parameters or select a successor.

## Compared models

### Elo baseline

A simple chronological rating baseline. Each pre-match probability uses only the current rating at that time; the result updates ratings only for later matches.

### Champion V1.0.0 partial replay proxy

The official model's replay-safe factors are reconstructed without modifying the frozen Champion rules. Several online factors cannot be reproduced fairly from the historical archive, so this row is explicitly a **partial proxy**, not the complete production Champion.

### Logistic Challenger C1

A small, interpretable Logistic Regression model using ten feature differences plus missing/imputed indicators. Preprocessing is fit on Train only.

## Metrics

For a binary target y and Team A probability p:

- **Accuracy** checks whether the side above 50% won.
- **Brier Score** is the mean squared probability error: (p - y)².
- **Log Loss** penalizes confident wrong probabilities more heavily.
- **Calibration** asks whether events assigned about 70% happen about 70% of the time.
- **ECE** summarizes weighted calibration-bin error.

Lower Brier, Log Loss and ECE are better. Accuracy is useful but is not sufficient to judge probability quality.

## Historical result

| Model | Brier | Log Loss | Accuracy |
|---|---:|---:|---:|
| Elo | 0.252311 | 0.703687 | 56.0% |
| Champion Partial Replay Proxy | 0.243952 | 0.683014 | 61.0% |
| Logistic C1 | 0.243037 | 0.679587 | 59.0% |

Logistic C1 ECE: **0.063562**

## Verdict

**INCONCLUSIVE**

C1 clearly outperformed Elo. Against the Champion partial proxy, however:

- Brier improved only slightly;
- Log Loss improved only slightly;
- Accuracy was two percentage points lower;
- the predeclared promotion margin was not met.

Therefore C1 was not promoted.

## Historical versus prospective evaluation

Historical replay asks:

> If the model had existed then, what would it have predicted using only information available then?

Prospective evaluation asks:

> Was this exact probability actually frozen before a future match and later settled against the real result?

They are stored separately. The 200 historical Test matches are never added to the prospective count.

## Prospective gate

State read from the production aggregate API on 2026-10-19 19:18 Asia/Shanghai:

| Field | Value |
|---|---|
| Model | Logistic C1 |
| Mode | FROZEN SHADOW |
| Eligible resolved matches | 34 |
| Status | PRELIMINARY |
| Formal gate | 100 |
| Promotion enabled | No |

Progress labels are sample-count labels, not performance judgements:

| Matches | Label |
|---:|---|
| 0-29 | ACCUMULATING |
| 30-49 | PRELIMINARY |
| 50-99 | EVALUATING |
| 100+ | GATE_READY |

GATE_READY means an authorized review may begin. It does not automatically promote or reject a model.

The same 34 eligible resolved pairs produced the following preliminary values:

| Model | Brier | Log Loss | Accuracy | ECE (10 bins) |
|---|---:|---:|---:|---:|
| Champion V1.0.0 | 0.247917 | 0.689298 | 0.558824 | 0.039284 |
| Frozen Logistic C1 | 0.235605 | 0.664047 | 0.647059 | 0.131233 |

C1 has lower Brier and Log Loss in this early sample, but higher ECE. This is not evidence of promotion eligibility or a statistically established advantage. No historical Test rows or later-added qualification/secondary/invitational cohorts enter the original 100-pair gate. The separate Gold count is 42 eligible fixtures and must not be confused with 34 paired comparisons.

## Anti-selection rules

The evaluation protocol forbids:

- changing the Test set after seeing results;
- deleting difficult matches;
- selecting only favorable events;
- retuning features against the frozen Test;
- counting blocked fixtures;
- generating a probability after the result;
- promoting based on accuracy alone;
- allowing an AI narrative to decide promotion.
