"""
Axis calculation module.

Computes mechanical and anatomical axes of the lower limb from detected
landmarks.  All axes are represented as (origin, direction) pairs in
pixel space; the caller must apply pixel-spacing to get physical angles.

Coordinate system
-----------------
  x = column (→ right)
  y = row    (↓ down)

So "upward" in image space is the −y direction.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import numpy as np

from landmark_detection.types import JointLine, Landmarks, Point


@dataclass
class Axis:
    """A directed line segment defined by start and end points."""
    start: Point
    end: Point

    def direction(self) -> np.ndarray:
        d = self.end.as_array() - self.start.as_array()
        norm = np.linalg.norm(d)
        return d / norm if norm > 0 else d

    def length_px(self) -> float:
        return float(np.linalg.norm(self.end.as_array() - self.start.as_array()))


@dataclass
class LimbAxes:
    """All calculated axes for one limb."""

    # Mechanical axes (center-to-center)
    femur_mechanical: Optional[Axis] = None   # hip center → knee center
    tibia_mechanical: Optional[Axis] = None   # knee center → ankle center

    # Mikulicz line: overall mechanical axis hip → ankle
    mikulicz: Optional[Axis] = None

    # Anatomical axes (diaphysis regression line)
    femur_anatomical: Optional[Axis] = None
    tibia_anatomical: Optional[Axis] = None


class AxisCalculator:
    """Derive mechanical and anatomical axes from landmarks."""

    def calculate(self, landmarks: Landmarks) -> LimbAxes:
        axes = LimbAxes()

        hip = landmarks.hip_center
        knee = landmarks.knee_center
        ankle = landmarks.ankle_center

        # ---- Mechanical axes ----
        if hip and knee:
            axes.femur_mechanical = Axis(start=hip, end=knee)

        if knee and ankle:
            axes.tibia_mechanical = Axis(start=knee, end=ankle)

        # ---- Mikulicz line (overall mechanical axis) ----
        if hip and ankle:
            axes.mikulicz = Axis(start=hip, end=ankle)

        # ---- Anatomical axes (PCA through cortex-level midpoints) ----
        if len(landmarks.femur_diaphysis_levels) >= 2:
            midpoints = [lvl.midpoint() for lvl in landmarks.femur_diaphysis_levels]
            if hip is not None:
                axes.femur_anatomical = self._femoral_anatomical_axis(
                    hip, midpoints, landmarks.distal_femoral_line
                )
            else:
                axes.femur_anatomical = self._fit_axis(midpoints)

        if len(landmarks.tibia_diaphysis_levels) >= 2:
            midpoints = [lvl.midpoint() for lvl in landmarks.tibia_diaphysis_levels]
            axes.tibia_anatomical = self._fit_axis(midpoints)

        return axes

    # ------------------------------------------------------------------

    @staticmethod
    def _femoral_anatomical_axis(
        hip: Point,
        midpoints: list[Point],
        dfl: Optional[JointLine],
    ) -> Axis:
        """
        Femoral anatomical axis from the proximal shaft end to the DFL.

        Start
        -----
        Proximal end of the shaft cloud: centroid + t_min * D, where t_min is
        the most-negative projection of any midpoint along D.  This corresponds
        to the trochanter level (topmost diaphysis midpoint), NOT the hip joint
        center (femoral head center).

        Direction
        ---------
        PCA/SVD through shaft midpoints, oriented proximal → distal using the
        hip joint center only to disambiguate which end is "up".

        End point
        ---------
        1. Analytical intersection with DFL (both lines treated as infinite).
        2. Near-parallel fallback: foot of perpendicular from centroid onto DFL.
        3. No-DFL fallback: extend to the most-distal shaft midpoint projection.
        """
        pts = np.array([[p.x, p.y] for p in midpoints], dtype=float)
        centroid = pts.mean(axis=0)

        _, _, vt = np.linalg.svd(pts - centroid, full_matrices=False)
        D = vt[0]  # principal component (unit vector)

        # Orient proximal → distal (hip center used only for disambiguation)
        hip_arr = np.array([hip.x, hip.y], dtype=float)
        if np.dot(D, centroid - hip_arr) < 0:
            D = -D

        # Start: proximal end of the shaft cloud (trochanter level)
        projections = (pts - centroid) @ D
        start_arr = centroid + float(projections.min()) * D

        # End point: DFL intersection
        if dfl is not None:
            B = np.array([dfl.medial.x,  dfl.medial.y],  dtype=float)
            E = np.array([dfl.lateral.x - dfl.medial.x,
                          dfl.lateral.y - dfl.medial.y],  dtype=float)
            denom = D[0] * E[1] - D[1] * E[0]
            if abs(denom) > 1e-6:
                diff = B - centroid
                t = (diff[0] * E[1] - diff[1] * E[0]) / denom
                end_arr = centroid + t * D
            else:
                # Near-parallel: foot of perpendicular from centroid onto DFL
                e_len = float(np.linalg.norm(E))
                if e_len > 1e-9:
                    E_unit = E / e_len
                    s = np.dot(centroid - B, E_unit)
                    end_arr = B + s * E_unit
                else:
                    end_arr = centroid + D * float(projections.max())
        else:
            end_arr = centroid + D * float(projections.max())

        return Axis(
            start=Point(float(start_arr[0]), float(start_arr[1])),
            end=Point(float(end_arr[0]),     float(end_arr[1])),
        )

    @staticmethod
    def _fit_axis(points: list[Point]) -> Axis:
        """
        Fit a line through a list of points via PCA / SVD.

        Returns an Axis whose start/end span the range of the point cloud
        along the principal direction.
        """
        pts = np.array([[p.x, p.y] for p in points], dtype=float)
        centroid = pts.mean(axis=0)
        _, _, vt = np.linalg.svd(pts - centroid, full_matrices=False)
        direction = vt[0]  # first principal component

        # Project all points onto direction to find span
        projections = (pts - centroid) @ direction
        t_min, t_max = projections.min(), projections.max()

        start_arr = centroid + t_min * direction
        end_arr = centroid + t_max * direction

        return Axis(
            start=Point(float(start_arr[0]), float(start_arr[1])),
            end=Point(float(end_arr[0]), float(end_arr[1])),
        )
