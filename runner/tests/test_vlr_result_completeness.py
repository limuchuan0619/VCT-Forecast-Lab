import unittest

from vct_prediction.sources.vlr import _complete_competitive_map_score, validate_series_finality


class VlrResultCompletenessTests(unittest.TestCase):
    def test_rejects_live_partial_scores_that_previously_looked_like_map_wins(self) -> None:
        self.assertFalse(_complete_competitive_map_score(3, 6))
        self.assertFalse(_complete_competitive_map_score(1, 4))
        self.assertFalse(_complete_competitive_map_score(12, 11))

    def test_accepts_standard_and_overtime_terminal_scores(self) -> None:
        self.assertTrue(_complete_competitive_map_score(13, 0))
        self.assertTrue(_complete_competitive_map_score(13, 11))
        self.assertTrue(_complete_competitive_map_score(12, 14))
        self.assertTrue(_complete_competitive_map_score(18, 16))

    def test_rejects_invalid_overtime_and_negative_scores(self) -> None:
        self.assertFalse(_complete_competitive_map_score(13, 12))
        self.assertFalse(_complete_competitive_map_score(15, 12))
        self.assertFalse(_complete_competitive_map_score(-1, 13))

    def test_series_gate_rejects_partial_100t_loud_map_five(self) -> None:
        maps = [
            {"map_order": 1, "team_a_rounds": 7, "team_b_rounds": 13},
            {"map_order": 2, "team_a_rounds": 13, "team_b_rounds": 11},
            {"map_order": 3, "team_a_rounds": 14, "team_b_rounds": 12},
            {"map_order": 4, "team_a_rounds": 1, "team_b_rounds": 13},
            {"map_order": 5, "team_a_rounds": 5, "team_b_rounds": 7},
        ]
        self.assertEqual(validate_series_finality("bo5", "final", (2, 3), maps), ("REVISION_PENDING", "incomplete_map_score"))

    def test_series_gate_accepts_terminal_bo5_and_rejects_source_conflict(self) -> None:
        maps = [
            {"map_order": 1, "team_a_rounds": 7, "team_b_rounds": 13},
            {"map_order": 2, "team_a_rounds": 13, "team_b_rounds": 11},
            {"map_order": 3, "team_a_rounds": 14, "team_b_rounds": 12},
            {"map_order": 4, "team_a_rounds": 1, "team_b_rounds": 13},
            {"map_order": 5, "team_a_rounds": 14, "team_b_rounds": 12},
        ]
        self.assertEqual(validate_series_finality("bo5", "final", (3, 2), maps), ("FINAL_CANDIDATE", None))
        self.assertEqual(validate_series_finality("bo5", "final", (2, 3), maps), ("RESULT_INCONSISTENT", "source_map_series_conflict"))
        self.assertEqual(validate_series_finality("bo5", "live", (3, 2), maps), ("REVISION_PENDING", "source_status_not_final"))


if __name__ == "__main__":
    unittest.main()
