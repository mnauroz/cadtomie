"""
Osteotomy planning geometry engine — pure functions, no I/O.

Architecture
------------
The authoritative pipeline (same principle as mediCAD):

  recompute(plan, lm):
    1. miniaci_angle()        — optimal correction from geometry
    2. _transform_landmarks() — rotate ONLY the moving segment
    3. AxisCalculator         — rebuild ALL axes from new landmarks
    4. AngleCalculator        — recompute ALL angles from rebuilt axes
    5. store HKA / mMPTA / mLDFA back into plan

This ensures post-osteotomy angles are computed by the *same code path*
as the pre-osteotomy baseline — eliminating every reference-point and
sign inconsistency.

Segmentation
------------
HTO — FIXED:  hip, knee, DFL, PTL
      MOVING: ankle, tibia diaphysis levels

DFO — FIXED:  hip, ankle, PTL
      MOVING: knee, DFL, femur diaphysis levels

Coordinate system: image coords (x right, y DOWN).
Positive rotation angle = clockwise in image.
"""
from __future__ import annotations

import logging
import math
from typing import Optional

import numpy as np

from landmark_detection.types import DiaphysisLevel, JointLine, Landmarks, Point
from axis_calculation.axes import AxisCalculator
from angle_measurement.angles import AngleCalculator
from .types import OstLine, OsteotomyKind, Plan


_logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Primitive geometry
# ---------------------------------------------------------------------------

def rotate_point(p: Point, hinge: Point, angle_deg: float) -> Point:
    """Rotate *p* around *hinge* by *angle_deg* (positive = CW, y-down)."""
    rad = math.radians(angle_deg)
    dx = p.x - hinge.x
    dy = p.y - hinge.y
    return Point(
        x=math.cos(rad) * dx - math.sin(rad) * dy + hinge.x,
        y=math.sin(rad) * dx + math.cos(rad) * dy + hinge.y,
    )


def _angle_between(v1: np.ndarray, v2: np.ndarray) -> float:
    """Angle in radians in [0, π]."""
    cos_t = float(np.clip(
        np.dot(v1, v2) / (np.linalg.norm(v1) * np.linalg.norm(v2) + 1e-9),
        -1.0, 1.0,
    ))
    return math.acos(cos_t)


def _angle_between_deg(v1: np.ndarray, v2: np.ndarray) -> float:
    return math.degrees(_angle_between(v1, v2))


# ---------------------------------------------------------------------------
# Miniaci correction angle
# ---------------------------------------------------------------------------

def miniaci_angle(
    hip: Point,
    moving_pt: Point,
    hinge: Point,
    target: Point,
) -> float:
    """
    Signed correction angle (degrees) to rotate *moving_pt* around *hinge*
    so that the line (hip → new_moving_pt) passes through *target*.

    For HTO pass ankle as *moving_pt*; for DFO pass knee.

    Returns 0.0 for degenerate or geometrically unreachable cases.
    The returned sign IS the correct physical rotation direction.
    """
    vx = moving_pt.x - hinge.x
    vy = moving_pt.y - hinge.y
    r = math.hypot(vx, vy)
    if r < 1e-6:
        return 0.0

    alpha = math.atan2(vy, vx)

    tx = target.x - hip.x
    ty = target.y - hip.y
    t_len = math.hypot(tx, ty)
    if t_len < 1e-6:
        return 0.0

    c = (hinge.x - hip.x) * ty - (hinge.y - hip.y) * tx
    K = -c / (r * t_len)
    if abs(K) > 1.0:
        return 0.0

    phi = math.atan2(tx, ty)

    def _norm(a: float) -> float:
        while a > math.pi:
            a -= 2 * math.pi
        while a <= -math.pi:
            a += 2 * math.pi
        return a

    s1 = _norm(math.acos(K) - alpha - phi)
    s2 = _norm(-math.acos(K) - alpha - phi)
    return math.degrees(s1 if abs(s1) <= abs(s2) else s2)


# ---------------------------------------------------------------------------
# Auto-placement helpers
# ---------------------------------------------------------------------------

