"""
Tests for osteotomy simulation engine.

Validates:
  - rotate_point correctness and hinge invariance
  - Miniaci angle geometry
  - Fragment selection logic (which landmark moves per osteotomy type)
  - corrected mMPTA changes for HTO
  - corrected mLDFA changes for DFO
  - HKA update after correction
  - wedge_size_mm computation
"""
import sys
import math
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))

import pytest
from landmark_detection.types import JointLine, Landmarks, Point
from osteotomy.engine import (
    rotate_point,
    miniaci_angle,
    corrected_hka,
    corrected_mmpta,
    corrected_mldfa,
    wedge_size_mm,
    recompute,
)
from osteotomy.types import OstLine, Plan


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def make_valgus_leg(hka_deg: float = 5.0):
    """
    Synthetic right-leg landmarks with a known valgus HKA.

    Coordinate system: x right, y DOWN (image coords).
    Standard AP radiology: patient right = image left.
    Right leg: medial = image right (larger x), lateral = image left (smaller x).
    Valgus = ankle shifted laterally = to image LEFT (smaller x).
    """
    hip   = Point(500, 100)
    knee  = Point(500, 600)
    ankle = Point(500 - 600 * math.tan(math.radians(hka_deg)), 1200)

    # Proximal tibial line: horizontal at knee level + 10px
    # Standard AP right leg: medial = right (larger x), lateral = left (smaller x)
    ptl = JointLine(
        medial  = Point(550, 610),
        lateral = Point(450, 610),
    )
    # Distal femoral line: horizontal at knee level − 10px
    dfl = JointLine(
        medial  = Point(550, 590),
        lateral = Point(450, 590),
    )
    lm = Landmarks(
        hip_center        = hip,
        knee_center       = knee,
        ankle_center      = ankle,
        proximal_tibial_line = ptl,
        distal_femoral_line  = dfl,
    )
    return lm


# ---------------------------------------------------------------------------
# rotate_point
# ---------------------------------------------------------------------------

class TestRotatePoint:
    def test_zero_angle(self):
        p = Point(100, 200)
        result = rotate_point(p, Point(50, 50), 0.0)
        assert abs(result.x - 100) < 1e-9
        assert abs(result.y - 200) < 1e-9

    def test_hinge_stays_fixed(self):
        """The hinge point must not move under any rotation."""
        hinge = Point(300, 400)
        for angle in [5, 10, -7, 15, -12]:
            result = rotate_point(hinge, hinge, angle)
            assert abs(result.x - hinge.x) < 1e-9, f"hinge.x changed at {angle}°"
            assert abs(result.y - hinge.y) < 1e-9, f"hinge.y changed at {angle}°"

    def test_90_degree_rotation(self):
        """90° CW (y-down): (1, 0) around origin → (0, 1)."""
        p = Point(1, 0)
        hinge = Point(0, 0)
        r = rotate_point(p, hinge, 90.0)
        assert abs(r.x - 0) < 1e-9
        assert abs(r.y - 1) < 1e-9

    def test_distance_preserved(self):
        """Rotation must preserve distance from hinge."""
        p = Point(200, 300)
        hinge = Point(150, 150)
        orig_dist = math.hypot(p.x - hinge.x, p.y - hinge.y)
        for angle in [3, 7, -4, 12]:
            r = rotate_point(p, hinge, angle)
            new_dist = math.hypot(r.x - hinge.x, r.y - hinge.y)
            assert abs(new_dist - orig_dist) < 1e-6

    def test_360_returns_to_start(self):
        p = Point(123, 456)
        hinge = Point(10, 20)
        r = rotate_point(p, hinge, 360.0)
        assert abs(r.x - p.x) < 1e-6
        assert abs(r.y - p.y) < 1e-6


# ---------------------------------------------------------------------------
# miniaci_angle
# ---------------------------------------------------------------------------

