"""
Export module.

Generates annotated images, measurement reports, and JSON summaries.
"""
from __future__ import annotations

import io
import json
from datetime import datetime
from pathlib import Path
from typing import Optional

import cv2
import numpy as np
from PIL import Image

from angle_measurement.angles import DeformityAngles
from axis_calculation.axes import LimbAxes
from landmark_detection.types import Landmarks


# Colours (BGR)
COLOUR_HIP = (0, 255, 0)
COLOUR_KNEE = (0, 255, 255)
COLOUR_ANKLE = (255, 128, 0)
COLOUR_FEMUR_MECH = (255, 50, 50)
COLOUR_TIBIA_MECH = (50, 100, 255)
COLOUR_FEMUR_ANAT = (200, 200, 0)
COLOUR_TIBIA_ANAT = (0, 200, 200)
COLOUR_JOINT_LINE = (255, 255, 0)
COLOUR_MIKULICZ = (255, 0, 255)  # magenta
COLOUR_TEXT = (255, 255, 255)
RADIUS_LANDMARK = 5
THICKNESS_AXIS = 1
THICKNESS_JOINT = 1
FONT = cv2.FONT_HERSHEY_SIMPLEX
FONT_SCALE = 0.4
FONT_THICKNESS = 1


class Exporter:
    """Render overlays and produce export artefacts."""

    # ------------------------------------------------------------------
    # Annotated image
    # ------------------------------------------------------------------

    def render_overlay(
        self,
        base_image: np.ndarray,
        landmarks: Landmarks,
        axes: LimbAxes,
        angles: DeformityAngles,
        show_anatomical: bool = True,
    ) -> np.ndarray:
        """
        Draw all overlays onto a copy of base_image and return the result.

        base_image : uint8 BGR ndarray
        """
        img = base_image.copy()

        self._draw_axes(img, axes, show_anatomical=show_anatomical)
        self._draw_joint_lines(img, landmarks)
        self._draw_landmarks(img, landmarks, show_anatomical=show_anatomical)

        return img

    def render_export(
        self,
        base_image: np.ndarray,
        landmarks: Landmarks,
        axes: LimbAxes,
        angles: DeformityAngles,
    ) -> np.ndarray:
        """Like render_overlay but also adds the angle label panel (for PNG/PDF export)."""
        img = self.render_overlay(base_image, landmarks, axes, angles)
        self._draw_angle_labels(img, angles, landmarks)
        return img

    def save_png(
        self,
        image: np.ndarray,
        path: str | Path,
    ) -> None:
        cv2.imwrite(str(path), image)

    def get_png_bytes(self, image: np.ndarray) -> bytes:
        success, buf = cv2.imencode(".png", image)
        if not success:
            raise RuntimeError("PNG encoding failed")
        return buf.tobytes()

    # ------------------------------------------------------------------
    # JSON report
    # ------------------------------------------------------------------

    def get_json(
        self,
        angles: DeformityAngles,
        landmarks: Landmarks,
        pixel_spacing: tuple[float, float] = (1.0, 1.0),
        patient_id: str = "",
    ) -> str:
        data = {
            "generated_at": datetime.utcnow().isoformat(),
            "patient_id": patient_id,
            "pixel_spacing_mm": list(pixel_spacing),
            "angles": angles.as_dict(),
            "landmarks": self._serialize_landmarks(landmarks),
        }
        return json.dumps(data, indent=2)

    # ------------------------------------------------------------------
    # PDF report
    # ------------------------------------------------------------------

    def get_pdf_bytes(
        self,
        annotated_image: np.ndarray,
        angles: DeformityAngles,
        patient_id: str = "",
    ) -> bytes:
        try:
            from reportlab.lib import colors
            from reportlab.lib.pagesizes import A4
            from reportlab.lib.units import cm
            from reportlab.platypus import (
                Image as RLImage,
                Paragraph,
                SimpleDocTemplate,
                Spacer,
                Table,
                TableStyle,
            )
            from reportlab.lib.styles import getSampleStyleSheet
        except ImportError:
            raise RuntimeError("reportlab not installed. Run: pip install reportlab")

        buf = io.BytesIO()
        doc = SimpleDocTemplate(buf, pagesize=A4)
        styles = getSampleStyleSheet()
        story = []

        # Title
        story.append(Paragraph("CADtomie – Deformity Analysis Report", styles["Title"]))
        story.append(Spacer(1, 0.3 * cm))
        story.append(Paragraph(f"Patient: {patient_id or 'N/A'}", styles["Normal"]))
        story.append(Paragraph(
            f"Date: {datetime.utcnow().strftime('%Y-%m-%d %H:%M UTC')}",
            styles["Normal"],
        ))
        story.append(Spacer(1, 0.5 * cm))

        # Angle table
        angle_dict = angles.as_dict()
        table_data = [["Parameter", "Value (°)", "Normal Range", "Interpretation"]]
        norms = {
            "HKA_deg": "0 ± 3",
            "mLDFA_deg": "85–90",
            "mMPTA_deg": "85–90",
            "JLCA_deg": "< 2",
        }
        for key, label in [
            ("HKA_deg", "HKA"),
            ("mLDFA_deg", "mLDFA"),
            ("mMPTA_deg", "mMPTA"),
            ("JLCA_deg", "JLCA"),
        ]:
            val = angle_dict.get(key)
            val_str = f"{val:.1f}" if val is not None else "—"
            note = angle_dict.get("notes", {}).get(key.replace("_deg", ""), "—")
            table_data.append([label, val_str, norms.get(key, "—"), note])

        tbl = Table(table_data, colWidths=[4 * cm, 3 * cm, 3.5 * cm, 5 * cm])
        tbl.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), colors.darkblue),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ("GRID", (0, 0), (-1, -1), 0.5, colors.grey),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.whitesmoke, colors.white]),
        ]))
        story.append(tbl)
        story.append(Spacer(1, 0.5 * cm))

        # Annotated image
        img_pil = Image.fromarray(cv2.cvtColor(annotated_image, cv2.COLOR_BGR2RGB))
        img_buf = io.BytesIO()
        img_pil.save(img_buf, format="PNG")
        img_buf.seek(0)

        max_w = 14 * cm
        ar = annotated_image.shape[0] / annotated_image.shape[1]
        rl_img = RLImage(img_buf, width=max_w, height=max_w * ar)
        story.append(rl_img)

        doc.build(story)
        return buf.getvalue()

    def get_canvas_pdf_bytes(
        self,
        canvas_image: np.ndarray,
        report_id: str = "",
    ) -> bytes:
        """Wrap a frontend-rendered canvas PNG in a PDF with a footer.

        The canvas already contains the full premium layout (header, images,
        measurement panel).  This method just fits it to the page and appends
        a footer with the Report ID and legal disclaimer — no duplicate content.
        """
        try:
            from reportlab.lib import colors
            from reportlab.lib.pagesizes import A4, landscape
            from reportlab.lib.units import cm
            from reportlab.lib.styles import ParagraphStyle
            from reportlab.platypus import (
                Image as RLImage,
                Paragraph,
                SimpleDocTemplate,
                Spacer,
            )
        except ImportError:
            raise RuntimeError("reportlab not installed. Run: pip install reportlab")

        # Choose page orientation to match canvas aspect ratio
        h, w = canvas_image.shape[:2]
        page_size = landscape(A4) if w > h else A4
        page_w, page_h = page_size

        margin = 1.2 * cm
        footer_reserved = 1.4 * cm   # space kept below image for footer text

        img_area_w = page_w - 2 * margin
        img_area_h = page_h - 2 * margin - footer_reserved

        # Fit image proportionally into the available area
        ar = h / w
        if ar * img_area_w <= img_area_h:
            img_w = img_area_w
            img_h = img_area_w * ar
        else:
            img_h = img_area_h
            img_w = img_area_h / ar

        # Encode canvas to PNG bytes for reportlab
        img_pil = Image.fromarray(cv2.cvtColor(canvas_image, cv2.COLOR_BGR2RGB))
        img_buf = io.BytesIO()
        img_pil.save(img_buf, format="PNG")
        img_buf.seek(0)

        buf = io.BytesIO()
        doc = SimpleDocTemplate(
            buf, pagesize=page_size,
            leftMargin=margin, rightMargin=margin,
            topMargin=margin, bottomMargin=margin,
        )

        # Footer styles — light gray, centered
        GRAY = colors.HexColor("#9CA3AF")
        id_style = ParagraphStyle(
            "report_id",
            fontSize=9,
            textColor=GRAY,
            alignment=1,
            spaceAfter=3,
        )
        disclaimer_style = ParagraphStyle(
            "disclaimer",
            fontSize=8,
            textColor=GRAY,
            alignment=1,
        )

        story: list = [RLImage(img_buf, width=img_w, height=img_h)]

        if report_id:
            story.append(Spacer(1, 0.35 * cm))
            story.append(Paragraph(f"Report ID: {report_id}", id_style))

        story.append(
            Paragraph(
                "This tool is intended for educational and training purposes only. "
                "It is not intended for clinical decision-making or treatment planning.",
                disclaimer_style,
            )
        )

        doc.build(story)
        return buf.getvalue()

    # ------------------------------------------------------------------
    # Private drawing helpers
    # ------------------------------------------------------------------

    def _draw_axes(self, img: np.ndarray, axes: LimbAxes, show_anatomical: bool = True) -> None:
        h, w = img.shape[:2]

        def draw_axis(axis, colour, label=""):
            if axis is None:
                return
            p1 = (int(axis.start.x), int(axis.start.y))
            p2 = (int(axis.end.x), int(axis.end.y))
            cv2.line(img, p1, p2, colour, THICKNESS_AXIS, cv2.LINE_AA)
            mid = (
                (p1[0] + p2[0]) // 2 + 10,
                (p1[1] + p2[1]) // 2,
            )
            if label:
                cv2.putText(img, label, mid, FONT, FONT_SCALE, colour, FONT_THICKNESS)

        draw_axis(axes.femur_mechanical, COLOUR_FEMUR_MECH, "Fem mech")
        draw_axis(axes.tibia_mechanical, COLOUR_TIBIA_MECH, "Tib mech")
        if show_anatomical:
            draw_axis(axes.femur_anatomical, COLOUR_FEMUR_ANAT, "Fem anat")
            draw_axis(axes.tibia_anatomical, COLOUR_TIBIA_ANAT, "Tib anat")

        # Mikulicz line: extend beyond hip and ankle to fill image
        if axes.mikulicz is not None:
            ax = axes.mikulicz
            p1 = ax.start.as_array()
            p2 = ax.end.as_array()
            d = p2 - p1
            norm = float(np.linalg.norm(d))
            if norm > 0:
                d_unit = d / norm
                ext = float(max(h, w))
                tp1 = p1 - d_unit * ext
                tp2 = p2 + d_unit * ext
                cv2.line(img,
                         (int(tp1[0]), int(tp1[1])),
                         (int(tp2[0]), int(tp2[1])),
                         COLOUR_MIKULICZ, 2, cv2.LINE_AA)
                # Label near the hip
                lx = int(ax.start.x) + 12
                ly = int(ax.start.y) - 12
                cv2.putText(img, "Mikulicz", (lx, ly), FONT, FONT_SCALE, COLOUR_MIKULICZ, FONT_THICKNESS)

    def _draw_joint_lines(self, img: np.ndarray, landmarks: Landmarks) -> None:
        for jl in [landmarks.distal_femoral_line, landmarks.proximal_tibial_line]:
            if jl is None:
                continue
            p1 = (int(jl.medial.x), int(jl.medial.y))
            p2 = (int(jl.lateral.x), int(jl.lateral.y))
            cv2.line(img, p1, p2, COLOUR_JOINT_LINE, THICKNESS_JOINT, cv2.LINE_AA)

    def _draw_landmarks(self, img: np.ndarray, landmarks: Landmarks, show_anatomical: bool = True) -> None:
        pts = [
            (landmarks.hip_center,   COLOUR_HIP,   "Hip"),
            (landmarks.knee_center,  COLOUR_KNEE,  "Knee"),
            (landmarks.ankle_center, COLOUR_ANKLE, "Ankle"),
        ]
        for pt, colour, label in pts:
            if pt is None:
                continue
            cx, cy = int(pt.x), int(pt.y)
            cv2.circle(img, (cx, cy), RADIUS_LANDMARK, colour, -1)
            cv2.circle(img, (cx, cy), RADIUS_LANDMARK + 2, (0, 0, 0), 1)
            cv2.putText(
                img, label,
                (cx + RADIUS_LANDMARK + 3, cy + 5),
                FONT, FONT_SCALE, colour, FONT_THICKNESS,
            )

        # Diaphysis cortex levels (only when anatomical axes are shown)
        if show_anatomical:
            for lvl in landmarks.femur_diaphysis_levels:
                pm = (int(lvl.medial.x), int(lvl.medial.y))
                pl = (int(lvl.lateral.x), int(lvl.lateral.y))
                cv2.line(img, pm, pl, COLOUR_FEMUR_ANAT, 1, cv2.LINE_AA)
                cv2.circle(img, pm, 3, COLOUR_FEMUR_ANAT, -1)
                cv2.circle(img, pl, 3, COLOUR_FEMUR_ANAT, -1)
            for lvl in landmarks.tibia_diaphysis_levels:
                pm = (int(lvl.medial.x), int(lvl.medial.y))
                pl = (int(lvl.lateral.x), int(lvl.lateral.y))
                cv2.line(img, pm, pl, COLOUR_TIBIA_ANAT, 1, cv2.LINE_AA)
                cv2.circle(img, pm, 3, COLOUR_TIBIA_ANAT, -1)
                cv2.circle(img, pl, 3, COLOUR_TIBIA_ANAT, -1)

    def _draw_angle_labels(
        self,
        img: np.ndarray,
        angles: DeformityAngles,
        landmarks: Landmarks,
    ) -> None:
        h, w = img.shape[:2]
        panel_x = w - 200
        y = 30
        items = [
            ("HKA",   angles.HKA),
            ("mLDFA", angles.mLDFA),
            ("mMPTA", angles.mMPTA),
            ("JLCA",  angles.JLCA),
        ]
        # Dark background rectangle
        cv2.rectangle(img, (panel_x - 5, 10), (w - 5, 30 + len(items) * 22), (0, 0, 0), -1)
        for name, val in items:
            val_str = f"{val:.1f}°" if val is not None else "—"
            text = f"{name}: {val_str}"
            cv2.putText(img, text, (panel_x, y), FONT, FONT_SCALE, COLOUR_TEXT, FONT_THICKNESS)
            y += 22

    @staticmethod
    def _serialize_landmarks(lm: Landmarks) -> dict:
        def pt(p):
            return {"x": p.x, "y": p.y} if p else None

        def jl(j):
            if j is None:
                return None
            return {
                "medial": pt(j.medial),
                "lateral": pt(j.lateral),
            }

        return {
            "hip_center": pt(lm.hip_center),
            "knee_center": pt(lm.knee_center),
            "ankle_center": pt(lm.ankle_center),
            "distal_femoral_line": jl(lm.distal_femoral_line),
            "proximal_tibial_line": jl(lm.proximal_tibial_line),
            "confidence": lm.confidence,
        }
