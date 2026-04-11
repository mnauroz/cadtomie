"""
DICOM loader module.
"""
from __future__ import annotations

import io
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import numpy as np
import pydicom
from pydicom.dataset import Dataset


def _is_multivalue(val) -> bool:
    return hasattr(val, "__iter__") and not isinstance(val, (str, bytes, float, int))


@dataclass
class DicomImage:
    pixel_array: np.ndarray
    pixel_spacing: tuple[float, float]
    rows: int
    cols: int
    modality: str
    patient_id: str
    study_description: str
    series_description: str
    bits_stored: int
    window_center: Optional[float]
    window_width: Optional[float]
    dataset: Dataset = field(repr=False)

    @property
    def mm_per_pixel_row(self) -> float:
        return self.pixel_spacing[0]

    @property
    def mm_per_pixel_col(self) -> float:
        return self.pixel_spacing[1]


class DicomLoader:

    def load(self, source) -> DicomImage:
        ds = self._read_dataset(source)
        pixel_array = self._extract_pixels(ds)
        spacing = self._extract_spacing(ds)
        return DicomImage(
            pixel_array=pixel_array,
            pixel_spacing=spacing,
            rows=int(ds.Rows),
            cols=int(ds.Columns),
            modality=str(getattr(ds, "Modality", "CR")),
            patient_id=str(getattr(ds, "PatientID", "")),
            study_description=str(getattr(ds, "StudyDescription", "")),
            series_description=str(getattr(ds, "SeriesDescription", "")),
            bits_stored=int(getattr(ds, "BitsStored", 16)),
            window_center=self._float_attr(ds, "WindowCenter"),
            window_width=self._float_attr(ds, "WindowWidth"),
            dataset=ds,
        )

    def _read_dataset(self, source) -> Dataset:
        if isinstance(source, (str, Path)):
            return pydicom.dcmread(str(source), force=True)
        elif isinstance(source, bytes):
            return pydicom.dcmread(io.BytesIO(source), force=True)
        elif hasattr(source, "read"):
            return pydicom.dcmread(source, force=True)
        raise TypeError(f"Unsupported source type: {type(source)}")

    def _extract_pixels(self, ds: Dataset) -> np.ndarray:
        import cv2
        import gc
        raw = ds.pixel_array.astype(np.float32)

        # Multi-frame: take first frame
        if raw.ndim == 4:
            raw = raw[0]

        # Colour DICOM
        if raw.ndim == 3 and raw.shape[2] in (3, 4):
            mn, mx = raw.min(), raw.max()
            arr = ((raw - mn) / (mx - mn + 1e-9) * 255).astype(np.uint8)
            return cv2.cvtColor(arr[:, :, :3], cv2.COLOR_RGB2BGR)

        # Rescale
        slope = float(getattr(ds, "RescaleSlope", 1.0))
        intercept = float(getattr(ds, "RescaleIntercept", 0.0))
        raw = raw * slope + intercept

        # Window/level
        wc = self._float_attr(ds, "WindowCenter")
        ww = self._float_attr(ds, "WindowWidth")
        if wc is not None and ww is not None and ww > 0:
            lo = wc - ww / 2.0
            hi = wc + ww / 2.0
            raw = np.clip(raw, lo, hi)
            raw = (raw - lo) / (hi - lo) * 255.0
        else:
            mn, mx = raw.min(), raw.max()
            raw = (raw - mn) / (mx - mn + 1e-9) * 255.0

        arr = raw.astype(np.uint8)

        # Invert MONOCHROME1
        if "MONOCHROME1" in str(getattr(ds, "PhotometricInterpretation", "")):
            arr = 255 - arr

        if arr.ndim == 2:
            arr = cv2.cvtColor(arr, cv2.COLOR_GRAY2BGR)

        # Limit image size to max 1500px on longest side to save memory
        max_dim = 1500
        h, w = arr.shape[:2]
        if max(h, w) > max_dim:
            scale = max_dim / max(h, w)
            new_w = int(w * scale)
            new_h = int(h * scale)
            arr = cv2.resize(arr, (new_w, new_h), interpolation=cv2.INTER_AREA)

        gc.collect()
        return arr

    def _extract_spacing(self, ds: Dataset) -> tuple[float, float]:
        for attr in ("PixelSpacing", "ImagerPixelSpacing", "NominalScannedPixelSpacing"):
            ps = getattr(ds, attr, None)
            if ps is not None:
                try:
                    return (float(ps[0]), float(ps[1]))
                except Exception:
                    continue
        return (0.143, 0.143)

    @staticmethod
    def _float_attr(ds: Dataset, attr: str) -> Optional[float]:
        val = getattr(ds, attr, None)
        if val is None:
            return None
        if _is_multivalue(val):
            try:
                return float(list(val)[0])
            except Exception:
                return None
        try:
            return float(val)
        except Exception:
            return None
