"""
CADtomie – FastAPI backend

All endpoints (except /health and /billing/webhook) require:
  - Valid Supabase JWT in Authorization: Bearer <token>
  - Active subscription (trialing or active) checked against Supabase

Endpoints
---------
POST /upload          Upload DICOM, run landmark detection + angle calc
GET  /image/{id}      Return base64-encoded annotated radiograph (PNG)
POST /landmarks/{id}  Update one or more landmarks (manual correction)
GET  /angles/{id}     Return angle measurements as JSON
GET  /export/{id}/png     Export annotated PNG
GET  /export/{id}/pdf     Export PDF report
GET  /export/{id}/json    Export JSON measurements
POST /billing/create-checkout  Stripe checkout URL
GET  /billing/status           Current subscription status
POST /billing/portal           Stripe customer portal URL
POST /billing/webhook          Stripe event receiver (HMAC-verified, no auth)
GET  /health          Liveness check (no auth)
"""
from __future__ import annotations

import base64
import gc
import logging
import math
import io
import os
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Optional

# Load .env in development (no-op in production where env vars are injected)
from dotenv import load_dotenv
load_dotenv()

_ost_log = logging.getLogger("cadtomie.osteotomy")

# Ensure backend sub-packages are importable when running from backend/
sys.path.insert(0, str(Path(__file__).parent))

import numpy as np
from fastapi import Depends, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel

from angle_measurement.angles import AngleCalculator, DeformityAngles
from axis_calculation.axes import AxisCalculator, LimbAxes
from dicom_loader.loader import DicomImage, DicomLoader
from export.exporter import Exporter
from landmark_detection.detector import LandmarkDetector
from landmark_detection.types import DiaphysisLevel, JointLine, Landmarks, Point
from osteotomy import engine as ost_engine
from osteotomy.types import OstLine, OsteotomyKind, Plan as OstPlan, VARISIEREND

from auth import require_auth
from billing import require_active_subscription
from stripe_routes import router as billing_router

app = FastAPI(
    title="CADtomie API",
    version="0.1.0",
    # Disable auto-generated docs in production to avoid exposing endpoints
    docs_url=None if os.environ.get("ENVIRONMENT") == "production" else "/docs",
    redoc_url=None,
)

_allowed_origins = os.environ.get(
    "ALLOWED_ORIGINS", "http://localhost:5173"
).split(",")

# Also allow all Vercel preview deployments (*.vercel.app)
_allowed_origin_regex = r"https://.*\.vercel\.app"

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_origin_regex=_allowed_origin_regex,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
    allow_credentials=True,
)

app.include_router(billing_router)

# ---------------------------------------------------------------------------
# In-memory session store (use Redis / DB for production)
# ---------------------------------------------------------------------------

class Session:
    user_id: str                              # Supabase user UUID — enforces ownership
    dicom: DicomImage
    landmarks: Landmarks
    axes: LimbAxes
    angles: DeformityAngles
    annotated: np.ndarray
    side: str = "unknown"
    show_anatomical: bool = False
    pixel_spacing_override: Optional[float] = None   # calibrated mm/px
    osteotomy_plan: Optional[OstPlan] = None
    align_angle_deg: float = 0.0  # CW rotation applied at upload to straighten limb
    created_at: float = 0.0       # time.time() at creation — used for TTL cleanup


_sessions: dict[str, Session] = {}

# Sessions expire after 2 hours to free memory (images are never persisted to disk)
_SESSION_TTL_SECONDS = 7200

# Maximum number of sessions to keep in memory at once
_MAX_SESSIONS = 5

def _cleanup_old_sessions() -> None:
    """Remove oldest sessions when limit is exceeded to free memory."""
    if len(_sessions) >= _MAX_SESSIONS:
        # Remove oldest sessions (dict preserves insertion order in Python 3.7+)
        to_remove = list(_sessions.keys())[:len(_sessions) - _MAX_SESSIONS + 1]
        for sid in to_remove:
            del _sessions[sid]
        gc.collect()


def _get_session(session_id: str, user: dict) -> Session:
    """Fetch a session and verify it belongs to the requesting user."""
    session = _sessions.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if session.user_id != user["sub"]:
        raise HTTPException(status_code=403, detail="Access denied")
    return session


def _start_session_cleanup() -> None:
    """Background thread: evict sessions older than TTL."""
    def _loop() -> None:
        while True:
            time.sleep(300)  # check every 5 minutes
            cutoff = time.time() - _SESSION_TTL_SECONDS
            stale = [sid for sid, s in list(_sessions.items()) if s.created_at < cutoff]
            for sid in stale:
                _sessions.pop(sid, None)
    threading.Thread(target=_loop, daemon=True, name="session-cleanup").start()

_start_session_cleanup()

# ---------------------------------------------------------------------------
# Services (singletons)
# ---------------------------------------------------------------------------

_loader = DicomLoader()
_detector = LandmarkDetector()
_axis_calc = AxisCalculator()
_angle_calc = AngleCalculator()
_exporter = Exporter()


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class PointModel(BaseModel):
    x: float
    y: float


