"""
Unit tests for angle calculation.

We construct synthetic landmarks forming a known geometry,
then verify the calculated angles against expected values.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))

import math
import pytest

from landmark_detection.detector import JointLine, Landmarks, Point
from axis_calculation.axes import AxisCalculator
from angle_measurement.angles import AngleCalculator


def make_straight_leg():
    """
    Perfectly straight leg: hip, knee, ankle in a vertical line.
    HKA should be 0°, joint lines horizontal → mLDFA ≈ mMPTA ≈ 90°.
    """
    lm = Landmarks(
        hip_center=Point(500, 100),
        knee_center=Point(500, 500),
        ankle_center=Point(500, 900),
        distal_femoral_line=JointLine(
            medial=Point(550, 500),
            lateral=Point(450, 500),
        ),
        proximal_tibial_line=JointLine(
            medial=Point(550, 510),
            lateral=Point(450, 510),
        ),
    )
    # Add diaphysis points along the vertical shaft
    lm.femur_diaphysis = [Point(500, y) for y in [200, 300, 400]]
    lm.tibia_diaphysis = [Point(500, y) for y in [550, 650, 750, 850]]
    return lm


def make_varus_leg(varus_deg: float = 5.0):
    """
    Simulate a right-leg varus deformity.

    Standard AP radiology: patient right = image left.
    Right leg: medial = image right (larger x), lateral = image left (smaller x).
    Varus = ankle displaced medially = to image RIGHT (larger x).
    """
    hip = Point(500, 100)
    knee = Point(500, 500)
    # Ankle displaced medially (right in image) for standard AP right leg varus
    ankle_x = 500 + math.tan(math.radians(varus_deg)) * 400
    ankle = Point(ankle_x, 900)
    lm = Landmarks(
        hip_center=hip,
        knee_center=knee,
        ankle_center=ankle,
        distal_femoral_line=JointLine(
            medial=Point(550, 500),
            lateral=Point(450, 500),
        ),
        proximal_tibial_line=JointLine(
            medial=Point(550, 510),
            lateral=Point(450, 510),
        ),
    )
    return lm


class TestAngleCalculation:
    def setup_method(self):
        self.axis_calc = AxisCalculator()
        self.angle_calc = AngleCalculator()

    def test_straight_leg_hka_near_zero(self):
        lm = make_straight_leg()
        axes = self.axis_calc.calculate(lm)
        angles = self.angle_calc.calculate(axes, lm)
        assert angles.HKA is not None
        assert abs(angles.HKA) < 1.0, f"Expected HKA ≈ 0, got {angles.HKA}"

    def test_straight_leg_mldfa_near_90(self):
        lm = make_straight_leg()
        axes = self.axis_calc.calculate(lm)
        angles = self.angle_calc.calculate(axes, lm)
        assert angles.mLDFA is not None
        assert abs(angles.mLDFA - 90.0) < 1.0, f"Expected mLDFA ≈ 90°, got {angles.mLDFA}"

    def test_straight_leg_mmpta_near_90(self):
        lm = make_straight_leg()
        axes = self.axis_calc.calculate(lm)
        angles = self.angle_calc.calculate(axes, lm)
        assert angles.mMPTA is not None
        assert abs(angles.mMPTA - 90.0) < 1.0, f"Expected mMPTA ≈ 90°, got {angles.mMPTA}"

    def test_straight_leg_jlca_near_zero(self):
        lm = make_straight_leg()
        axes = self.axis_calc.calculate(lm)
        angles = self.angle_calc.calculate(axes, lm)
        assert angles.JLCA is not None
        assert abs(angles.JLCA) < 1.0, f"Expected JLCA ≈ 0°, got {angles.JLCA}"

    def test_varus_leg_negative_hka(self):
        """Varus deformity: HKA should be negative."""
        lm = make_varus_leg(5.0)
        axes = self.axis_calc.calculate(lm)
        angles = self.angle_calc.calculate(axes, lm)
        assert angles.HKA is not None
        assert angles.HKA < 0, f"Varus should give negative HKA, got {angles.HKA}"

    def test_hka_magnitude_matches_input(self):
        """HKA magnitude should be close to the input varus angle."""
        target = 6.0
        lm = make_varus_leg(target)
        axes = self.axis_calc.calculate(lm)
        angles = self.angle_calc.calculate(axes, lm)
        assert angles.HKA is not None
        assert abs(abs(angles.HKA) - target) < 1.0, (
            f"Expected |HKA| ≈ {target}°, got {angles.HKA}"
        )

    def test_all_angles_returned_for_complete_landmarks(self):
        lm = make_straight_leg()
        axes = self.axis_calc.calculate(lm)
        angles = self.angle_calc.calculate(axes, lm)
        for attr in ["HKA", "mLDFA", "mMPTA", "JLCA"]:
            val = getattr(angles, attr)
            assert val is not None, f"{attr} should not be None"

    def test_as_dict_keys(self):
        lm = make_straight_leg()
        axes = self.axis_calc.calculate(lm)
        angles = self.angle_calc.calculate(axes, lm)
        d = angles.as_dict()
        for key in ["HKA_deg", "mLDFA_deg", "mMPTA_deg", "JLCA_deg"]:
            assert key in d, f"Missing key {key} in as_dict()"
