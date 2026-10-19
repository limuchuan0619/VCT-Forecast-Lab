# Cloud Runner

This directory shows the unattended pipeline used to discover fixtures, enforce quality gates, freeze predictions, settle results and evaluate frozen Logistic C1 beside Champion V1.0.0.

Key files:

- [automation.py](src/vct_prediction/automation.py) - lifecycle orchestration
- [shadow.py](src/vct_prediction/shadow.py) - read-only C1 loader and prospective metrics
- [db.py](src/vct_prediction/db.py) - immutable snapshots and prediction records
- [vct_public_bridge.py](bridge/vct_public_bridge.py) - bounded public synchronization
- [runner_service.py](runner_service.py) - service health and scheduled cycle
- [competition.py](src/vct_prediction/competition.py) - four-region discovery policy and separate competition cohorts

The included C1 files are a public reproducibility subset: parameters and aggregate evaluation metadata only. The production seed database and Railway binding are not included.

```powershell
python -m pip install -r requirements.txt
$env:PYTHONPATH = "src"
python -m unittest discover -s tests -v
```

The Dockerfile creates a schema-only seed at image build time, not a production database. Supply your own authorized dataset and provider/sync settings before using it as a cloud service. No production deployment happens from this repository. Eight private-seed integration checks skip when that excluded seed is absent; all other Runner tests remain active.

The live scheduler normally runs every two hours and retries partial/failed cycles after fifteen minutes. It has explicit discovery budgets and preserves ready/blocked/watch-only states. Qualification/secondary/invitational observations do not enter the original primary-VCT 100-pair C1 gate.