def _hto_placer(
    lm: Landmarks, hinge_side: str, target_pct: float,
) -> tuple[Optional[OstLine], Optional[Point], Optional[Point]]:
    """Generic HTO placer.  hinge_side: 'lateral' or 'medial'."""
    ptl = lm.proximal_tibial_line
    if not ptl:
        return None, None, None
    ost = OstLine(
        p1=Point(ptl.medial.x, ptl.medial.y + 30),
        p2=Point(ptl.lateral.x, ptl.lateral.y + 30),
    )
    hinge = Point(
        ptl.lateral.x if hinge_side == "lateral" else ptl.medial.x,
        ptl.lateral.y + 30 if hinge_side == "lateral" else ptl.medial.y + 30,
    )
    target = Point(
        ptl.medial.x + (ptl.lateral.x - ptl.medial.x) * target_pct,
        ptl.medial.y + (ptl.lateral.y - ptl.medial.y) * target_pct,
    )
    return ost, hinge, target


def _dfo_placer(
    lm: Landmarks, hinge_side: str, target_pct: float,
) -> tuple[Optional[OstLine], Optional[Point], Optional[Point]]:
    """Generic DFO placer.  hinge_side: 'lateral' or 'medial'.

    The Miniaci target for DFO must be on the PROXIMAL TIBIAL LINE (not the
    DFL), because the Miniaci formula uses the ankle as the rotating point
    and requires the target to be far from the hinge (ankle is ~600 px below
    the femoral hinge; the DFL is only ~30 px away from the hinge → K >> 1
    → algorithm would return 0°).
    """
    dfl = lm.distal_femoral_line
    if not dfl:
        return None, None, None
    ost = OstLine(
        p1=Point(dfl.medial.x, dfl.medial.y - 30),
        p2=Point(dfl.lateral.x, dfl.lateral.y - 30),
    )
    hinge = Point(
        dfl.lateral.x if hinge_side == "lateral" else dfl.medial.x,
        dfl.lateral.y - 30 if hinge_side == "lateral" else dfl.medial.y - 30,
    )
    # Target on PTL (Fujisawa point) — far enough from hinge for Miniaci to work.
    ptl = lm.proximal_tibial_line
    if ptl:
        target = Point(
            ptl.medial.x + (ptl.lateral.x - ptl.medial.x) * target_pct,
            ptl.medial.y + (ptl.lateral.y - ptl.medial.y) * target_pct,
        )
    else:
        # Fallback if PTL not yet detected: offset below DFL midpoint
        mid_y = (dfl.medial.y + dfl.lateral.y) / 2
        target = Point(
            dfl.medial.x + (dfl.lateral.x - dfl.medial.x) * target_pct,
            mid_y + 60,
        )
    return ost, hinge, target


import functools as _ft

_PLACERS: dict = {
    # Valgisierend (target 62.5 % = Fujisawa-Punkt: leicht lateral)
    "HTO_OPEN_MED":  _ft.partial(_hto_placer, hinge_side="lateral", target_pct=0.625),
    "HTO_CLOSE_LAT": _ft.partial(_hto_placer, hinge_side="medial",  target_pct=0.625),
    "DFO_CLOSE_LAT": _ft.partial(_dfo_placer, hinge_side="medial",  target_pct=0.625),
    "DFO_CLOSE_MED": _ft.partial(_dfo_placer, hinge_side="lateral", target_pct=0.625),
    # Varisierend (target 37.5 % = leicht medial)
    "HTO_CLOSE_MED": _ft.partial(_hto_placer, hinge_side="lateral", target_pct=0.375),
    "DFO_OPEN_LAT":  _ft.partial(_dfo_placer, hinge_side="medial",  target_pct=0.375),
    "DFO_OPEN_MED":  _ft.partial(_dfo_placer, hinge_side="lateral", target_pct=0.375),
}


def auto_plan(lm: Landmarks, kind: OsteotomyKind) -> Plan:
    """Create a Plan with auto-placed geometry and computed Miniaci angle."""
    plan = Plan(kind=kind)
    ost, hinge, target = _PLACERS[kind](lm)
    plan.osteotomy_line = ost
    plan.hinge_point = hinge
    plan.target_point = target
    return plan


