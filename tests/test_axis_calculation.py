"""Unit tests for axis calculation."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))

import numpy as np
import pytest

from landmark_detection.detector import Landmarks, Point
from landmark_detection.types import DiaphysisLevel
from axis_calculation.axes import AxisCalculator


def test_femur_mechanical_axis_direction():
    """Femoral mechanical axis should point from hip toward knee (downward in image)."""
    lm = Landmarks(
        hip_center=Point(500, 100),
        knee_center=Point(500, 500),
    )
    calc = AxisCalculator()
    axes = calc.calculate(lm)
    assert axes.femur_mechanical is not None
    d = axes.femur_mechanical.direction()
    # Should point downward (positive y)
    assert d[1] > 0.9, f"Expected downward direction, got {d}"


def test_tibia_mechanical_axis_length():
    """Tibial mechanical axis length should match distance between knee and ankle."""
    lm = Landmarks(
        knee_center=Point(500, 500),
        ankle_center=Point(510, 900),
    )
    calc = AxisCalculator()
    axes = calc.calculate(lm)
    assert axes.tibia_mechanical is not None
    expected_len = np.hypot(10, 400)
    assert abs(axes.tibia_mechanical.length_px() - expected_len) < 1.0


def test_anatomical_axis_pca():
    """Anatomical axis via PCA should align with the true line direction."""
    lm = Landmarks()
    # Points along a line tilted at ~5 degrees
    pts = [Point(500 + i * 5, 100 + i * 80) for i in range(5)]
    lm.femur_diaphysis_levels = [DiaphysisLevel(medial=p, lateral=p) for p in pts]

    calc = AxisCalculator()
    axes = calc.calculate(lm)
    assert axes.femur_anatomical is not None

    d = axes.femur_anatomical.direction()
    # Expected direction: (5, 80) normalized
    expected = np.array([5, 80]) / np.hypot(5, 80)
    dot = abs(np.dot(d, expected))
    assert dot > 0.999, f"PCA axis doesn't align with input line: dot={dot}"


def test_missing_landmarks_returns_none():
    """If key landmarks are missing, corresponding axes should be None."""
    lm = Landmarks(hip_center=Point(500, 100))  # no knee, no ankle
    calc = AxisCalculator()
    axes = calc.calculate(lm)
    assert axes.femur_mechanical is None
    assert axes.tibia_mechanical is None