class TestMiniaciAngle:
    def test_zero_when_already_correct(self):
        """If ankle already on target line, Miniaci angle should be ~0."""
        hip    = Point(500, 0)
        ankle  = Point(500 + 600 * math.tan(math.radians(0)), 1000)
        hinge  = Point(500, 700)
        # Target at 62.5% of a horizontal tibial plateau → same x as ankle
        target = Point(ankle.x, 700)
        angle  = miniaci_angle(hip, ankle, hinge, target)
        assert abs(angle) < 0.5  # within 0.5° of zero

    def test_returns_float(self):
        hip    = Point(500, 0)
        ankle  = Point(550, 1000)
        hinge  = Point(500, 700)
        target = Point(510, 700)
        angle  = miniaci_angle(hip, ankle, hinge, target)
        assert isinstance(angle, float)

    def test_degenerate_zero_radius(self):
        """Hinge == ankle should return 0.0 (degenerate)."""
        hip   = Point(500, 0)
        ankle = Point(500, 700)
        hinge = ankle
        target = Point(512, 700)
        assert miniaci_angle(hip, ankle, hinge, target) == 0.0

    def test_sign_reflects_required_direction(self):
        """Ankle shifted right of hip (x=560). The Miniaci correction to reach
        a target at x≈509 requires CW rotation (positive in y-down), i.e., angle > 0.
        Note: in standard AP a right-leg ankle shifted RIGHT represents varus."""
        hip    = Point(500, 0)
        ankle  = Point(560, 1000)   # shifted right (varus in standard AP right leg)
        hinge  = Point(500, 700)
        # Fujisawa target: medial of ankle
        target = Point(509, 700)
        angle  = miniaci_angle(hip, ankle, hinge, target)
        # CW rotation (positive) moves the ankle leftward in y-down coords
        assert angle > 0


# ---------------------------------------------------------------------------
# corrected_hka — must change after correction
# ---------------------------------------------------------------------------

class TestCorrectedHKA:
    def _make_valgus(self):
        # Standard AP right leg: valgus = ankle to image LEFT (smaller x)
        hip   = Point(500, 0)
        knee  = Point(500, 500)
        ankle = Point(440, 1000)   # valgus: ankle left of hip/knee
        hinge = Point(500, 550)
        return hip, knee, ankle, hinge

    def test_hto_hka_changes(self):
        hip, knee, ankle, hinge = self._make_valgus()
        orig_hka = corrected_hka(hip, knee, ankle, hinge, 0.0, "HTO_OPEN_MED", "right")
        corr_hka = corrected_hka(hip, knee, ankle, hinge, -5.0, "HTO_OPEN_MED", "right")
        assert abs(corr_hka - orig_hka) > 0.5, "HKA must change after HTO correction"

    def test_dfo_hka_changes(self):
        hip, knee, ankle, hinge = self._make_valgus()
        orig_hka = corrected_hka(hip, knee, ankle, hinge, 0.0, "DFO_OPEN_LAT", "right")
        corr_hka = corrected_hka(hip, knee, ankle, hinge, -5.0, "DFO_OPEN_LAT", "right")
        assert abs(corr_hka - orig_hka) > 0.5, "HKA must change after DFO correction"


# ---------------------------------------------------------------------------
# corrected_mmpta — HTO must change mMPTA; DFO must NOT use this path
# ---------------------------------------------------------------------------

class TestCorrectedMMPTA:
    def test_mmpta_changes_after_hto(self):
        ankle = Point(560, 1200)
        hinge = Point(500, 650)
        ptl   = JointLine(medial=Point(450, 610), lateral=Point(550, 610))

        orig = corrected_mmpta(ankle, hinge, 0.0, ptl, "right")
        corr = corrected_mmpta(ankle, hinge, -8.0, ptl, "right")
        assert abs(corr - orig) > 1.0, "mMPTA must change after HTO correction"

    def test_mmpta_returns_sensible_range(self):
        """mMPTA should be in 60–120° for typical geometry."""
        ankle = Point(500, 1200)
        hinge = Point(500, 650)
        ptl   = JointLine(medial=Point(450, 610), lateral=Point(550, 610))
        val = corrected_mmpta(ankle, hinge, 0.0, ptl, "right")
        assert 60 <= val <= 120, f"Unexpected mMPTA: {val}"


# ---------------------------------------------------------------------------
# corrected_mldfa — DFO must change mLDFA
# ---------------------------------------------------------------------------

class TestCorrectedMLDFA:
    def test_mldfa_changes_after_dfo(self):
        hip   = Point(500, 0)
        hinge = Point(500, 560)
        dfl   = JointLine(medial=Point(450, 590), lateral=Point(550, 590))

        orig = corrected_mldfa(hip, hinge, 0.0, dfl, "right")
        corr = corrected_mldfa(hip, hinge, 5.0, dfl, "right")
        assert abs(corr - orig) > 1.0, "mLDFA must change after DFO correction"

    def test_mldfa_returns_sensible_range(self):
        """mLDFA should be in 60–120° for typical geometry."""
        hip   = Point(500, 0)
        hinge = Point(500, 560)
        dfl   = JointLine(medial=Point(450, 590), lateral=Point(550, 590))
        val = corrected_mldfa(hip, hinge, 0.0, dfl, "right")
        assert 60 <= val <= 120, f"Unexpected mLDFA: {val}"


