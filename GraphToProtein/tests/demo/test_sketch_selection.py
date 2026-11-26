import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "demo"))
from sketch_model import choose_candidate


def score(seed, anchor_distance, path_distance, passed=True, rigid_error=3):
    return {"seed": seed, "mean_distance": anchor_distance, "path_mean_distance": path_distance,
            "anchor_rigid_rmsd": rigid_error,
            "geometry_gates": {"ca_ca_spacing": "PASS", "main_chain_bonds": "PASS" if passed else "FAIL"}}


class SketchSelectionTest(unittest.TestCase):
    def test_better_position_cannot_mask_a_worse_intrinsic_shape(self):
        baseline = score(0, 10, 12)
        self.assertIs(choose_candidate([score(1, 7, 8, rigid_error=4), baseline]), baseline)

    def test_prevents_better_anchors_hiding_a_worse_path(self):
        baseline = score(0, 10, 12)
        self.assertIs(choose_candidate([score(3, 5, 13), baseline]), baseline)

    def test_geometry_failure_and_missing_file_are_ineligible(self):
        best = score(2, 7, 8)
        self.assertIs(choose_candidate([score(0, 2, 3, False), {"seed": 1, "error": "missing"}, best]), best)
        with self.assertRaises(ValueError):
            choose_candidate([score(1, 1, 1, False)])

    def test_better_valid_shape_wins_and_ties_are_order_independent(self):
        best = score(1, 6, 7)
        self.assertIs(choose_candidate([score(3, 6, 7), best, score(0, 9, 10)]), best)


if __name__ == "__main__":
    unittest.main()