# ---------------------------------------------------------------------------
# Wedge size
# ---------------------------------------------------------------------------

def wedge_size_mm(
    ost: OstLine,
    hinge: Point,
    correction_deg: float,
    px_spacing: float,
) -> float:
    """Gap between original and rotated free end of osteotomy line, in mm."""
    d1 = math.hypot(ost.p1.x - hinge.x, ost.p1.y - hinge.y)
    d2 = math.hypot(ost.p2.x - hinge.x, ost.p2.y - hinge.y)
    free = ost.p1 if d1 >= d2 else ost.p2
    rotated = rotate_point(free, hinge, correction_deg)
    gap_px = math.hypot(rotated.x - free.x, rotated.y - free.y)
    return round(gap_px * px_spacing, 1)


# ---------------------------------------------------------------------------
# Landmark transformation (core of the pipeline)
# ---------------------------------------------------------------------------

def _transform_landmarks(
    lm: Landmarks,
    kind: OsteotomyKind,
    hinge: Point,
    angle_deg: float,
) -> Landmarks:
    """
    Return a new Landmarks with the moving-segment points rotated around
    *hinge* by *angle_deg*.  Every landmark belongs to exactly one segment.

    HTO — FIXED:  hip_center, knee_center, distal_femoral_line,
                  proximal_tibial_line, femur_diaphysis_levels
          MOVING: ankle_center, tibia_diaphysis_levels

    DFO — FIXED:  hip_center, proximal femur diaphysis (above hinge)
          MOVING: knee_center, distal_femoral_line, femur_diaphysis_levels,
                  proximal_tibial_line, tibia_diaphysis_levels, ankle_center

    The entire distal chain (everything from the hinge downward) must move
    together so that hip → new_ankle remains a single straight mechanical
    axis with no kink at the knee.  Leaving ankle fixed would leave the
    tibial segment in the original coordinate frame and produce a bent axis.
    """
    def rot(p: Point) -> Point:
        return rotate_point(p, hinge, angle_deg)

    if kind.startswith("HTO"):
        return Landmarks(
            hip_center           = lm.hip_center,
            knee_center          = lm.knee_center,
            distal_femoral_line  = lm.distal_femoral_line,
            proximal_tibial_line = lm.proximal_tibial_line,
            ankle_center         = rot(lm.ankle_center) if lm.ankle_center else None,
            femur_diaphysis_levels = lm.femur_diaphysis_levels,
            tibia_diaphysis_levels = [
                DiaphysisLevel(medial=rot(lvl.medial), lateral=rot(lvl.lateral))
                for lvl in lm.tibia_diaphysis_levels
            ],
            confidence = dict(lm.confidence),
        )

    # DFO — rotate the entire distal chain (knee + DFL + PTL + tibia + ankle)
    new_dfl = None
    if lm.distal_femoral_line:
        new_dfl = JointLine(
            medial  = rot(lm.distal_femoral_line.medial),
            lateral = rot(lm.distal_femoral_line.lateral),
        )
    new_ptl = None
    if lm.proximal_tibial_line:
        new_ptl = JointLine(
            medial  = rot(lm.proximal_tibial_line.medial),
            lateral = rot(lm.proximal_tibial_line.lateral),
        )
    # For the femoral anatomical axis: only keep proximal levels (above hinge,
    # y < hinge.y in image coords) as fixed.  Distal levels belong to the
    # moving fragment and would create a kinked anatomical axis if mixed with
    # the proximal ones.  They are not needed for mLDFA (which uses hip→knee).
    proximal_femur_levels = [
        lvl for lvl in lm.femur_diaphysis_levels
        if lvl.midpoint().y <= hinge.y
    ]
    return Landmarks(
        hip_center           = lm.hip_center,
        knee_center          = rot(lm.knee_center) if lm.knee_center else None,
        distal_femoral_line  = new_dfl,
        proximal_tibial_line = new_ptl,
        ankle_center         = rot(lm.ankle_center) if lm.ankle_center else None,
        femur_diaphysis_levels = proximal_femur_levels,
        tibia_diaphysis_levels = [
            DiaphysisLevel(medial=rot(lvl.medial), lateral=rot(lvl.lateral))
            for lvl in lm.tibia_diaphysis_levels
        ],
        confidence = dict(lm.confidence),
    )


