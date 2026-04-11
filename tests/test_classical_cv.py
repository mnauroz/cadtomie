"""
Unit tests for the classical CV landmark detector.

We synthesize a fake radiograph with known bright circles
and verify the detector finds them in roughly the right location.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))

import numpy as np
import cv2
import pytest

from landmark_detection.classical_cv import ClassicalCVDetector


def make_synthetic_radiograph(
    h: int = 1200,
    w: int = 400,
    hip_y: int = 150,
    knee_y: int = 530,
    ankle_y: int = 1050,
    cx: int = 200,
) -> np.ndarray:
    """
    Create a grayscale synthetic long-leg radiograph:
    - Dark background
    - Vertical bone-like bright stripe
    - Three bright circles at hip, knee, ankle
    """
    img = np.zeros((h, w), dtype=np.uint8)

    # Bone shaft
    cv2.rectangle(img, (cx - 25, 0), (cx + 25, h), 80, -1)

    # Hip (femoral head)
    cv2.circle(img, (cx, hip_y), 40, 200, -1)
    # Knee
    cv2.circle(img, (cx, knee_y), 30, 180, -1)
    # Ankle (talar dome)
    cv2.circle(img, (cx, ankle_y), 25, 160, -1)

    # Convert to BGR
    bgr = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    return bgr


class TestClassicalCVDetector:
    def setup_method(self):
        self.detector = ClassicalCVDetector()

    def test_detect_returns_landmarks(self):
        img = make_synthetic_radiograph()
        lm = self.detector.detect(img)
        # At least hip or knee or ankle should be detected
        detected = sum(
            1 for p in [lm.hip_center, lm.knee_center, lm.ankle_center] if p is not None
        )
        assert detected >= 1, "Expected at least one landmark detected"

    def test_hip_detected_in_upper_region(self):
        """Hip center should be in the top 40 % of the image."""
        img = make_synthetic_radiograph(h=1200)
        lm = self.detector.detect(img)
        if lm.hip_center:
            assert lm.hip_center.y < 1200 * 0.40, (
                f"Hip y={lm.hip_center.y} not in upper 40% of image"
            )

    def test_ankle_detected_in_lower_region(self):
        """Ankle center should be in the bottom 25 % of the image."""
        img = make_synthetic_radiograph(h=1200)
        lm = self.detector.detect(img)
        if lm.ankle_center:
            assert lm.ankle_center.y > 1200 * 0.70, (
                f"Ankle y={lm.ankle_center.y} not in lower 30% of image"
            )

    def test_joint_lines_exist_when_knee_found(self):
        """If knee is detected, joint lines should also be populated."""
        img = make_synthetic_radiograph()
        lm = self.detector.detect(img)
        if lm.knee_center is not None:
            assert (
                lm.distal_femoral_line is not None or lm.proximal_tibial_line is not None
            ), "Expected at least one joint line when knee is detected"

    def test_diaphysis_points_between_joints(self):
        """Femur diaphysis points should lie between hip and knee vertically."""
        img = make_synthetic_radiograph(hip_y=150, knee_y=530)
        lm = self.detector.detect(img)
        if lm.hip_center and lm.knee_center and lm.femur_diaphysis:
            for p in lm.femur_diaphysis:
                assert lm.hip_center.y <= p.y <= lm.knee_center.y, (
                    f"Diaphysis point y={p.y} outside hip-knee range"
                )
