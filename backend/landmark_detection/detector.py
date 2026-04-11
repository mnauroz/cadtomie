"""Landmark detection facade."""
from __future__ import annotations

from pathlib import Path
from typing import Optional

import numpy as np

# Re-export types so other modules can import from here as before
from .types import JointLine, Landmarks, Point


class LandmarkDetector:
    def __init__(self, model_path: Optional[Path] = None, use_ml: bool = False):
        from .classical_cv import ClassicalCVDetector
        self._cv = ClassicalCVDetector()
        self._ml = None

        if model_path is not None or use_ml:
            try:
                from .ml_detector import MLDetector
                self._ml = MLDetector(model_path=model_path)
            except Exception:
                pass

    def detect(self, image: np.ndarray) -> Landmarks:
        if self._ml is not None:
            try:
                return self._ml.detect(image)
            except Exception:
                pass
        return self._cv.detect(image)