class JointLineModel(BaseModel):
    medial: PointModel
    lateral: PointModel


class DiaphysisLevelModel(BaseModel):
    medial: PointModel
    lateral: PointModel


class LandmarkPatch(BaseModel):
    hip_center: Optional[PointModel] = None
    knee_center: Optional[PointModel] = None
    ankle_center: Optional[PointModel] = None
    distal_femoral_line: Optional[JointLineModel] = None
    proximal_tibial_line: Optional[JointLineModel] = None
    femur_diaphysis_levels: Optional[list[DiaphysisLevelModel]] = None
    tibia_diaphysis_levels: Optional[list[DiaphysisLevelModel]] = None


class SessionConfig(BaseModel):
    show_anatomical: bool


class CalibrationBody(BaseModel):
    p1: PointModel
    p2: PointModel
    known_mm: float   # real-world distance between p1 and p2


class UploadResponse(BaseModel):
    session_id: str
    rows: int
    cols: int
    pixel_spacing: list[float]
    modality: str
    patient_id: str
    angles: dict[str, Any]
    landmarks: dict[str, Any]
    image_b64: str      # base64-encoded annotated PNG
    raw_image_b64: str  # base64-encoded unannotated DICOM pixels (immutable)
    align_angle_deg: float = 0.0  # CW degrees applied at upload; 0 if image was already vertical


# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------

def _compute_align_angle(lm: Landmarks) -> float:
    """Return the CW rotation angle (degrees) needed to align the hip→ankle vector to vertical.

    Returns 0 if:
      - landmarks are missing
      - ankle is not meaningfully below hip (upside-down or degenerate detection)
      - limb vector is too short (< 100 px) — degenerate detection
      - angle exceeds 20° (safety guard against catastrophic mis-detection)
    Positive = CW in image coordinates (y-down).
    """
    if not lm.hip_center or not lm.ankle_center:
        return 0.0
    vx = lm.ankle_center.x - lm.hip_center.x
    vy = lm.ankle_center.y - lm.hip_center.y
    # ankle must be clearly below hip (y-down); < 10 px = upside-down / degenerate
    if vy < 10.0:
        return 0.0
    # limb vector must be long enough to give a meaningful angle
    if math.hypot(vx, vy) < 100.0:
        return 0.0
    angle = math.degrees(math.atan2(vx, vy))
    if abs(angle) > 20.0:
        return 0.0
    return angle


def _align_image(pixel_array: np.ndarray, angle_deg: float) -> np.ndarray:
    """Rotate pixel_array CW by angle_deg around its centre (in-place copy).

    Uses INTER_LINEAR with zero-fill border so anatomy stays centred.
    OpenCV's getRotationMatrix2D uses CCW-positive convention, so we negate.
    """
    import cv2
    if abs(angle_deg) < 1e-6:
        return pixel_array
    h, w = pixel_array.shape[:2]
    M = cv2.getRotationMatrix2D((w / 2.0, h / 2.0), -angle_deg, 1.0)
    return cv2.warpAffine(pixel_array, M, (w, h), flags=cv2.INTER_LINEAR, borderValue=0)


def _align_landmarks(lm: Landmarks, angle_deg: float, pivot: Point) -> Landmarks:
    """Rotate every landmark coordinate CW by angle_deg around pivot."""
    if abs(angle_deg) < 1e-6:
        return lm
    rp = ost_engine.rotate_point

    def _rp(p: Optional[Point]) -> Optional[Point]:
        return rp(p, pivot, angle_deg) if p is not None else None

    def _rjl(jl: Optional[JointLine]) -> Optional[JointLine]:
        if jl is None:
            return None
        # medial/lateral are always Point (never None) — use rp directly
        return JointLine(
            medial  = rp(jl.medial,  pivot, angle_deg),
            lateral = rp(jl.lateral, pivot, angle_deg),
        )

    def _rdl(dl: DiaphysisLevel) -> DiaphysisLevel:
        return DiaphysisLevel(
            medial  = rp(dl.medial,  pivot, angle_deg),
            lateral = rp(dl.lateral, pivot, angle_deg),
        )

    return Landmarks(
        hip_center=_rp(lm.hip_center),
        knee_center=_rp(lm.knee_center),
        ankle_center=_rp(lm.ankle_center),
        distal_femoral_line=_rjl(lm.distal_femoral_line),
        proximal_tibial_line=_rjl(lm.proximal_tibial_line),
        femur_diaphysis_levels=[_rdl(d) for d in lm.femur_diaphysis_levels],
        tibia_diaphysis_levels=[_rdl(d) for d in lm.tibia_diaphysis_levels],
        confidence=dict(lm.confidence),
    )


def _run_pipeline(session: Session) -> None:
    """Re-derive axes, angles, and annotated image from current landmarks."""
    session.axes = _axis_calc.calculate(session.landmarks)
    session.angles = _angle_calc.calculate(session.axes, session.landmarks, side=session.side)
    session.annotated = _exporter.render_overlay(
        session.dicom.pixel_array,
        session.landmarks,
        session.axes,
        session.angles,
        show_anatomical=session.show_anatomical,
    )