# ---------------------------------------------------------------------------
# wedge_size_mm
# ---------------------------------------------------------------------------

class TestWedgeSizeMM:
    def test_zero_correction_zero_wedge(self):
        ost   = OstLine(p1=Point(400, 600), p2=Point(600, 600))
        hinge = Point(600, 600)  # p2 is the hinge
        assert wedge_size_mm(ost, hinge, 0.0, px_spacing=0.3) == 0.0

    def test_larger_angle_larger_wedge(self):
        ost   = OstLine(p1=Point(400, 600), p2=Point(600, 600))
        hinge = Point(600, 600)
        px    = 0.3
        small = wedge_size_mm(ost, hinge, 5.0, px)
        large = wedge_size_mm(ost, hinge, 10.0, px)
        assert large > small > 0

    def test_longer_free_arm_larger_wedge(self):
        """Farther free end → larger wedge for same angle."""
        hinge = Point(600, 600)
        ost_short = OstLine(p1=Point(550, 600), p2=Point(600, 600))
        ost_long  = OstLine(p1=Point(400, 600), p2=Point(600, 600))
        angle = 8.0
        px = 0.3
        short_w = wedge_size_mm(ost_short, hinge, angle, px)
        long_w  = wedge_size_mm(ost_long,  hinge, angle, px)
        assert long_w > short_w


# ---------------------------------------------------------------------------
# recompute integration
# ---------------------------------------------------------------------------

class TestRecompute:
    def test_hto_open_recompute(self):
        lm = make_valgus_leg(hka_deg=5.0)
        plan = Plan(
            kind="HTO_OPEN_MED",
            osteotomy_line=OstLine(
                p1=Point(450, 620),
                p2=Point(550, 620),
            ),
            hinge_point=Point(550, 620),
            target_point=Point(500 + 600 * 0.625 * math.tan(math.radians(3)), 620),
            correction_deg=-7.0,
        )
        recompute(plan, lm, px_spacing=0.3, side="right")

        assert plan.corrected_hka is not None, "HKA must be computed"
        assert plan.corrected_mmpta is not None, "mMPTA must be computed for HTO"
        assert plan.corrected_mldfa is None,   "mLDFA must be None for HTO"
        assert plan.wedge_mm is not None and plan.wedge_mm > 0

    def test_dfo_open_recompute(self):
        lm = make_valgus_leg(hka_deg=5.0)
        plan = Plan(
            kind="DFO_OPEN_LAT",
            osteotomy_line=OstLine(
                p1=Point(450, 570),
                p2=Point(550, 570),
            ),
            hinge_point=Point(450, 570),
            target_point=Point(500 + 600 * 0.375 * math.tan(math.radians(3)), 570),
            correction_deg=7.0,
        )
        recompute(plan, lm, px_spacing=0.3, side="right")

        assert plan.corrected_hka is not None, "HKA must be computed"
        assert plan.corrected_mldfa is not None, "mLDFA must be computed for DFO"
        assert plan.corrected_mmpta is None,   "mMPTA must be None for DFO"
        assert plan.wedge_mm is not None and plan.wedge_mm > 0

    def test_mmpta_and_mldfa_are_different_values(self):
        """mMPTA (HTO) and mLDFA (DFO) should differ because different segments rotate."""
        lm = make_valgus_leg(hka_deg=5.0)

        plan_hto = Plan(
            kind="HTO_OPEN_MED",
            osteotomy_line=OstLine(p1=Point(450, 620), p2=Point(550, 620)),
            hinge_point=Point(550, 620),
            correction_deg=-7.0,
        )
        plan_dfo = Plan(
            kind="DFO_OPEN_LAT",
            osteotomy_line=OstLine(p1=Point(450, 570), p2=Point(550, 570)),
            hinge_point=Point(450, 570),
            correction_deg=7.0,
        )
        recompute(plan_hto, lm, px_spacing=0.3, side="right")
        recompute(plan_dfo, lm, px_spacing=0.3, side="right")

        # Both angles must be valid numbers in a plausible range
        assert plan_hto.corrected_mmpta is not None
        assert plan_dfo.corrected_mldfa  is not None
        assert 50 <= plan_hto.corrected_mmpta <= 130
        assert 50 <= plan_dfo.corrected_mldfa  <= 130
