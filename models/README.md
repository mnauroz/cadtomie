# Models

Place trained model weights here.

## Landmark Detector

**File:** `landmark_detector.pt`

**Architecture:** Heatmap regression CNN (see `backend/landmark_detection/ml_detector.py`)

**Input:** 512×512 RGB image (resized from DICOM)

**Output:** 7 Gaussian heatmaps at 128×128 resolution

**Landmarks detected:**
1. `hip_center`
2. `knee_center`
3. `ankle_center`
4. `distal_femur_medial`
5. `distal_femur_lateral`
6. `proximal_tibia_medial`
7. `proximal_tibia_lateral`

## Training

See `scripts/train_landmark_model.py` (coming soon).

Dataset format: JSON annotations with pixel (x, y) per landmark per image.

Recommended datasets:
- OAI (Osteoarthritis Initiative) — public AP knee radiographs
- Custom annotation of long-leg radiographs with LabelMe or CVAT

## Usage

```python
from landmark_detection import LandmarkDetector
from pathlib import Path

detector = LandmarkDetector(model_path=Path("models/landmark_detector.pt"))
landmarks = detector.detect(image_array)
```

If no `.pt` file is present, the classical CV detector is used automatically.