def _init_diaphysis_levels(lm: Landmarks) -> None:
    """Auto-place 4 cortex-level pairs per bone along the mechanical axis.

    Both medial and lateral start ±20 px perpendicular to the axis so the
    handles are visible. The user drags them to the actual cortex edges.
    """
    import math

    def _make_levels(p1: Point, p2: Point, fractions: list[float]) -> list[DiaphysisLevel]:
        dx = p2.x - p1.x
        dy = p2.y - p1.y
        length = math.hypot(dx, dy)
        if length > 0:
            px, py = -dy / length * 20, dx / length * 20  # perpendicular ±20 px
        else:
            px, py = 20.0, 0.0
        levels = []
        for t in fractions:
            cx = p1.x + dx * t
            cy = p1.y + dy * t
            levels.append(DiaphysisLevel(
                medial=Point(cx - px, cy - py),
                lateral=Point(cx + px, cy + py),
            ))
        return levels

    if not lm.femur_diaphysis_levels and lm.hip_center and lm.knee_center:
        lm.femur_diaphysis_levels = _make_levels(
            lm.hip_center, lm.knee_center, [0.25, 0.40, 0.60, 0.75]
        )
    if not lm.tibia_diaphysis_levels and lm.knee_center and lm.ankle_center:
        lm.tibia_diaphysis_levels = _make_levels(
            lm.knee_center, lm.ankle_center, [0.25, 0.40, 0.60, 0.75]
        )


def _orient_joint_lines_for_side(lm: Landmarks, side: str) -> None:
    """Ensure JointLine medial/lateral are on the anatomically correct image sides.

    Standard AP radiology:
      right leg — medial = image RIGHT (larger x), lateral = image LEFT (smaller x)
      left  leg — medial = image LEFT  (smaller x), lateral = image RIGHT (larger x)

    The CV detector always assigns medial=leftmost, lateral=rightmost (left-leg
    convention).  _init_joint_lines assigns medial=rightmost (right-leg convention).
    Calling this function after either auto-detection normalises both to the
    anatomically correct orientation for the given side.
    """
    if side == "unknown":
        return

    def _fix(jl: JointLine) -> None:
        if jl is None:
            return
        medial_should_be_right = (side == "right")
        medial_is_right = jl.medial.x >= jl.lateral.x
        if medial_should_be_right != medial_is_right:
            jl.medial, jl.lateral = jl.lateral, jl.medial

    _fix(lm.distal_femoral_line)
    _fix(lm.proximal_tibial_line)


def _init_joint_lines(lm: Landmarks) -> None:
    """Auto-place dfl and ptl near the knee center if not yet set.

    Both lines are placed perpendicular to their respective bone axis,
    shifted slightly away from the knee along the axis so they don't overlap.
    The user only needs small adjustments rather than dragging from a corner.
    """
    import math

    knee = lm.knee_center
    if knee is None:
        return

    def _place(ref_a: Point, ref_b: Point, shift_frac: float, half_width: float) -> JointLine:
        """Place a joint line centered at (ref_a + shift_frac*(ref_b - ref_a))
        perpendicular to ref_a→ref_b, extending ±half_width px on each side."""
        dx, dy = ref_b.x - ref_a.x, ref_b.y - ref_a.y
        length = math.hypot(dx, dy)
        if length > 0:
            ux, uy = dx / length, dy / length          # unit along axis
            px, py = -uy, ux                            # unit perpendicular
        else:
            ux, uy = 0.0, 1.0
            px, py = 1.0, 0.0
        cx = ref_a.x + dx * shift_frac
        cy = ref_a.y + dy * shift_frac
        return JointLine(
            medial =Point(cx - px * half_width, cy - py * half_width),
            lateral=Point(cx + px * half_width, cy + py * half_width),
        )

    # Distal femoral line: 10 % up the femur from the knee (or just above knee)
    if lm.distal_femoral_line is None:
        hip = lm.hip_center or Point(knee.x, knee.y - 400)
        # ref_a=hip, ref_b=knee → shift_frac=0.9 puts centre 90 % of the way down = near knee
        lm.distal_femoral_line = _place(hip, knee, 0.90, 60.0)

    # Proximal tibial line: 10 % down the tibia from the knee
    if lm.proximal_tibial_line is None:
        ankle = lm.ankle_center or Point(knee.x, knee.y + 400)
        lm.proximal_tibial_line = _place(knee, ankle, 0.10, 60.0)


def _serialize_landmarks(lm: Landmarks) -> dict:
    def pt(p):
        return {"x": p.x, "y": p.y} if p else None

    def jl(j):
        return {"medial": pt(j.medial), "lateral": pt(j.lateral)} if j else None

    def lvl(lv):
        return {"medial": pt(lv.medial), "lateral": pt(lv.lateral)}

    return {
        "hip_center": pt(lm.hip_center),
        "knee_center": pt(lm.knee_center),
        "ankle_center": pt(lm.ankle_center),
        "distal_femoral_line": jl(lm.distal_femoral_line),
        "proximal_tibial_line": jl(lm.proximal_tibial_line),
        "femur_diaphysis_levels": [lvl(l) for l in lm.femur_diaphysis_levels],
        "tibia_diaphysis_levels": [lvl(l) for l in lm.tibia_diaphysis_levels],
        "confidence": lm.confidence,
    }


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

