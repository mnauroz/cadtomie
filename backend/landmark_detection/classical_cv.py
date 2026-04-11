"""
Classical computer vision landmark detector.

Strategy
--------
Hip center   : Hough circle transform on the upper 40 % of the image,
               searching in the region expected for the femoral head.
Knee center  : Centroid of the narrowest vertical region of the bone
               (approximate diaphysis-metaphysis transition zone).
Ankle center : Hough circle on the lower 20 % (talar dome).
Joint lines  : Contour + horizontal extremes at the knee and ankle.
Diaphysis    : Midline sampling along the femoral/tibial shaft.

All detections are heuristic and designed for full-leg AP radiographs
with the patient standing.  They serve as initialisation for manual
correction and as fallbacks when an ML model is not available.
"""
from __future__ import annotations

from typing import Optional

import cv2
import numpy as np


def gaussian_filter1d(arr, sigma):
    """Lightweight Gaussian smoothing using numpy convolution."""
    size = int(6 * sigma + 1) | 1
    x = np.arange(size) - size // 2
    kernel = np.exp(-0.5 * (x / sigma) ** 2)
    kernel /= kernel.sum()
    return np.convolve(arr, kernel, mode="same")

from .types import JointLine, Landmarks, Point


class ClassicalCVDetector:
    """Heuristic landmark detector using OpenCV."""

    # Max size for detection (larger images are downscaled first, results scaled back)
    MAX_DIM = 1024

    def detect(self, image: np.ndarray) -> Landmarks:
        """
        Parameters
        ----------
        image : ndarray, uint8, shape (H, W, 3) BGR
        """
        orig_h, orig_w = image.shape[:2]
        scale = 1.0
        img = image

        # Downscale large images so Hough transforms don't hang
        max_dim = max(orig_h, orig_w)
        if max_dim > self.MAX_DIM:
            scale = self.MAX_DIM / max_dim
            new_w = int(orig_w * scale)
            new_h = int(orig_h * scale)
            img = cv2.resize(image, (new_w, new_h), interpolation=cv2.INTER_AREA)

        gray = self._to_gray(img)
        h, w = gray.shape

        lm = Landmarks()

        # ---- Pre-process ----
        enhanced = self._enhance(gray)

        # ---- Detect femoral head (hip center) ----
        lm.hip_center = self._detect_hip(enhanced, h, w)
        lm.confidence["hip_center"] = 0.6 if lm.hip_center else 0.0

        # ---- Detect ankle center ----
        lm.ankle_center = self._detect_ankle(enhanced, h, w)
        lm.confidence["ankle_center"] = 0.5 if lm.ankle_center else 0.0

        # ---- Detect knee (midpoint between hip and ankle) ----
        lm.knee_center = self._detect_knee(enhanced, h, w, lm.hip_center, lm.ankle_center)
        lm.confidence["knee_center"] = 0.5 if lm.knee_center else 0.0

        # ---- Extract joint lines ----
        if lm.knee_center:
            lm.distal_femoral_line = self._extract_joint_line(
                enhanced, lm.knee_center, region_h=int(h * 0.05), above=True
            )
            lm.proximal_tibial_line = self._extract_joint_line(
                enhanced, lm.knee_center, region_h=int(h * 0.05), above=False
            )

        # ---- Diaphysis midpoints ----
        if lm.hip_center and lm.knee_center:
            lm.femur_diaphysis = self._sample_diaphysis(
                enhanced, lm.hip_center, lm.knee_center, n=5
            )
        if lm.knee_center and lm.ankle_center:
            lm.tibia_diaphysis = self._sample_diaphysis(
                enhanced, lm.knee_center, lm.ankle_center, n=5
            )

        # Scale coordinates back to original image size
        if scale != 1.0:
            lm = self._scale_landmarks(lm, 1.0 / scale)

        return lm

    @staticmethod
    def _scale_landmarks(lm: Landmarks, factor: float) -> Landmarks:
        def sp(p):
            return Point(p.x * factor, p.y * factor) if p else None

        def sjl(jl):
            if jl is None:
                return None
            return JointLine(medial=Point(jl.medial.x * factor, jl.medial.y * factor),
                             lateral=Point(jl.lateral.x * factor, jl.lateral.y * factor))

        lm.hip_center = sp(lm.hip_center)
        lm.knee_center = sp(lm.knee_center)
        lm.ankle_center = sp(lm.ankle_center)
        lm.distal_femoral_line = sjl(lm.distal_femoral_line)
        lm.proximal_tibial_line = sjl(lm.proximal_tibial_line)
        lm.femur_diaphysis = [Point(p.x * factor, p.y * factor) for p in lm.femur_diaphysis]
        lm.tibia_diaphysis = [Point(p.x * factor, p.y * factor) for p in lm.tibia_diaphysis]
        return lm

    # ------------------------------------------------------------------
    # Detection helpers
    # ------------------------------------------------------------------

    def _detect_hip(self, gray: np.ndarray, h: int, w: int) -> Optional[Point]:
        """Detect femoral head using Hough circles in the upper 35 % of image."""
        roi = gray[: int(h * 0.35), :]
        blurred = cv2.GaussianBlur(roi, (9, 9), 2)

        # Expected radius range for a femoral head on a full-leg radiograph
        min_r = max(int(w * 0.03), 15)
        max_r = max(int(w * 0.10), 50)

        circles = cv2.HoughCircles(
            blurred,
            cv2.HOUGH_GRADIENT,
            dp=1,
            minDist=w // 4,
            param1=50,
            param2=30,
            minRadius=min_r,
            maxRadius=max_r,
        )
        if circles is None:
            # Fallback: centroid of bright region in top quarter
            return self._bright_centroid(gray[: h // 4, :], y_offset=0, x_offset=0)

        circles = np.round(circles[0]).astype(int)
        # Pick circle closest to horizontal center
        best = min(circles, key=lambda c: abs(c[0] - w // 2))
        return Point(float(best[0]), float(best[1]))

    def _detect_ankle(self, gray: np.ndarray, h: int, w: int) -> Optional[Point]:
        """Detect talar dome using Hough circles in the bottom 20 % of image."""
        y_start = int(h * 0.80)
        roi = gray[y_start:, :]
        blurred = cv2.GaussianBlur(roi, (9, 9), 2)

        min_r = max(int(w * 0.03), 10)
        max_r = max(int(w * 0.09), 40)

        circles = cv2.HoughCircles(
            blurred,
            cv2.HOUGH_GRADIENT,
            dp=1,
            minDist=w // 4,
            param1=50,
            param2=25,
            minRadius=min_r,
            maxRadius=max_r,
        )
        if circles is None:
            # Fallback: centroid of bright region in bottom slice
            c = self._bright_centroid(gray[y_start:, :], y_offset=y_start, x_offset=0)
            return c

        circles = np.round(circles[0]).astype(int)
        best = min(circles, key=lambda c: abs(c[0] - w // 2))
        return Point(float(best[0]), float(best[1] + y_start))

    def _detect_knee(
        self,
        gray: np.ndarray,
        h: int,
        w: int,
        hip: Optional[Point],
        ankle: Optional[Point],
    ) -> Optional[Point]:
        """
        Estimate knee center.

        If hip and ankle are known, search a horizontal band around the
        expected knee height (44–56 % of leg length from hip).
        Otherwise use the image midpoint.
        """
        if hip and ankle:
            # Knee is ~44 % of the way from hip to ankle along the leg
            t = 0.44
            kx = hip.x + t * (ankle.x - hip.x)
            ky = hip.y + t * (ankle.y - hip.y)
            # Refine: find the narrowest bone width in a band ±5 % around ky
            band_h = int(h * 0.05)
            y0 = max(0, int(ky) - band_h)
            y1 = min(h, int(ky) + band_h)
            ky_refined = self._narrowest_row(gray[y0:y1, :], y_offset=y0)
            return Point(kx, float(ky_refined))
        else:
            return Point(float(w // 2), float(h // 2))

    def _extract_joint_line(
        self,
        gray: np.ndarray,
        knee: Point,
        region_h: int,
        above: bool,
    ) -> Optional[JointLine]:
        """
        Extract a joint line by finding horizontal bone extremes just above
        (distal femur) or below (proximal tibia) the knee center.
        """
        h, w = gray.shape
        ky = int(knee.y)
        if above:
            y0 = max(0, ky - region_h * 2)
            y1 = max(0, ky - region_h // 2)
        else:
            y0 = min(h, ky + region_h // 2)
            y1 = min(h, ky + region_h * 2)

        if y0 >= y1:
            return None

        roi = gray[y0:y1, :]
        mid_y = (y0 + y1) // 2

        # Threshold to isolate bone (bright)
        _, binary = cv2.threshold(roi, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

        # Find leftmost and rightmost bone pixels in the mid row of the ROI
        mid_local = (mid_y - y0) // 2
        row = binary[mid_local, :]
        bone_cols = np.where(row > 0)[0]
        if len(bone_cols) < 10:
            # Fallback: use ±20% from center
            cx = int(knee.x)
            margin = int(w * 0.12)
            return JointLine(
                medial=Point(float(max(0, cx - margin)), float(mid_y)),
                lateral=Point(float(min(w - 1, cx + margin)), float(mid_y)),
            )

        medial_x = float(bone_cols.min())
        lateral_x = float(bone_cols.max())
        return JointLine(
            medial=Point(medial_x, float(mid_y)),
            lateral=Point(lateral_x, float(mid_y)),
        )

    def _sample_diaphysis(
        self,
        gray: np.ndarray,
        p1: Point,
        p2: Point,
        n: int = 5,
    ) -> list[Point]:
        """
        Sample n midpoints along the bone shaft between two landmarks.

        For each horizontal row in the interior of the segment, find the
        horizontal midpoint of the bone (brightest region).
        """
        h, w = gray.shape
        points = []
        for i in range(1, n + 1):
            t = i / (n + 1)
            y = int(p1.y + t * (p2.y - p1.y))
            row = gray[np.clip(y, 0, h - 1), :]
            # Find bone midpoint: center of mass of bright pixels
            bone_cols = np.where(row > 100)[0]
            if len(bone_cols) >= 2:
                x = float((bone_cols.min() + bone_cols.max()) / 2)
            else:
                x = p1.x + t * (p2.x - p1.x)
            points.append(Point(x, float(y)))
        return points

    # ------------------------------------------------------------------
    # Image processing utilities
    # ------------------------------------------------------------------

    @staticmethod
    def _to_gray(image: np.ndarray) -> np.ndarray:
        if image.ndim == 3:
            return cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        return image.copy()

    @staticmethod
    def _enhance(gray: np.ndarray) -> np.ndarray:
        """CLAHE contrast enhancement for radiographs."""
        clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(16, 16))
        return clahe.apply(gray)

    @staticmethod
    def _bright_centroid(
        roi: np.ndarray,
        y_offset: int,
        x_offset: int,
    ) -> Optional[Point]:
        """Return centroid of the brightest 10 % of pixels in roi."""
        threshold = int(roi.max() * 0.90)
        mask = roi > threshold
        ys, xs = np.where(mask)
        if len(xs) == 0:
            return None
        return Point(float(xs.mean()) + x_offset, float(ys.mean()) + y_offset)

    @staticmethod
    def _narrowest_row(roi: np.ndarray, y_offset: int) -> int:
        """Return the row index (in full image coords) with fewest bone pixels."""
        h = roi.shape[0]
        if h == 0:
            return y_offset
        widths = []
        for r in range(h):
            row = roi[r, :]
            bone = np.where(row > 100)[0]
            widths.append(len(bone) if len(bone) > 0 else 9999)
        widths_smooth = gaussian_filter1d(widths, sigma=2)
        narrowest = int(np.argmin(widths_smooth))
        return y_offset + narrowest
