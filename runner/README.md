# Cloud Runner

This directory shows the unattended pipeline used to discover fixtures, enforce quality gates, freeze predictions, settle results and evaluate frozen Logistic C1 beside Champion V1.0.0.

Key files:

- [automation.py](src/vct_prediction/automation.py) — lifecycle orchestration
- [shadow.py](src/vct_prediction/shadow.py) — read-only C1 loader and prospective metrics
- [db.py](src/vct_prediction/db.py) — immutable snapshots and prediction records
- [vct_public_bridge.py](bridge/vct_public_bridge.py) — bounded public synchronization
- [runner_service.py](runner_service.py) — service health and scheduled cycle

The included C1 files are a public reproducibility subset: parameters and aggregate evaluation metadata only. The production seed database and Railway binding are not included.

\`\`\`powershell
python -m unittest discover -s tests -v
\`\`\`