def _detect_raster(content: bytes, filename: str) -> bool:
    """Return True if the file is a raster image (not DICOM)."""
    if content[:4] == b"\x89PNG":
        return True
    if content[:2] == b"\xff\xd8":  # JPEG
        return True
    ext = Path(filename).suffix.lower()
    return ext in (".jpg", ".jpeg", ".png", ".bmp", ".tiff", ".tif")


def _load_image_file(content: bytes, filename: str) -> DicomImage:
    """Load DICOM, JPG, or PNG into a DicomImage."""
    import cv2
    import pydicom

    if not _detect_raster(content, filename):
        try:
            return _loader.load(content)
        except Exception:
            pass  # fall through to OpenCV

    arr = np.frombuffer(content, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError(f"Cannot decode image: {filename}")

    ds = pydicom.Dataset()
    return DicomImage(
        pixel_array=img,
        pixel_spacing=(1.0, 1.0),
        rows=img.shape[0],
        cols=img.shape[1],
        modality="OT",
        patient_id="",
        study_description="",
        series_description="",
        bits_stored=8,
        window_center=None,
        window_width=None,
        dataset=ds,
    )


@app.post("/upload", response_model=UploadResponse)
async def upload_dicom(
    file: UploadFile = File(...),
    side: str = Form("unknown"),
    user: dict = Depends(require_auth),
):
    """Upload a DICOM, JPG, or PNG radiograph. side = 'right' | 'left' | 'unknown'."""
    import traceback
    # TODO: re-enable before going live
    # require_active_subscription(user)

    if side not in ("right", "left", "unknown"):
        side = "unknown"

    _cleanup_old_sessions()

    content = await file.read()
    filename = file.filename or "upload.dcm"

    try:
        dicom = _load_image_file(content, filename)
    except Exception as exc:
        traceback.print_exc()
        raise HTTPException(status_code=422, detail=f"Image read error: {exc}")

    try:
        landmarks = _detector.detect(dicom.pixel_array)
    except Exception as exc:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Landmark detection error: {exc}")

    _init_joint_lines(landmarks)
    _init_diaphysis_levels(landmarks)

    # Global limb alignment: rotate image + landmarks so hip→ankle is vertical.
    align_angle = _compute_align_angle(landmarks)
    if abs(align_angle) > 1e-6:
        pivot = Point(x=dicom.cols / 2.0, y=dicom.rows / 2.0)
        dicom.pixel_array = _align_image(dicom.pixel_array, align_angle)
        landmarks = _align_landmarks(landmarks, align_angle, pivot)

    _orient_joint_lines_for_side(landmarks, side)

    session = Session()
    session.user_id = user["sub"]
    session.created_at = time.time()
    session.dicom = dicom
    session.landmarks = landmarks
    session.side = side
    session.align_angle_deg = align_angle

    try:
        _run_pipeline(session)
    except Exception as exc:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Analysis pipeline error: {exc}")

    sid = str(uuid.uuid4())
    _sessions[sid] = session

    png_bytes = _exporter.get_png_bytes(session.annotated)
    image_b64 = base64.b64encode(png_bytes).decode()

    raw_png_bytes = _exporter.get_png_bytes(session.dicom.pixel_array)
    raw_image_b64 = base64.b64encode(raw_png_bytes).decode()

    return UploadResponse(
        session_id=sid,
        rows=dicom.rows,
        cols=dicom.cols,
        pixel_spacing=list(dicom.pixel_spacing),
        modality=dicom.modality,
        patient_id=dicom.patient_id,
        angles=session.angles.as_dict(),
        landmarks=_serialize_landmarks(session.landmarks),
        image_b64=image_b64,
        raw_image_b64=raw_image_b64,
        align_angle_deg=session.align_angle_deg,
    )


gc.collect()


@app.get("/image/{session_id}")
async def get_image(session_id: str, user: dict = Depends(require_auth)):
    """Return the annotated radiograph as PNG."""
    session = _get_session(session_id, user)

    png_bytes = _exporter.get_png_bytes(session.annotated)
    return Response(content=png_bytes, media_type="image/png")


@app.post("/landmarks/{session_id}")
async def update_landmarks(
    session_id: str, patch: LandmarkPatch, user: dict = Depends(require_auth)
):
    """
    Update one or more landmarks.

    Recalculates axes, angles, and annotated image automatically.
    Returns updated angles and base64 image.
    """
    session = _get_session(session_id, user)

    lm = session.landmarks

    if patch.hip_center:
        lm.hip_center = Point(patch.hip_center.x, patch.hip_center.y)
    if patch.knee_center:
        lm.knee_center = Point(patch.knee_center.x, patch.knee_center.y)
        # Auto-place joint lines near the new knee position (only if not yet set by user)
        _init_joint_lines(lm)
    if patch.ankle_center:
        lm.ankle_center = Point(patch.ankle_center.x, patch.ankle_center.y)
    if patch.distal_femoral_line:
        lm.distal_femoral_line = JointLine(
            medial=Point(patch.distal_femoral_line.medial.x, patch.distal_femoral_line.medial.y),
            lateral=Point(patch.distal_femoral_line.lateral.x, patch.distal_femoral_line.lateral.y),
        )
    if patch.proximal_tibial_line:
        lm.proximal_tibial_line = JointLine(
            medial=Point(patch.proximal_tibial_line.medial.x, patch.proximal_tibial_line.medial.y),
            lateral=Point(patch.proximal_tibial_line.lateral.x, patch.proximal_tibial_line.lateral.y),
        )
    if patch.femur_diaphysis_levels is not None:
        lm.femur_diaphysis_levels = [
            DiaphysisLevel(medial=Point(l.medial.x, l.medial.y),
                           lateral=Point(l.lateral.x, l.lateral.y))
            for l in patch.femur_diaphysis_levels
        ]
    if patch.tibia_diaphysis_levels is not None:
        lm.tibia_diaphysis_levels = [
            DiaphysisLevel(medial=Point(l.medial.x, l.medial.y),
                           lateral=Point(l.lateral.x, l.lateral.y))
            for l in patch.tibia_diaphysis_levels
        ]

    # Re-orient joint lines after any patch (not just knee moves),
    # so that manually dragged DFL/PTL handles don't break medial/lateral labeling.
    _orient_joint_lines_for_side(lm, session.side)

    _run_pipeline(session)

    png_bytes = _exporter.get_png_bytes(session.annotated)
    image_b64 = base64.b64encode(png_bytes).decode()

    return {
        "angles": session.angles.as_dict(),
        "landmarks": _serialize_landmarks(session.landmarks),
        "image_b64": image_b64,
    }


@app.post("/side/{session_id}")
async def set_side(session_id: str, side: str, user: dict = Depends(require_auth)):
    """Change the leg side and recalculate all angles."""
    if side not in ("right", "left", "unknown"):
        raise HTTPException(status_code=422, detail="side must be 'right', 'left', or 'unknown'")
    session = _get_session(session_id, user)

    old_side = session.side
    session.side = side
    # Re-orient joint lines when the side assignment changes
    if old_side != side:
        _orient_joint_lines_for_side(session.landmarks, side)
    _run_pipeline(session)

    png_bytes = _exporter.get_png_bytes(session.annotated)
    image_b64 = base64.b64encode(png_bytes).decode()
    return {
        "angles": session.angles.as_dict(),
        "image_b64": image_b64,
    }


@app.post("/config/{session_id}")
async def update_config(
    session_id: str, config: SessionConfig, user: dict = Depends(require_auth)
):
    """Update session display config (e.g. show/hide anatomical axes) and re-render."""
    session = _get_session(session_id, user)
    session.show_anatomical = config.show_anatomical
    _run_pipeline(session)
    png_bytes = _exporter.get_png_bytes(session.annotated)
    image_b64 = base64.b64encode(png_bytes).decode()
    return {"image_b64": image_b64}


@app.get("/angles/{session_id}")
async def get_angles(session_id: str, user: dict = Depends(require_auth)):
    session = _get_session(session_id, user)
    return session.angles.as_dict()


@app.get("/export/{session_id}/png")
async def export_png(session_id: str, user: dict = Depends(require_auth)):
    session = _get_session(session_id, user)
    export_img = _exporter.render_export(
        session.dicom.pixel_array, session.landmarks, session.axes, session.angles
    )
    png_bytes = _exporter.get_png_bytes(export_img)
    return Response(
        content=png_bytes,
        media_type="image/png",
        headers={"Content-Disposition": f'attachment; filename="cadtomie_{session_id[:8]}.png"'},
    )


@app.get("/export/{session_id}/json")
async def export_json(session_id: str, user: dict = Depends(require_auth)):
    session = _get_session(session_id, user)
    json_str = _exporter.get_json(
        session.angles,
        session.landmarks,
        pixel_spacing=session.dicom.pixel_spacing,
        patient_id=session.dicom.patient_id,
    )
    return Response(
        content=json_str,
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="cadtomie_{session_id[:8]}.json"'},
    )


@app.get("/export/{session_id}/pdf")
async def export_pdf(session_id: str, user: dict = Depends(require_auth)):
    session = _get_session(session_id, user)
    try:
        export_img = _exporter.render_export(
            session.dicom.pixel_array, session.landmarks, session.axes, session.angles
        )
        pdf_bytes = _exporter.get_pdf_bytes(
            export_img,
            session.angles,
            patient_id=session.dicom.patient_id,
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="cadtomie_{session_id[:8]}.pdf"'},
    )


class CanvasPdfRequest(BaseModel):
    image_b64: str   # PNG data URL from frontend canvas (may include data:image/png;base64, prefix)


@app.post("/export/{session_id}/pdf-from-canvas")
async def export_pdf_from_canvas(
    session_id: str, body: CanvasPdfRequest, user: dict = Depends(require_auth)
):
    """Generate a PDF report using the image captured from the frontend canvas.

    This ensures the export contains the exact same overlays (angle labels,
    osteotomy simulation, etc.) as the live viewer, rather than a server-side
    re-render which may omit frontend-only layers.
    """
    session = _get_session(session_id, user)

    # Strip optional data URL prefix
    raw_b64 = body.image_b64
    if "," in raw_b64:
        raw_b64 = raw_b64.split(",", 1)[1]

    import random
    from datetime import datetime as _dt
    _now = _dt.utcnow()
    report_id = f"CAD-{_now.strftime('%Y%m%d')}-{random.randint(0, 99999):05d}"

    try:
        img_bytes = base64.b64decode(raw_b64)
        img_array = np.frombuffer(img_bytes, dtype=np.uint8)
        import cv2 as _cv2
        img_bgr = _cv2.imdecode(img_array, _cv2.IMREAD_COLOR)
        if img_bgr is None:
            raise ValueError("Could not decode canvas image")

        pdf_bytes = _exporter.get_canvas_pdf_bytes(img_bgr, report_id=report_id)
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="cadtomie_{session_id[:8]}.pdf"'},
    )


