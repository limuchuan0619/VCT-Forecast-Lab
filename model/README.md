# Model Layer

This directory contains the explainable Champion model, historical replay builder, Logistic Challenger and evaluation utilities.

Key files:

- [predictor.py](src/vct_prediction/predictor.py) — match probability and score distribution
- [ratings.py](src/vct_prediction/ratings.py) — opponent- and score-aware rating updates
- [form.py](src/vct_prediction/form.py) — time-decayed recent form
- [maps.py](src/vct_prediction/maps.py) — independent map strength and series simulation
- [replay.py](src/vct_prediction/replay.py) — strict historical as-of feature construction
- [challenger.py](src/vct_prediction/challenger.py) — Elo/Champion/Logistic comparison
- [backtest.py](src/vct_prediction/backtest.py) — evaluation metrics

Run the public unit subset from this directory:

\`\`\`powershell
python -m unittest discover -s tests -v
\`\`\`

Tests requiring the private formal database or historical row artifact skip by design. No raw match data is included.
