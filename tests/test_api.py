"""
Integration tests for the FastAPI endpoints.

Uses synthetic DICOM-like images (encoded as DICOM in-memory) to avoid
needing real patient data.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))

import io
import numpy as np
import pytest

try:
    import pydicom
    from pydicom.dataset import Dataset, FileDataset
    from pydicom.sequence import Sequence
    from pydicom.uid import generate_uid
    HAS_PYDICOM = True
except ImportError:
    HAS_PYDICOM = False

try:
    from fastapi.testclient import TestClient
    from main import app
    HAS_FASTAPI = True
except ImportError:
    HAS_FASTAPI = False


def make_test_dicom(rows=512, cols=256) -> bytes:
    """Create a minimal in-memory DICOM file with a synthetic radiograph."""
    meta = pydicom.Dataset()
    meta.MediaStorageSOPClassUID = "1.2.840.10008.5.1.4.1.1.1"
    meta.MediaStorageSOPInstanceUID = generate_uid()
    meta.TransferSyntaxUID = pydicom.uid.ExplicitVRLittleEndian

    ds = FileDataset(None, {}, file_meta=meta, preamble=b"\0" * 128)
    ds.is_implicit_VR = False
    ds.is_little_endian = True

    ds.SOPClassUID = meta.MediaStorageSOPClassUID
    ds.SOPInstanceUID = meta.MediaStorageSOPInstanceUID
    ds.Modality = "CR"
    ds.PatientID = "TEST001"
    ds.StudyDescription = "Long-leg standing radiograph"
    ds.Rows = rows
    ds.Columns = cols
    ds.BitsAllocated = 16
    ds.BitsStored = 12
    ds.HighBit = 11
    ds.PixelRepresentation = 0
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = "MONOCHROME2"
    ds.PixelSpacing = [0.143, 0.143]

    # Synthetic pixel data: vertical bright stripe (bone)
    pixels = np.zeros((rows, cols), dtype=np.uint16)
    cx = cols // 2
    pixels[:, cx - 15: cx + 15] = 2000
    # Hip circle at top
    for r in range(rows):
        for c in range(cols):
            if (r - 80) ** 2 + (c - cx) ** 2 < 30 ** 2:
                pixels[r, c] = 3000
    ds.PixelData = pixels.tobytes()

    buf = io.BytesIO()
    pydicom.dcmwrite(buf, ds)
    return buf.getvalue()


@pytest.mark.skipif(not HAS_PYDICOM or not HAS_FASTAPI, reason="pydicom/fastapi not installed")
class TestAPI:
    def setup_method(self):
        self.client = TestClient(app)
        self.dicom_bytes = make_test_dicom()

    def test_health(self):
        r = self.client.get("/health")
        assert r.status_code == 200
        assert r.json()["status"] == "ok"

    def test_upload_returns_session_id(self):
        r = self.client.post(
            "/upload",
            files={"file": ("test.dcm", self.dicom_bytes, "application/dicom")},
        )
        assert r.status_code == 200, r.text
        data = r.json()
        assert "session_id" in data
        assert len(data["session_id"]) > 0

    def test_upload_returns_angles(self):
        r = self.client.post(
            "/upload",
            files={"file": ("test.dcm", self.dicom_bytes, "application/dicom")},
        )
        data = r.json()
        angles = data["angles"]
        # All expected keys should be present
        for key in ["HKA_deg", "mLDFA_deg", "mMPTA_deg", "JLCA_deg"]:
            assert key in angles, f"Missing angle key: {key}"

    def test_upload_returns_image_b64(self):
        r = self.client.post(
            "/upload",
            files={"file": ("test.dcm", self.dicom_bytes, "application/dicom")},
        )
        data = r.json()
        assert "image_b64" in data
        assert len(data["image_b64"]) > 100

    def test_get_angles_after_upload(self):
        r = self.client.post(
            "/upload",
            files={"file": ("test.dcm", self.dicom_bytes, "application/dicom")},
        )
        sid = r.json()["session_id"]
        r2 = self.client.get(f"/angles/{sid}")
        assert r2.status_code == 200
        assert "HKA_deg" in r2.json()

    def test_export_json(self):
        r = self.client.post(
            "/upload",
            files={"file": ("test.dcm", self.dicom_bytes, "application/dicom")},
        )
        sid = r.json()["session_id"]
        r2 = self.client.get(f"/export/{sid}/json")
        assert r2.status_code == 200
        assert r2.headers["content-type"].startswith("application/json")

    def test_export_png(self):
        r = self.client.post(
            "/upload",
            files={"file": ("test.dcm", self.dicom_bytes, "application/dicom")},
        )
        sid = r.json()["session_id"]
        r2 = self.client.get(f"/export/{sid}/png")
        assert r2.status_code == 200
        assert r2.headers["content-type"] == "image/png"

    def test_update_landmarks(self):
        r = self.client.post(
            "/upload",
            files={"file": ("test.dcm", self.dicom_bytes, "application/dicom")},
        )
        sid = r.json()["session_id"]

        patch = {"hip_center": {"x": 128.0, "y": 80.0}}
        r2 = self.client.post(f"/landmarks/{sid}", json=patch)
        assert r2.status_code == 200
        data = r2.json()
        assert "angles" in data
        assert data["landmarks"]["hip_center"]["x"] == pytest.approx(128.0, abs=0.1)

    def test_nonexistent_session_returns_404(self):
        r = self.client.get("/angles/nonexistent-session-id")
        assert r.status_code == 404
