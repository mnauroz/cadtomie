"""Osteotomy planning data model."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Optional

from landmark_detection.types import Point

# Seven clinically distinct osteotomy variants
# HTO = High Tibial Osteotomy, DFO = Distal Femoral Osteotomy
# Naming: <bone>_<OPEN|CLOSE>_<MED|LAT> = which side opens/closes
OsteotomyKind = Literal[
    # Valgisierend (korrigiert Varus → bewegt HKA Richtung Valgus)
    "HTO_OPEN_MED",   # HTO medial-öffnend     (hinge lateral) — korrigiert tibiales Varus
    "HTO_CLOSE_LAT",  # HTO lateral-schließend (hinge medial)  — korrigiert tibiales Varus
    "DFO_CLOSE_LAT",  # DFO lateral-schließend (hinge medial)  — valgisierende DFO
    "DFO_CLOSE_MED",  # DFO medial-schließend  (hinge lateral) — korrigiert femorales Varus
    # Varisierend (korrigiert Valgus → bewegt HKA Richtung Varus)
    "HTO_CLOSE_MED",  # HTO medial-schließend  (hinge lateral) — korrigiert tibiales Valgus
    "DFO_OPEN_LAT",   # DFO lateral-öffnend    (hinge medial)  — varisierende DFO
    "DFO_OPEN_MED",   # DFO medial-öffnend     (hinge lateral) — korrigiert femorales Valgus
]

VARISIEREND: list[str] = ["HTO_CLOSE_MED", "DFO_OPEN_LAT", "DFO_OPEN_MED"]


@dataclass
class OstLine:
    p1: Point
    p2: Point


@dataclass
class Plan:
    """
    Single osteotomy plan.

    correction_deg is the *signed* physical rotation angle applied to the
    moving segment (positive = clockwise in image coords, y-down).
    The Miniaci algorithm returns the correct sign directly; we store it
    as-is so there is never any additional sign-flip needed downstream.
    """
    kind: OsteotomyKind = "HTO_OPEN_MED"
    osteotomy_line: Optional[OstLine] = None
    hinge_point: Optional[Point] = None
    target_point: Optional[Point] = None
    target_plateau_pct: float = 62.5   # Fujisawa default (% from medial)

    # User-controlled correction — signed physical rotation
    correction_deg: float = 0.0

    # Derived (recomputed whenever geometry changes)
    miniaci_deg: Optional[float] = None   # signed optimal angle from geometry
    wedge_mm: Optional[float] = None
    corrected_hka: Optional[float] = None
    corrected_mmpta: Optional[float] = None   # HTO only
    corrected_mldfa: Optional[float] = None   # DFO only

    def as_dict(self) -> dict:
        def pt(p: Optional[Point]):
            return {"x": p.x, "y": p.y} if p else None

        def line(l: Optional[OstLine]):
            return {"p1": pt(l.p1), "p2": pt(l.p2)} if l else None

        def f(v):
            return float(round(v, 2)) if v is not None else None

        return {
            "kind": self.kind,
            "osteotomy_line": line(self.osteotomy_line),
            "hinge_point": pt(self.hinge_point),
            "target_point": pt(self.target_point),
            "target_plateau_pct": self.target_plateau_pct,
            "correction_deg": f(self.correction_deg),
            "miniaci_deg": f(self.miniaci_deg),
            "wedge_mm": f(self.wedge_mm),
            "corrected_hka": f(self.corrected_hka),
            "corrected_mmpta": f(self.corrected_mmpta),
            "corrected_mldfa": f(self.corrected_mldfa),
        }
