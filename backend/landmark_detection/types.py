"""Shared data types for landmark detection (no circular imports)."""
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Optional
import numpy as np


@dataclass
class Point:
    x: float
    y: float

    def as_array(self) -> np.ndarray:
        return np.array([self.x, self.y], dtype=float)


@dataclass
class JointLine:
    medial: Point
    lateral: Point

    def direction(self) -> np.ndarray:
        d = self.lateral.as_array() - self.medial.as_array()
        norm = np.linalg.norm(d)
        return d / norm if norm > 0 else d

    def midpoint(self) -> Point:
        return Point((self.medial.x + self.lateral.x) / 2,
                     (self.medial.y + self.lateral.y) / 2)


@dataclass
class DiaphysisLevel:
    """One cortex measurement level: medial + lateral cortex point.

    The midpoint between them is used as the shaft axis reference.
    """
    medial: Point
    lateral: Point

    def midpoint(self) -> Point:
        return Point(
            (self.medial.x + self.lateral.x) / 2.0,
            (self.medial.y + self.lateral.y) / 2.0,
        )


@dataclass
class Landmarks:
    hip_center: Optional[Point] = None
    knee_center: Optional[Point] = None
    distal_femoral_line: Optional[JointLine] = None
    proximal_tibial_line: Optional[JointLine] = None
    ankle_center: Optional[Point] = None
    distal_tibial_line: Optional[JointLine] = None
    femur_diaphysis_levels: list[DiaphysisLevel] = field(default_factory=list)
    tibia_diaphysis_levels: list[DiaphysisLevel] = field(default_factory=list)
    confidence: dict[str, float] = field(default_factory=dict)
