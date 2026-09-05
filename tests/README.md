# Selected Tests

Tests remain beside the component whose package layout they exercise:

- [Historical replay and poison-future checks](../model/tests/test_historical_replay.py)
- [Chronological Challenger evaluation](../model/tests/test_challenger.py)
- [Champion model tests](../model/tests/test_model.py)
- [Frozen C1 loading and immutable shadow records](../runner/tests/test_shadow_challenger.py)
- [Prospective learning state](../runner/tests/test_prospective_learning.py)
- [Runner lifecycle](../runner/tests/test_runner_service.py)

The public repository excludes the formal SQLite database. Historical replay tests that require it are designed to skip when that local evidence asset is unavailable. Runner tests use temporary synthetic databases and the public C1 parameter subset.

Network-source and local FastAPI integration tests are not included in the portfolio baseline because their optional runtime dependencies and source fixtures are outside the publication scope.