# ---------------------------------------------------------------------------
# Standalone analytic helpers (kept for direct unit-test access)
# ---------------------------------------------------------------------------
# These implement the same geometry as the pipeline but analytically.
# recompute() does NOT use them — it runs the full pipeline instead.

def _corrected_hka_vecs(
    d_up: np.ndarray,
    d_dn: np.ndarray,
    side: str,
) -> float:
    # Standard AP: right leg varus = ankle to image right = cross > 0 → negative HKA
    mag = 180.0 - math.degrees(_angle_between(d_up, d_dn))
    cross = float(np.cross(d_up, d_dn))
    if side == "left":
        return round(-mag if cross < 0 else mag, 2)
    return round(-mag if cross > 0 else mag, 2)


def corrected_hka(
    hip: Point,
    knee: Point,
    ankle: Point,
    hinge: Point,
    correction_deg: float,
    kind: OsteotomyKind,
    side: str = "unknown",
) -> float:
    if kind.startswith("HTO"):
        new_ankle = rotate_point(ankle, hinge, correction_deg)
        fvec = np.array([knee.x - hip.x, knee.y - hip.y], dtype=float)
        tvec = np.array([new_ankle.x - knee.x, new_ankle.y - knee.y], dtype=float)
    else:  # DFO
        new_knee = rotate_point(knee, hinge, correction_deg)
        fvec = np.array([new_knee.x - hip.x, new_knee.y - hip.y], dtype=float)
        tvec = np.array([ankle.x - new_knee.x, ankle.y - new_knee.y], dtype=float)

    d_up = -fvec / (np.linalg.norm(fvec) + 1e-9)
    d_dn =  tvec / (np.linalg.norm(tvec) + 1e-9)
    return _corrected_hka_vecs(d_up, d_dn, side)


def corrected_mmpta(
    ankle: Point,
    hinge: Point,
    correction_deg: float,
    ptl: JointLine,
    side: str = "unknown",
) -> float:
    """Analytic corrected mMPTA helper (used in direct unit tests)."""
    new_ankle = rotate_point(ankle, hinge, correction_deg)
    ptl_mid_x = (ptl.medial.x + ptl.lateral.x) / 2
    ptl_mid_y = (ptl.medial.y + ptl.lateral.y) / 2
    axis = np.array([new_ankle.x - ptl_mid_x, new_ankle.y - ptl_mid_y], dtype=float)
    line = np.array([ptl.lateral.x - ptl.medial.x, ptl.lateral.y - ptl.medial.y], dtype=float)
    angle = _angle_between_deg(axis, line)
    if angle > 90:
        angle = 180.0 - angle
    if side == "left":
        angle = 180.0 - angle
        if angle > 90:
            angle = 180.0 - angle
    return round(angle, 2)


def corrected_mldfa(
    hip: Point,
    hinge: Point,
    correction_deg: float,
    dfl: JointLine,
    side: str = "unknown",
) -> float:
    """Analytic corrected mLDFA helper (used in direct unit tests)."""
    new_dfl_m = rotate_point(dfl.medial, hinge, correction_deg)
    new_dfl_l = rotate_point(dfl.lateral, hinge, correction_deg)
    new_dfl_mid_x = (new_dfl_m.x + new_dfl_l.x) / 2
    new_dfl_mid_y = (new_dfl_m.y + new_dfl_l.y) / 2
    axis = np.array([new_dfl_mid_x - hip.x, new_dfl_mid_y - hip.y], dtype=float)
    line = np.array([new_dfl_l.x - new_dfl_m.x, new_dfl_l.y - new_dfl_m.y], dtype=float)
    angle = _angle_between_deg(axis, line)
    if angle > 90:
        angle = 180.0 - angle
    if side == "left":
        angle = 180.0 - angle
        if angle > 90:
            angle = 180.0 - angle
    return round(angle, 2)


# ---------------------------------------------------------------------------
# Main pipeline — recompute all derived plan fields
# ---------------------------------------------------------------------------