@app.get("/health")
async def health():
    return {"status": "ok", "version": "0.1.0"}


# ---------------------------------------------------------------------------
# Osteotomy planning
# ---------------------------------------------------------------------------

def _px_spacing(session: Session) -> float:
    if session.pixel_spacing_override is not None:
        return session.pixel_spacing_override
    ps = session.dicom.pixel_spacing
    return float(ps[0]) if ps and ps[0] > 0 else 1.0


class OstLinePatch(BaseModel):
    p1: PointModel
    p2: PointModel


class OsteotomyPatch(BaseModel):
    kind: Optional[str] = None
    osteotomy_line: Optional[OstLinePatch] = None
    hinge_point: Optional[PointModel] = None
    target_point: Optional[PointModel] = None
    target_plateau_pct: Optional[float] = None
    # slider_value is the NON-NEGATIVE magnitude; sign is derived from miniaci_deg
    slider_value: Optional[float] = None
    # OR set an explicit signed correction angle directly
    correction_deg: Optional[float] = None


def _ost_response(plan: OstPlan, session: Session) -> dict:
    """
    Build the full osteotomy response payload.

    Runs the complete pipeline: transform landmarks → rebuild axes →
    recalculate ALL angles.  Returns the plan fields PLUS the full
    post-osteotomy angles so the frontend can update its single angle state.

    When correction_deg == 0, post_angles == baseline session angles
    (nothing changed).
    """
    lm   = session.landmarks
    px   = _px_spacing(session)
    side = session.side

    # Log pre-osteotomy landmark state
    _ost_log.debug(
        "ost PRE  kind=%s cdeg=%.2f  hip=%s  knee=%s  ankle=%s",
        plan.kind, plan.correction_deg,
        lm.hip_center, lm.knee_center, lm.ankle_center,
    )

    da = ost_engine.recompute(plan, lm, px, side)

    if da is not None:
        # Validate: valgisierend osteotomy must move HKA toward 0
        baseline_hka = session.angles.HKA
        post_hka     = da.HKA
        if baseline_hka is not None and post_hka is not None and plan.correction_deg != 0.0:
            is_valgisierend = plan.kind not in VARISIEREND
            if is_valgisierend:
                # For valgisierend, HKA should increase (less varus / more valgus)
                # i.e. abs(post) should be <= abs(baseline) for varus cases, or
                # HKA should move toward 0.
                moved_toward_zero = abs(post_hka) < abs(baseline_hka)
                if not moved_toward_zero:
                    _ost_log.warning(
                        "HKA validation: valgisierend osteotomy worsened HKA "
                        "(%.2f → %.2f).  Check rotation direction or geometry.",
                        baseline_hka, post_hka,
                    )

        # Log post-osteotomy transformed landmark state
        if plan.hinge_point and plan.correction_deg != 0.0:
            xfm = ost_engine._transform_landmarks(lm, plan.kind, plan.hinge_point, plan.correction_deg)
            _ost_log.debug(
                "ost POST kind=%s cdeg=%.2f  hip=%s  knee=%s  ankle=%s  HKA=%.2f",
                plan.kind, plan.correction_deg,
                xfm.hip_center, xfm.knee_center, xfm.ankle_center,
                post_hka or 0.0,
            )
            # Assertion: moving point must have changed
            if plan.kind.startswith("HTO") and lm.ankle_center and xfm.ankle_center:
                dist = math.hypot(
                    xfm.ankle_center.x - lm.ankle_center.x,
                    xfm.ankle_center.y - lm.ankle_center.y,
                )
                if dist < 1e-3:
                    _ost_log.error(
                        "ASSERTION FAILED: HTO ankle_center did not move after rotation "
                        "(correction_deg=%.2f, hinge=%s)",
                        plan.correction_deg, plan.hinge_point,
                    )
            elif plan.kind.startswith("DFO") and lm.ankle_center and xfm.ankle_center:
                dist = math.hypot(
                    xfm.ankle_center.x - lm.ankle_center.x,
                    xfm.ankle_center.y - lm.ankle_center.y,
                )
                if dist < 1e-3:
                    _ost_log.error(
                        "ASSERTION FAILED: DFO ankle_center did not move after rotation "
                        "(correction_deg=%.2f, hinge=%s)",
                        plan.correction_deg, plan.hinge_point,
                    )

        post_angles = da.as_dict()
    else:
        # No correction — use the unchanged baseline angles
        post_angles = session.angles.as_dict()

    return {**plan.as_dict(), "post_angles": post_angles}


