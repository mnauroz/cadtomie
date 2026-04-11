"""
ML-based landmark detector (placeholder).

Architecture: lightweight UNet or HRNet-style heatmap regression.
The model outputs one Gaussian heatmap per landmark; the peak gives
the predicted (x, y) position.

To train your own model:
  1. Label a dataset with the provided annotation format.
  2. Use the training script in scripts/train_landmark_model.py.
  3. Save the checkpoint to models/landmark_detector.pt.
  4. Pass model_path= to LandmarkDetector.
"""
from __future__ import annotations

from pathlib import Path
from typing import Optional

import numpy as np

try:
    import torch
    import torch.nn as nn

    HAS_TORCH = True
except ImportError:
    HAS_TORCH = False

from .types import JointLine, Landmarks, Point

# Landmark order in model output heatmaps
LANDMARK_KEYS = [
    "hip_center",
    "knee_center",
    "ankle_center",
    "distal_femur_medial",
    "distal_femur_lateral",
    "proximal_tibia_medial",
    "proximal_tibia_lateral",
]

INPUT_SIZE = (512, 512)   # resize target before inference
HEATMAP_SIZE = (128, 128)  # model output resolution


class MLDetector:
    """
    Wraps a trained PyTorch landmark heatmap model.

    Falls back gracefully when torch is not installed or no model is
    loaded, raising RuntimeError so the caller can use classical CV.
    """

    def __init__(self, model_path: Optional[Path] = None):
        if not HAS_TORCH:
            raise RuntimeError("PyTorch not installed – using classical CV fallback")

        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        self.model = self._build_model()

        if model_path is not None and Path(model_path).exists():
            state = torch.load(model_path, map_location=self.device)
            self.model.load_state_dict(state)

        self.model.eval()

    def detect(self, image: np.ndarray) -> Landmarks:
        if not HAS_TORCH:
            raise RuntimeError("torch unavailable")

        tensor = self._preprocess(image)
        orig_h, orig_w = image.shape[:2]

        with torch.no_grad():
            heatmaps = self.model(tensor)  # (1, n_landmarks, Hh, Hw)

        heatmaps = heatmaps.squeeze(0).cpu().numpy()  # (n_landmarks, Hh, Hw)
        return self._decode(heatmaps, orig_w, orig_h)

    # ------------------------------------------------------------------

    def _preprocess(self, image: np.ndarray):
        import cv2
        import torch

        img = cv2.resize(image, INPUT_SIZE)
        img = img.astype(np.float32) / 255.0
        if img.ndim == 3:
            img = img.transpose(2, 0, 1)  # HWC -> CHW
        else:
            img = img[np.newaxis, :, :]   # add channel dim
        tensor = torch.from_numpy(img).unsqueeze(0).to(self.device)
        return tensor

    def _decode(self, heatmaps: np.ndarray, orig_w: int, orig_h: int) -> Landmarks:
        """Convert heatmap peaks to pixel coordinates in the original image."""
        hh, hw = HEATMAP_SIZE
        scale_x = orig_w / hw
        scale_y = orig_h / hh

        coords: dict[str, Point] = {}
        for i, key in enumerate(LANDMARK_KEYS):
            hm = heatmaps[i]
            flat_idx = int(np.argmax(hm))
            hy, hx = divmod(flat_idx, hw)
            coords[key] = Point(hx * scale_x, hy * scale_y)

        lm = Landmarks(
            hip_center=coords.get("hip_center"),
            knee_center=coords.get("knee_center"),
            ankle_center=coords.get("ankle_center"),
        )

        mf = coords.get("distal_femur_medial")
        lf = coords.get("distal_femur_lateral")
        if mf and lf:
            lm.distal_femoral_line = JointLine(medial=mf, lateral=lf)

        mt = coords.get("proximal_tibia_medial")
        lt = coords.get("proximal_tibia_lateral")
        if mt and lt:
            lm.proximal_tibial_line = JointLine(medial=mt, lateral=lt)

        for key in LANDMARK_KEYS:
            lm.confidence[key] = float(heatmaps[LANDMARK_KEYS.index(key)].max())

        return lm

    @staticmethod
    def _build_model():
        """
        Build a minimal heatmap regression network.

        Replace with HRNet / ViTPose for production use.
        """
        import torch.nn as nn

        n_out = len(LANDMARK_KEYS)

        model = nn.Sequential(
            # Encoder
            nn.Conv2d(3, 32, 3, padding=1), nn.ReLU(),
            nn.MaxPool2d(2),
            nn.Conv2d(32, 64, 3, padding=1), nn.ReLU(),
            nn.MaxPool2d(2),
            nn.Conv2d(64, 128, 3, padding=1), nn.ReLU(),
            # Decoder
            nn.Upsample(scale_factor=2, mode="bilinear", align_corners=False),
            nn.Conv2d(128, 64, 3, padding=1), nn.ReLU(),
            nn.Upsample(scale_factor=2, mode="bilinear", align_corners=False),
            nn.Conv2d(64, n_out, 1),
            nn.Sigmoid(),
        )
        return model
