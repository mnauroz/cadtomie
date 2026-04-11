"""
Angle measurement module.

HKA, mLDFA, mMPTA, JLCA — with correct side-aware sign conventions.

Side conventions  (standard AP radiology: patient right = image left)
----------------------------------------------------------------------
RIGHT leg: medial = right in image (larger x),  lateral = left  (smaller x)
LEFT  leg: medial = left  in image (smaller x), lateral = right (larger x)

HKA sign
--------
Negative = varus (mechanical axis passes medial to knee center)
Positive = valgus (mechanical axis passes lateral to knee center)

The cross-product sign that determines varus/valgus flips between legs
because "medial" is on opposite sides of the image.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Optional

import numpy as np

from axis_calculation.axes import Axis, LimbAxes
from landmark_detection.types import JointLine, Landmarks

Side = Literal["right", "left", "unknown"]


@dataclass
class DeformityAngles:
    """All calculated deformity angles for one radiograph."""

    HKA: Optional[float] = None
    mLDFA: Optional[float] = None
    mMPTA: Optional[float] = None
    JLCA: Optional[float] = None
    side: Side = "unknown"
    notes: dict[str, str] = field(default_factory=dict)

    def as_dict(self) -> dict:
        def _f(v):
            return float(round(v, 2)) if v is not None else None
        return {
            "HKA_deg":   _f(self.HKA),
            "mLDFA_deg": _f(self.mLDFA),
            "mMPTA_deg": _f(self.mMPTA),
            "JLCA_deg":  _f(self.JLCA),
            "side": self.side,
            "notes": self.notes,
        }


class AngleCalculator:
    """Derive deformity angles from axes and landmarks."""

    NORMALS = {
        "HKA":   (0.0,  3.0),
        "mLDFA": (85.0, 90.0),
        "mMPTA": (85.0, 90.0),
        "JLCA":  (0.0,  2.0),
    }

    def calculate(
        self,
        axes: LimbAxes,
        landmarks: Landmarks,
        side: Side = "unknown",
    ) -> DeformityAngles:
        da = DeformityAngles(side=side)

        if axes.femur_mechanical and axes.tibia_mechanical:
            da.HKA = self._hka(axes.femur_mechanical, axes.tibia_mechanical, side)
            da.notes["HKA"] = self._interpret_hka(da.HKA, side)

        if axes.femur_mechanical and landmarks.distal_femoral_line:
            da.mLDFA = self._mldfa(
                axes.femur_mechanical, landmarks.distal_femoral_line, side
            )
            da.notes["mLDFA"] = self._interpret("mLDFA", da.mLDFA)

        if axes.tibia_mechanical and landmarks.proximal_tibial_line:
            da.mMPTA = self._mmpta(
                axes.tibia_mechanical, landmarks.proximal_tibial_line, side
            )
            da.notes["mMPTA"] = self._interpret("mMPTA", da.mMPTA)

        if landmarks.distal_femoral_line and landmarks.proximal_tibial_line:
            da.JLCA = self._jlca(
                landmarks.distal_femoral_line, landmarks.proximal_tibial_line, side
            )
            da.notes["JLCA"] = self._interpret("JLCA", da.JLCA)

        return da

    # ------------------------------------------------------------------
    # Angle formulas
    # ------------------------------------------------------------------

    def _hka(self, femur: Axis, tibia: Axis, side: Side) -> float:
        """
        HKA = signed angle between femoral and tibial mechanical axes at the knee.

        Geometry
        --------
        We reverse the femoral axis so both vectors point away from the knee:
          d_up   = knee → hip   (femoral axis reversed)
          d_down = knee → ankle (tibial axis)

        The deviation from 180° gives the magnitude.

        Sign convention (clinical standard)
        ------------------------------------
        Negative = varus, positive = valgus — independent of leg side.

        Standard AP radiology: patient RIGHT = image LEFT.

        In image coordinates:
          Right leg: medial is to the RIGHT (+x direction)
                     varus  → ankle shifted right → cross(d_up, d_down) > 0
                     valgus → ankle shifted left  → cross(d_up, d_down) < 0
          Left  leg: medial is to the LEFT  (−x direction)
                     varus  → ankle shifted left  → cross(d_up, d_down) < 0
                     valgus → ankle shifted right → cross(d_up, d_down) > 0

        So the sign of the cross product must be flipped for left vs right legs.
        When side is unknown we keep the right-leg convention.
        """
        d_up   = -femur.direction()   # knee → hip
        d_down =  tibia.direction()   # knee → ankle

        angle_deg = np.degrees(_angle_between(d_up, d_down))
        magnitude = 180.0 - angle_deg

        cross = float(np.cross(d_up, d_down))

        if side == "right" or side == "unknown":
            # Standard AP: right leg medial = image right; varus = ankle right = cross > 0
            hka = -magnitude if cross > 0 else magnitude
        else:
            # Standard AP: left leg medial = image left; varus = ankle left = cross < 0
            hka = -magnitude if cross < 0 else magnitude

        return round(hka, 2)

    def _mldfa(self, femur_mech: Axis, distal_line: JointLine, side: Side) -> float:
        """
        mLDFA = lateral angle between femoral mechanical axis and distal femoral joint line.

        Measured in the SUPERIOR-LATERAL quadrant at the intersection:
          - superior ray of the mechanical axis  (toward hip = smaller y in AP image)
          - lateral  ray of the DFL              (toward lateral condyle)

        Both rays are determined GEOMETRICALLY, independent of which direction
        the caller's vectors happen to point:

          d_sup : flip femur_mech.direction() if it points inferiorly (y > 0).
          d_lat : JointLine.direction() = (lateral − medial)/‖…‖ always points toward
                  lateral BY DEFINITION; safety-check via _orient_joint_lines_for_side.

        Validation:
          Valgizing DFO → lateral condyle rises → DFL tilts up on lateral side
                        → angle(d_sup, d_lat) DECREASES  ✓
          Varizing  DFO → lateral condyle drops → DFL tilts down on lateral side
                        → angle(d_sup, d_lat) INCREASES  ✓

        Normal range: 85–90°.  <85° = valgus contribution, >90° = varus contribution.
        """
        # --- Ray 1: femoral axis pointing SUPERIORLY (toward hip, smaller y) ---
        d_sup = femur_mech.direction()
        if d_sup[1] > 0:          # currently pointing inferiorly (downward) → flip
            d_sup = -d_sup
        # d_sup now always points toward hip regardless of axis convention

        # --- Ray 2: DFL pointing toward LATERAL ---
        # JointLine.direction() = (lateral − medial) / ‖…‖  →  always toward lateral
        d_lat = distal_line.direction()
        # Safety: if _orient_joint_lines_for_side was not applied, correct here
        lateral_is_image_right = (side == "left")
        dfl_points_right = (distal_line.lateral.x >= distal_line.medial.x)
        if lateral_is_image_right != dfl_points_right:
            d_lat = -d_lat

        return round(np.degrees(_angle_between(d_sup, d_lat)), 2)

    def _mmpta(self, tibia_mech: Axis, prox_line: JointLine, side: Side) -> float:
        """
        mMPTA = angle between tibial mechanical axis and proximal tibial plateau,
        measured on the MEDIAL side.

        The medial angle = 180° − lateral_angle = 180° − angle_between(knee→ankle, toward_lateral).

        Standard AP radiology:
          Right leg: lateral is image-LEFT  (smaller x) → lateral.x < medial.x
          Left  leg: lateral is image-RIGHT (larger x)  → lateral.x > medial.x

        If the PTL orientation is wrong we take the supplement before subtracting
        from 180°, so we always return the medial angle.

        Result: <90° for varus tibia, 90° for neutral, >90° for valgus tibia.
        Normal: 85–90°.
        """
        axis_dir = tibia_mech.direction()   # knee → ankle (downward)
        line_dir = prox_line.direction()    # medial → lateral (when correctly oriented)
        angle = np.degrees(_angle_between(axis_dir, line_dir))

        # Ensure angle is the lateral angle first (same logic as _mldfa).
        lateral_is_image_right = (side == "left")
        ptl_points_right = (prox_line.lateral.x >= prox_line.medial.x)
        if lateral_is_image_right != ptl_points_right:
            angle = 180.0 - angle

        return round(180.0 - angle, 2)

    def _jlca(
        self,
        femoral_line: JointLine,
        tibial_line: JointLine,
        side: Side,
    ) -> float:
        """
        JLCA = convergence angle between distal femoral and proximal tibial lines.

        Positive = medial convergence (varus soft-tissue component).
        Normal: < 2°.
        """
        d1 = femoral_line.direction()
        d2 = tibial_line.direction()
        angle = np.degrees(_angle_between(d1, d2))
        if angle > 90:
            angle = 180.0 - angle

        # Sign: medial convergence = positive for varus soft tissue.
        # Standard AP: right leg medial = image right (larger x).
        # JointLine stored medial → lateral; for right leg d1/d2 point leftward (−x).
        # Medial convergence (varus) → cross(d1, d2) > 0 for right leg.
        cross = float(np.cross(d1, d2))
        if side == "right" or side == "unknown":
            signed = angle if cross >= 0 else -angle
        else:
            signed = angle if cross <= 0 else -angle

        return round(signed, 2)

    # ------------------------------------------------------------------

    def _interpret(self, name: str, value: float) -> str:
        lo, hi = self.NORMALS.get(name, (None, None))
        if lo is None:
            return "—"
        if lo <= abs(value) <= hi:
            return "Normal"
        return "Abnormal"

    def _interpret_hka(self, value: float, side: Side) -> str:
        lo, hi = self.NORMALS["HKA"]
        if abs(value) <= hi:
            return "Normal"
        direction = "Varus" if value < 0 else "Valgus"
        side_label = {"right": " rechts", "left": " links", "unknown": ""}.get(side, "")
        return f"{direction}{side_label}"


# ------------------------------------------------------------------
# Geometry utilities
# ------------------------------------------------------------------

def _angle_between(v1: np.ndarray, v2: np.ndarray) -> float:
    """Angle in radians between two 2-D vectors, in [0, π]."""
    cos_theta = np.clip(
        np.dot(v1, v2) / (np.linalg.norm(v1) * np.linalg.norm(v2) + 1e-9),
        -1.0,
        1.0,
    )
    return float(np.arccos(cos_theta))