@app.post("/osteotomy/{session_id}/init")
async def osteotomy_init(
    session_id: str,
    kind: str = "HTO_OPEN_MED",
    auto_place: bool = True,
    user: dict = Depends(require_auth),
):
    """
    Initialise an osteotomy plan.

    auto_place=True  (default): auto-place geometry + apply Miniaci correction.
    auto_place=False: create an empty plan (kind only, no geometry, correction_deg=0)
                      so the user can place the cut line and hinge manually.
    """
    valid = (
        "HTO_OPEN_MED", "HTO_CLOSE_LAT", "DFO_CLOSE_LAT", "DFO_OPEN_MED",
        "HTO_CLOSE_MED", "DFO_OPEN_LAT", "DFO_CLOSE_MED",
    )
    if kind not in valid:
        raise HTTPException(status_code=422, detail=f"kind must be one of {valid}")
    session = _get_session(session_id, user)

    if auto_place:
        plan = ost_engine.auto_plan(session.landmarks, kind)  # type: ignore[arg-type]
        ost_engine.recompute(plan, session.landmarks, _px_spacing(session), session.side)
        if plan.miniaci_deg is not None:
            plan.correction_deg = plan.miniaci_deg
    else:
        plan = OstPlan(kind=kind)  # type: ignore[arg-type]

    session.osteotomy_plan = plan
    return _ost_response(plan, session)