def recompute(
    plan: Plan,
    lm: Landmarks,
    px_spacing: float = 1.0,
    side: str = "unknown",
) -> Optional["DeformityAngles"]:  # type: ignore[name-defined]
    """
    Update all derived plan fields in-place using the full pipeline:

      miniaci_angle → _transform_landmarks → AxisCalculator → AngleCalculator

    Returns the full DeformityAngles computed from the transformed landmarks
    (or None when correction_deg is 0 / geometry is incomplete).

    This is the single authoritative path for post-osteotomy angles.
    All corrected values (HKA, mMPTA, mLDFA) are computed by the same
    formulas used for the pre-osteotomy baseline, just on transformed
    landmarks — guaranteeing consistent sign and reference conventions.
    """
    from angle_measurement.angles import DeformityAngles as _DA  # noqa: F401
    hip   = lm.hip_center
    knee  = lm.knee_center
    ankle = lm.ankle_center

    _logger.debug(
        "recompute PRE  kind=%s cdeg=%.2f  hip=%s knee=%s ankle=%s",
        plan.kind, plan.correction_deg, hip, knee, ankle,
    )

    # ── 1. Miniaci angle ──────────────────────────────────────────────────
    # HTO: ankle is the rotating point (distal tibial fragment).
    # DFO: ankle is ALSO the rotating point for the Miniaci formula.
    #   Reason: the entire distal chain (knee + ankle) rotates by the same
    #   angle θ around the femoral hinge. The target Mikulicz line is
    #   hip→new_ankle. Using the knee as rotating point gives r ≈ 0
    #   (knee is close to the hinge) → K >> 1 → algorithm returns 0°.
    #   Using ankle gives r ≈ 600+ px → K << 1 → correct signed angle.
    if plan.kind.startswith("HTO") and all([hip, ankle, plan.hinge_point, plan.target_point]):
        plan.miniaci_deg = round(
            miniaci_angle(hip, ankle, plan.hinge_point, plan.target_point), 2  # type: ignore[arg-type]
        )
    elif plan.kind.startswith("DFO") and all([hip, ankle, plan.hinge_point, plan.target_point]):
        plan.miniaci_deg = round(
            miniaci_angle(hip, ankle, plan.hinge_point, plan.target_point), 2  # type: ignore[arg-type]
        )
    else:
        plan.miniaci_deg = None

    # ── Early exit when no active correction ─────────────────────────────
    if plan.correction_deg == 0.0 or not plan.hinge_point:
        plan.wedge_mm        = None
        plan.corrected_hka   = None
        plan.corrected_mmpta = None
        plan.corrected_mldfa = None
        return None

    cdeg = plan.correction_deg

    # ── 2. Wedge size (geometry-only, no axis rebuild needed) ─────────────
    if plan.osteotomy_line:
        plan.wedge_mm = wedge_size_mm(plan.osteotomy_line, plan.hinge_point, cdeg, px_spacing)

    # ── 3. Transform: rotate moving-segment landmarks ────────────────────
    transformed = _transform_landmarks(lm, plan.kind, plan.hinge_point, cdeg)

    _logger.debug(
        "recompute XFRM kind=%s cdeg=%.2f  new_ankle=%s new_knee=%s",
        plan.kind, cdeg,
        transformed.ankle_center,
        transformed.knee_center,
    )

    # ── 4. Rebuild: derive ALL axes from updated landmarks ────────────────
    axes = AxisCalculator().calculate(transformed)

    # ── 5. Recalculate: ALL angles from rebuilt axes ──────────────────────
    da = AngleCalculator().calculate(axes, transformed, side)

    plan.corrected_hka = da.HKA

    if plan.kind.startswith("HTO"):
        plan.corrected_mmpta = da.mMPTA
        plan.corrected_mldfa = None
    else:
        plan.corrected_mldfa = da.mLDFA
        plan.corrected_mmpta = None

    _logger.debug(
        "recompute POST kind=%s cdeg=%.2f  HKA=%s mMPTA=%s mLDFA=%s",
        plan.kind, cdeg,
        plan.corrected_hka,
        plan.corrected_mmpta,
        plan.corrected_mldfa,
    )
    return da