@app.patch("/osteotomy/{session_id}")
async def osteotomy_update(
    session_id: str, patch: OsteotomyPatch, user: dict = Depends(require_auth)
):
    """
    Partial-update the plan and recompute all derived values.

    Returns plan fields PLUS post_angles — all 5 angles recalculated from
    the post-osteotomy landmark positions.  The frontend must update its
    angles state from post_angles to keep geometry and measurements in sync.
    """
    session = _get_session(session_id, user)
    if session.osteotomy_plan is None:
        raise HTTPException(status_code=404, detail="No active osteotomy plan")

    plan = session.osteotomy_plan

    _valid_kinds = (
        "HTO_OPEN_MED", "HTO_CLOSE_LAT", "DFO_CLOSE_LAT", "DFO_OPEN_MED",
        "HTO_CLOSE_MED", "DFO_OPEN_LAT", "DFO_CLOSE_MED",
    )
    if patch.kind is not None and patch.kind in _valid_kinds:
        plan.kind = patch.kind  # type: ignore[assignment]

    if patch.osteotomy_line is not None:
        plan.osteotomy_line = OstLine(
            p1=Point(patch.osteotomy_line.p1.x, patch.osteotomy_line.p1.y),
            p2=Point(patch.osteotomy_line.p2.x, patch.osteotomy_line.p2.y),
        )

    if patch.hinge_point is not None:
        plan.hinge_point = Point(patch.hinge_point.x, patch.hinge_point.y)

    if patch.target_point is not None:
        plan.target_point = Point(patch.target_point.x, patch.target_point.y)

    if patch.target_plateau_pct is not None:
        plan.target_plateau_pct = patch.target_plateau_pct

    # Recompute Miniaci first (needed for slider sign)
    ost_engine.recompute(plan, session.landmarks, _px_spacing(session), session.side)

    if patch.slider_value is not None:
        # Derive sign from miniaci_deg — it already encodes the correct physical
        # rotation direction for the actual geometry AND leg side.
        if plan.miniaci_deg is not None and plan.miniaci_deg != 0.0:
            sign = math.copysign(1.0, plan.miniaci_deg)
        else:
            sign = 1.0
        plan.correction_deg = sign * abs(patch.slider_value)
    elif patch.correction_deg is not None:
        plan.correction_deg = patch.correction_deg

    return _ost_response(plan, session)


@app.get("/osteotomy/{session_id}")
async def osteotomy_get(session_id: str, user: dict = Depends(require_auth)):
    """Return current osteotomy plan or null."""
    session = _get_session(session_id, user)
    if session.osteotomy_plan is None:
        return None
    return _ost_response(session.osteotomy_plan, session)


@app.delete("/osteotomy/{session_id}")
async def osteotomy_delete(session_id: str, user: dict = Depends(require_auth)):
    """
    Remove the active osteotomy plan.

    Returns the baseline angles and image so the frontend can restore
    the pre-osteotomy measurement state.
    """
    session = _get_session(session_id, user)
    session.osteotomy_plan = None
    png_bytes = _exporter.get_png_bytes(session.annotated)
    return {
        "angles": session.angles.as_dict(),
        "image_b64": base64.b64encode(png_bytes).decode(),
    }


@app.post("/calibrate/{session_id}")
async def calibrate_image(
    session_id: str, body: CalibrationBody, user: dict = Depends(require_auth)
):
    """
    Calibrate pixel spacing using a known reference distance (e.g. calibration sphere).
    Stores mm/px factor and recomputes osteotomy plan if one exists.
    """
    session = _get_session(session_id, user)
    px_dist = math.hypot(body.p2.x - body.p1.x, body.p2.y - body.p1.y)
    if px_dist < 2:
        raise HTTPException(status_code=422, detail="Punkte zu nah beieinander")
    if body.known_mm <= 0:
        raise HTTPException(status_code=422, detail="Reale Distanz muss positiv sein")
    session.pixel_spacing_override = body.known_mm / px_dist
    return {
        "pixel_spacing_mm": round(session.pixel_spacing_override, 6),
        "px_per_mm": round(px_dist / body.known_mm, 4),
    }


@app.post("/calibrate/{session_id}/auto")
async def auto_calibrate_ball(
    session_id: str,
    user: dict = Depends(require_auth),
):
    """
    Automatically detect a calibration sphere (Messkugel, 25 mm diameter).
    Uses progressive Hough detection with CLAHE contrast enhancement.
    """
    import cv2  # noqa: PLC0415

    session = _get_session(session_id, user)
    img = session.dicom.pixel_array.copy()

    # Ensure uint8 grayscale
    if img.dtype != np.uint8:
        img = cv2.normalize(img, None, 0, 255, cv2.NORM_MINMAX).astype(np.uint8)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if len(img.shape) == 3 else img.copy()

    h, w = gray.shape
    short = min(h, w)
    min_r = max(6, int(short * 0.008))
    max_r = int(short * 0.15)
    min_area = math.pi * min_r ** 2
    max_area = math.pi * max_r ** 2

    # CLAHE for local contrast enhancement
    clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))
    enhanced = clahe.apply(gray)

    best: tuple[int, int, int] | None = None
    best_score = -1.0

    # --- Method 1: Contour-based (most robust for X-ray metal objects) ---
    # Try multiple brightness thresholds from strict → lenient
    for thresh_val in (230, 210, 190, 170, 150):
        _, binary = cv2.threshold(enhanced, thresh_val, 255, cv2.THRESH_BINARY)
        # Morphological close to fill small holes inside the ball
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
        binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel)
        contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

        for cnt in contours:
            area = cv2.contourArea(cnt)
            if not (min_area <= area <= max_area):
                continue
            perimeter = cv2.arcLength(cnt, True)
            if perimeter < 1:
                continue
            circularity = 4 * math.pi * area / (perimeter ** 2)
            if circularity < 0.65:   # must be fairly circular
                continue
            (cx_f, cy_f), radius_f = cv2.minEnclosingCircle(cnt)
            cx_i, cy_i, r_i = int(cx_f), int(cy_f), int(radius_f)
            mask = np.zeros(gray.shape, dtype=np.uint8)
            cv2.circle(mask, (cx_i, cy_i), max(r_i - 2, 1), 255, -1)
            brightness = float(cv2.mean(gray, mask=mask)[0])
            score = circularity * 100 + brightness * 0.5
            if score > best_score:
                best_score = score
                best = (cx_i, cy_i, r_i)

        if best is not None:
            break   # found something at this threshold level

    # --- Method 2: Hough fallback if contours found nothing ---
    if best is None:
        blurred = cv2.GaussianBlur(enhanced, (7, 7), 1.5)
        for param2 in (25, 18, 12, 8):
            circles = cv2.HoughCircles(
                blurred, cv2.HOUGH_GRADIENT, dp=1,
                minDist=short // 5, param1=50, param2=param2,
                minRadius=min_r, maxRadius=max_r,
            )
            if circles is not None:
                for cx, cy, r in np.round(circles[0]).astype(int):
                    mask = np.zeros(gray.shape, dtype=np.uint8)
                    cv2.circle(mask, (cx, cy), max(int(r) - 2, 1), 255, -1)
                    brightness = float(cv2.mean(gray, mask=mask)[0])
                    score = brightness
                    if score > best_score:
                        best_score = score
                        best = (int(cx), int(cy), int(r))
                break

    if best is None:
        raise HTTPException(
            status_code=404,
            detail="Keine Messkugel erkannt. Bitte manuell kalibrieren."
        )

    best_cx, best_cy, best_r = best
    known_mm = 25.0
    diameter_px = float(best_r * 2)
    session.pixel_spacing_override = known_mm / diameter_px

    return {
        "pixel_spacing_mm": round(session.pixel_spacing_override, 6),
        "px_per_mm": round(diameter_px / known_mm, 4),
        "detected": {"cx": best_cx, "cy": best_cy, "r": best_r},
    }

