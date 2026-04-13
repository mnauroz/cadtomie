import React, {
  useRef,
  useEffect,
  useState,
  useCallback,
  forwardRef,
  useImperativeHandle,
} from "react";
import type { Landmarks, Point, MeasureStep, AnnotationTool, Annotation, Angles, ImageType } from "../types";
import type { SlopeStep, SlopePoints, SagittalStep, SagittalOsteotomy, ConfirmedSagittalOst } from "../slope/types";
import type { SagittalResult } from "../slope/sagittal_engine";
import { drawSagittalSimulation } from "../slope/sagittal_engine";
import type { OsteotomyPlan, PlanningStep, ConfirmedOsteotomy } from "../osteotomy/types";
import { computeOverlay, rotatePoint } from "../osteotomy/engine";
import type { Lang } from "../i18n/translations";
import { translations, formatNumber } from "../i18n/translations";
import { useTranslation } from "../i18n/LanguageContext";
import { drawOsteotomySimulation } from "../osteotomy/simulation";
import { circumscribedCircle } from "./CalibrationPanel";
import type { CalibMode, CalibType } from "./CalibrationPanel";
import styles from "./DicomViewer.module.css";

interface Props {
  imageB64: string;
  /** Unannotated DICOM pixels — used as simulation base so bone-fragment rotation
   *  does not inherit any axis lines drawn by the backend renderer. */
  rawImageB64?: string;
  /** Backend-annotated image frozen before the first osteotomy was confirmed.
   *  Used as the "Ausgangsbefund" center column in the structured export. */
  baseAnnotatedImageB64?: string;
  sessionKey?: string;   // changes on new upload; stable during landmark edits
  landmarks: Landmarks | null;
  onLandmarkMove: (target: string, point: Point, side?: "medial" | "lateral") => void;
  loading: boolean;
  showAnatomical?: boolean;
  onCanvasClick?: (pt: Point) => void;
  calibMode?: CalibMode;
  calibType?: CalibType;
  calibPoints?: { p1?: Point; p2?: Point; p3?: Point };
  // Planning
  plan?: OsteotomyPlan | null;
  planningStep?: PlanningStep;
  pendingOstP1?: Point | null;
  confirmedOsteotomies?: ConfirmedOsteotomy[];
  onPlanPointMove?: (field: "osteotomy_line_p1" | "osteotomy_line_p2" | "hinge_point" | "target_point", pt: Point) => void;
  // Guided landmark placement
  measureStep?: MeasureStep;
  hipMeasPts?: Point[];
  femurMeasPts?: Point[];
  tibiaMeasPts?: Point[];
  ankleMeasPts?: Point[];
  // Annotation tools
  annotations?: Annotation[];
  activeTool?: AnnotationTool;
  pendingAnnotPts?: Point[];
  pixelSpacingMm?: number | null;
  angles?: Angles | null;
  /** Angles frozen before the first osteotomy was confirmed — pre-op baseline. */
  baseAngles?: Angles | null;
  /** Landmarks frozen before the first osteotomy was confirmed — pre-op baseline for export. */
  baseLandmarks?: Landmarks | null;
  /** Current step in the tibial slope measurement workflow. */
  slopeStep?: SlopeStep;
  /** Placed points for tibial slope measurement. */
  slopePts?: SlopePoints;
  /** Computed slope value (degrees) — shown as canvas label when done. */
  slopeValue?: number | null;
  /** Current step in the sagittal osteotomy simulation workflow. */
  sagittalStep?: SagittalStep;
  /** Placed geometry for the sagittal osteotomy. */
  sagittalOst?: SagittalOsteotomy;
  /** Computed correction result — live while slider moves. */
  sagittalResult?: SagittalResult | null;
  /** Confirmed sagittal osteotomies — rendered persistently below active simulation. */
  confirmedSagittalOsts?: ConfirmedSagittalOst[];
  /** Current image type — gates which overlay layers are drawn. */
  imageType?: ImageType;
  /** Current UI language — used for canvas export text. */
  lang?: Lang;
}

// Draggable handle descriptors
interface Handle {
  id: string;
  target: string;
  side?: "medial" | "lateral";
  x: number;  // in IMAGE pixels
  y: number;
  color: string;
  radius: number;
  label: string;
  /** When false the handle is displayed but cannot be dragged (e.g. during osteotomy simulation). */
  draggable?: boolean;
}

export interface DicomViewerHandle {
  /** Capture the current canvas (exact live view) as a PNG data URL. */
  captureCanvas: () => string | null;
  /** Compose a premium medical report canvas (header + images + measurement cards) and return it as a PNG data URL. */
  captureExportCanvas: () => string | null;
}

// ─── Export canvas palette (premium Apple-style medical report) ────────────
const EX_BG      = "#0B1F33";
const EX_SURFACE = "#112240";
const EX_TEXT    = "#F1F5F9";
const EX_MUTED   = "#8892A4";
const EX_BORDER  = "rgba(255,255,255,0.08)";
const EX_NORMAL  = "#4ADE80";
const EX_ABNORM  = "#F87171";
const EX_ACCENT  = "#2563EB";
const EX_ORANGE  = "#FB923C";

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/** Simple landmark dots (no drag handles) for the export image sections. */
function drawExportLandmarkDots(
  ctx: CanvasRenderingContext2D,
  lm: Landmarks,
  s: number, ox: number, oy: number,
) {
  const toC = (p: Point): [number, number] => [p.x * s + ox, p.y * s + oy];
  const dot = (p: Point, color: string) => {
    const [cx, cy] = toC(p);
    // Shadow ring
    ctx.beginPath(); ctx.arc(cx, cy, 8, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(0,0,0,0.45)"; ctx.fill();
    // Colored fill
    ctx.beginPath(); ctx.arc(cx, cy, 6, 0, Math.PI * 2);
    ctx.fillStyle = color + "66"; ctx.fill();
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();
  };
  const jointLine = (a: Point, b: Point, color: string) => {
    const [x1, y1] = toC(a);
    const [x2, y2] = toC(b);
    // Shadow
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
    ctx.strokeStyle = "rgba(0,0,0,0.55)"; ctx.lineWidth = 7;
    ctx.setLineDash([]); ctx.stroke();
    // Color
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
    ctx.strokeStyle = color; ctx.lineWidth = 4; ctx.stroke();
  };
  if (lm.hip_center)   dot(lm.hip_center,   "#22c55e");
  if (lm.knee_center)  dot(lm.knee_center,  "#facc15");
  if (lm.ankle_center) dot(lm.ankle_center, "#f97316");
  if (lm.distal_femoral_line) {
    jointLine(lm.distal_femoral_line.medial, lm.distal_femoral_line.lateral, "#a78bfa");
    dot(lm.distal_femoral_line.medial,  "#a78bfa");
    dot(lm.distal_femoral_line.lateral, "#a78bfa");
  }
  if (lm.proximal_tibial_line) {
    jointLine(lm.proximal_tibial_line.medial, lm.proximal_tibial_line.lateral, "#38bdf8");
    dot(lm.proximal_tibial_line.medial,  "#38bdf8");
    dot(lm.proximal_tibial_line.lateral, "#38bdf8");
  }
}
// ──────────────────────────────────────────────────────────────────────────

const HANDLE_RADIUS = 10;
const JOINT_HANDLE_RADIUS = 7;

/**
 * Build draggable landmark handles.
 *
 * When an osteotomy plan is active with a non-zero correction the moving
 * fragment landmarks (ankle for HTO, knee+DFL for DFO) are displayed at
 * their POST-ROTATION positions so the dot stays anchored to the correct
 * anatomical point on the rotated bone image.  Those handles are marked
 * `draggable: false` to prevent accidental adjustment during simulation.
 */
function buildHandles(
  lm: Landmarks | null,
  showAnatomical = false,
  activePlan?: OsteotomyPlan | null,
): Handle[] {
  if (!lm) return [];

  const sim = activePlan && activePlan.correction_deg !== 0 && activePlan.hinge_point;
  const rot = (p: { x: number; y: number }) =>
    sim ? rotatePoint(p, activePlan!.hinge_point!, activePlan!.correction_deg) : p;

  const isHTO = sim && activePlan!.kind.startsWith("HTO");
  const isDFO = sim && activePlan!.kind.startsWith("DFO");

  const handles: Handle[] = [];

  if (lm.hip_center) {
    handles.push({ id: "hip", target: "hip_center", x: lm.hip_center.x, y: lm.hip_center.y, color: "#22c55e", radius: HANDLE_RADIUS, label: "Hip" });
  }
  if (lm.knee_center) {
    const pos = isDFO ? rot(lm.knee_center) : lm.knee_center;
    handles.push({ id: "knee", target: "knee_center", x: pos.x, y: pos.y, color: "#facc15", radius: HANDLE_RADIUS, label: "Knee", draggable: !isDFO });
  }
  if (lm.ankle_center) {
    const pos = (isHTO || isDFO) ? rot(lm.ankle_center) : lm.ankle_center;
    handles.push({ id: "ankle", target: "ankle_center", x: pos.x, y: pos.y, color: "#f97316", radius: HANDLE_RADIUS, label: "Ankle", draggable: !(isHTO || isDFO) });
  }
  if (lm.distal_femoral_line) {
    const med = isDFO ? rot(lm.distal_femoral_line.medial)  : lm.distal_femoral_line.medial;
    const lat = isDFO ? rot(lm.distal_femoral_line.lateral) : lm.distal_femoral_line.lateral;
    handles.push({ id: "dfl_m", target: "distal_femoral_line", side: "medial",  x: med.x, y: med.y, color: "#a78bfa", radius: JOINT_HANDLE_RADIUS, label: "DFL-M", draggable: !isDFO });
    handles.push({ id: "dfl_l", target: "distal_femoral_line", side: "lateral", x: lat.x, y: lat.y, color: "#a78bfa", radius: JOINT_HANDLE_RADIUS, label: "DFL-L", draggable: !isDFO });
  }
  if (lm.proximal_tibial_line) {
    const ptlMed = isDFO ? rot(lm.proximal_tibial_line.medial)  : lm.proximal_tibial_line.medial;
    const ptlLat = isDFO ? rot(lm.proximal_tibial_line.lateral) : lm.proximal_tibial_line.lateral;
    handles.push({ id: "ptl_m", target: "proximal_tibial_line", side: "medial",  x: ptlMed.x, y: ptlMed.y, color: "#38bdf8", radius: JOINT_HANDLE_RADIUS, label: "PTL-M", draggable: !isDFO });
    handles.push({ id: "ptl_l", target: "proximal_tibial_line", side: "lateral", x: ptlLat.x, y: ptlLat.y, color: "#38bdf8", radius: JOINT_HANDLE_RADIUS, label: "PTL-L", draggable: !isDFO });
  }
  if (showAnatomical) {
    (lm.femur_diaphysis_levels ?? []).forEach((lvl, i) => {
      // For DFO: only the levels BELOW the hinge belong to the moving fragment.
      // Proximal levels (above hinge) are part of the stationary fragment and
      // must NOT be rotated, otherwise they appear detached from the bone image.
      const hingeY = activePlan?.hinge_point?.y ?? -Infinity;
      const isMovingLevel = isDFO && lvl.medial.y > hingeY;
      const m = isMovingLevel ? rot(lvl.medial)  : lvl.medial;
      const l = isMovingLevel ? rot(lvl.lateral) : lvl.lateral;
      handles.push({ id: `fd_${i}_m`, target: `femur_diaphysis_${i}_medial`,  x: m.x, y: m.y, color: "#c8c800", radius: JOINT_HANDLE_RADIUS, label: `FM${i + 1}`, draggable: !isMovingLevel });
      handles.push({ id: `fd_${i}_l`, target: `femur_diaphysis_${i}_lateral`, x: l.x, y: l.y, color: "#c8c800", radius: JOINT_HANDLE_RADIUS, label: `FL${i + 1}`, draggable: !isMovingLevel });
    });
    (lm.tibia_diaphysis_levels ?? []).forEach((lvl, i) => {
      const m = (isHTO || isDFO) ? rot(lvl.medial)  : lvl.medial;
      const l = (isHTO || isDFO) ? rot(lvl.lateral) : lvl.lateral;
      handles.push({ id: `td_${i}_m`, target: `tibia_diaphysis_${i}_medial`,  x: m.x, y: m.y, color: "#00c8c8", radius: JOINT_HANDLE_RADIUS, label: `TM${i + 1}`, draggable: !(isHTO || isDFO) });
      handles.push({ id: `td_${i}_l`, target: `tibia_diaphysis_${i}_lateral`, x: l.x, y: l.y, color: "#00c8c8", radius: JOINT_HANDLE_RADIUS, label: `TL${i + 1}`, draggable: !(isHTO || isDFO) });
    });
  }
  return handles;
}

/** 2-D PCA: returns the principal-component unit vector of a point cloud. */
function pca2D(pts: { x: number; y: number }[]): [number, number] {
  const n = pts.length;
  const cx = pts.reduce((s, p) => s + p.x, 0) / n;
  const cy = pts.reduce((s, p) => s + p.y, 0) / n;
  let cxx = 0, cxy = 0, cyy = 0;
  for (const p of pts) {
    const dx = p.x - cx, dy = p.y - cy;
    cxx += dx * dx; cxy += dx * dy; cyy += dy * dy;
  }
  if (Math.abs(cxy) < 1e-9) return cxx >= cyy ? [1, 0] : [0, 1];
  const tr  = cxx + cyy;
  const disc = Math.max(0, tr * tr - 4 * (cxx * cyy - cxy * cxy));
  const lam  = (tr + Math.sqrt(disc)) / 2;
  const vx = cxy, vy = lam - cxx;
  const len = Math.hypot(vx, vy);
  return len > 1e-9 ? [vx / len, vy / len] : [1, 0];
}

function buildPlanHandles(p: OsteotomyPlan | null): Handle[] {
  if (!p) return [];
  const hs: Handle[] = [];
  if (p.osteotomy_line) {
    hs.push({ id: "plan_ost_p1", target: "osteotomy_line_p1", x: p.osteotomy_line.p1.x, y: p.osteotomy_line.p1.y, color: "#f97316", radius: 8, label: "O1" });
    hs.push({ id: "plan_ost_p2", target: "osteotomy_line_p2", x: p.osteotomy_line.p2.x, y: p.osteotomy_line.p2.y, color: "#f97316", radius: 8, label: "O2" });
  }
  if (p.hinge_point) {
    hs.push({ id: "plan_hinge", target: "hinge_point", x: p.hinge_point.x, y: p.hinge_point.y, color: "#ef4444", radius: 9, label: "H" });
  }
  if (p.target_point) {
    hs.push({ id: "plan_target", target: "target_point", x: p.target_point.x, y: p.target_point.y, color: "#a78bfa", radius: 8, label: "T" });
  }
  return hs;
}

const DicomViewer = forwardRef<DicomViewerHandle, Props>(function DicomViewer({
  imageB64,
  rawImageB64 = "",
  sessionKey = "",
  landmarks,
  onLandmarkMove,
  loading,
  showAnatomical = false,
  onCanvasClick,
  calibMode = "none" as CalibMode,
  calibType = "line" as CalibType,
  calibPoints = {} as { p1?: Point; p2?: Point; p3?: Point },
  plan = null,
  planningStep = "idle",
  pendingOstP1 = null,
  confirmedOsteotomies = [] as ConfirmedOsteotomy[],
  onPlanPointMove,
  baseAnnotatedImageB64 = "",
  measureStep = "idle" as MeasureStep,
  hipMeasPts = [] as Point[],
  femurMeasPts = [] as Point[],
  tibiaMeasPts = [] as Point[],
  ankleMeasPts = [] as Point[],
  annotations = [] as Annotation[],
  activeTool = "none" as AnnotationTool,
  pendingAnnotPts = [] as Point[],
  pixelSpacingMm = null,
  angles = null,
  baseAngles = null,
  baseLandmarks = null,
  slopeStep = "idle" as SlopeStep,
  slopePts = { plateauP1: null, plateauP2: null, cortex1Ant: null, cortex1Post: null, cortex2Ant: null, cortex2Post: null } as SlopePoints,
  slopeValue = null,
  sagittalStep = "idle" as SagittalStep,
  sagittalOst = { hingePoint: null, cutP1: null, cutP2: null, correctionDeg: 0 } as SagittalOsteotomy,
  sagittalResult = null,
  confirmedSagittalOsts = [] as ConfirmedSagittalOst[],
  imageType = "long_leg_ap" as ImageType,
  lang = "de" as Lang,
}: Props, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { t } = useTranslation();
  const langRef = useRef<Lang>("de");
  langRef.current = lang;

  useImperativeHandle(ref, () => ({
    captureCanvas: () => canvasRef.current?.toDataURL("image/png") ?? null,

    captureExportCanvas: (): string | null => {
      const img = imgRef.current;
      if (!img) return null;

      const _lang = langRef.current;
      const tExport = (key: string): string => {
        const dict = translations[_lang] as Record<string, string>;
        const fallback = translations.en as Record<string, string>;
        return dict[key] ?? fallback[key] ?? key;
      };
      const nExport = (val: number, digits = 1) => formatNumber(val, _lang, digits);

      // ── Lateral (tibial slope) export ──────────────────────────────────────
      if (imageTypeRef.current === "knee_lateral") {
        const rawOrImg    = rawImgRef.current ?? img;
        const slopePts    = slopePtsRef.current;
        const slopeVal    = slopeValueRef.current;
        const confSagOsts = confirmedSagOstsRef.current;
        const hasOst      = confSagOsts.length > 0;
        const lastOst     = hasOst ? confSagOsts[confSagOsts.length - 1] : null;

        const HDR_H   = 72;
        const LABEL_H = 22;
        const PAD     = 20;
        const BOT     = 24;
        const PANEL_W = 292;
        const TOTAL_H = 920;
        const imgY    = HDR_H + PAD + LABEL_H;
        const IMG_H   = TOTAL_H - imgY - BOT;
        const IMG_W   = Math.round(rawOrImg.naturalWidth * IMG_H / rawOrImg.naturalHeight);
        const numImgs = hasOst ? 2 : 1;
        const totalW  = PAD + numImgs * IMG_W + (numImgs - 1) * PAD + PAD + PANEL_W + PAD;

        const latCanvas = document.createElement("canvas");
        latCanvas.width  = totalW;
        latCanvas.height = TOTAL_H;
        const lctx = latCanvas.getContext("2d")!;

        // Background
        lctx.fillStyle = EX_BG;
        lctx.fillRect(0, 0, totalW, TOTAL_H);

        // Header
        lctx.fillStyle = EX_SURFACE;
        lctx.fillRect(0, 0, totalW, HDR_H);
        lctx.fillStyle = EX_ACCENT;
        lctx.fillRect(0, 0, 4, HDR_H);
        lctx.fillStyle = EX_TEXT;
        lctx.font = "bold 24px sans-serif";
        lctx.textAlign = "left";
        lctx.fillText("CADtomie", 22, 34);
        lctx.fillStyle = EX_ACCENT;
        lctx.font = "bold 9px sans-serif";
        lctx.fillText("ORTHOPÄDISCHE DEFORMITÄTSANALYSE", 22, 52);
        const latDateStr = new Date().toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
        lctx.fillStyle = EX_TEXT;
        lctx.font = "12px sans-serif";
        lctx.textAlign = "right";
        lctx.fillText(latDateStr, totalW - PAD, 36);
        lctx.textAlign = "left";
        lctx.strokeStyle = EX_BORDER;
        lctx.lineWidth = 1;
        lctx.beginPath();
        lctx.moveTo(0, HDR_H);
        lctx.lineTo(totalW, HDR_H);
        lctx.stroke();

        // Compose one image panel (pre-op or post-op)
        const renderLateralSection = (withSim: boolean): HTMLCanvasElement => {
          const c = document.createElement("canvas");
          c.width = IMG_W; c.height = IMG_H;
          const cx = c.getContext("2d")!;

          const s  = Math.min(IMG_W / rawOrImg.naturalWidth, IMG_H / rawOrImg.naturalHeight) * 0.95;
          const iw = rawOrImg.naturalWidth  * s;
          const ih = rawOrImg.naturalHeight * s;
          const ox = (IMG_W - iw) / 2;
          const oy = (IMG_H - ih) / 2;

          if (withSim && confSagOsts.length > 0) {
            let drawBase: (c: CanvasRenderingContext2D) => void =
              (c) => c.drawImage(rawOrImg, ox, oy, iw, ih);
            for (const co of confSagOsts) {
              if (!co.ost.cutP1 || !co.ost.cutP2 || !co.ost.hingePoint || co.ost.correctionDeg === 0) continue;
              const prev = drawBase;
              const off = document.createElement("canvas");
              off.width = IMG_W; off.height = IMG_H;
              const offCtx = off.getContext("2d")!;
              drawSagittalSimulation(offCtx, prev, co.ost, slopePts, s, ox, oy);
              const cap = off;
              drawBase = (c) => c.drawImage(cap, 0, 0);
            }
            drawBase(cx);
          } else {
            cx.drawImage(rawOrImg, ox, oy, iw, ih);
          }

          // Slope overlay: skip plateau tangent in post-op (it moved with the pixel sim)
          const skipPlateau = withSim && confSagOsts.length > 0;
          drawSlopeOverlay(cx, "done", slopePts, slopeVal, s, ox, oy, skipPlateau);

          if (withSim) {
            drawConfirmedSagittalOsts(cx, confSagOsts, s, ox, oy);
          }

          return c;
        };

        // Image columns
        const drawLatImgCol = (colX: number, label: string, section: HTMLCanvasElement) => {
          lctx.fillStyle = EX_MUTED;
          lctx.font = "bold 9px sans-serif";
          lctx.textAlign = "center";
          lctx.fillText(label, colX + IMG_W / 2, imgY - 7);
          lctx.strokeStyle = EX_BORDER;
          lctx.lineWidth = 1;
          lctx.strokeRect(colX, imgY, IMG_W, IMG_H);
          lctx.drawImage(section, colX, imgY);
          lctx.textAlign = "left";
        };

        if (hasOst) {
          drawLatImgCol(PAD,               tExport("export_baseline"),  renderLateralSection(false));
          drawLatImgCol(PAD + IMG_W + PAD, tExport("export_post_op"), renderLateralSection(true));
        } else {
          drawLatImgCol(PAD, tExport("export_findings"), renderLateralSection(false));
        }

        // Right panel
        const latPanelX = PAD + numImgs * IMG_W + (numImgs > 1 ? PAD : 0) + PAD;
        let lpy = HDR_H + PAD;

        const latSectionHeader = (title: string, color = EX_ACCENT) => {
          lctx.fillStyle = color;
          lctx.font = "bold 9px sans-serif";
          lctx.textAlign = "left";
          lctx.fillText(title, latPanelX, lpy + 11);
          lctx.strokeStyle = color + "50";
          lctx.lineWidth = 1;
          lctx.beginPath();
          lctx.moveTo(latPanelX, lpy + 17);
          lctx.lineTo(latPanelX + PANEL_W, lpy + 17);
          lctx.stroke();
          lpy += 28;
        };

        const showSlopeComparison = hasOst && lastOst != null;

        const slopeOk = (v: number) => v >= 5 && v <= 10;

        const slopeCard = (
          lbl: string, range: string,
          pre: number | null, post: number | null | undefined,
        ) => {
          const CARD_H = 64;
          lctx.fillStyle = "rgba(255,255,255,0.035)";
          roundRect(lctx, latPanelX, lpy, PANEL_W, CARD_H, 6);
          lctx.fill();
          lctx.fillStyle = EX_TEXT;
          lctx.font = "bold 14px sans-serif";
          lctx.textAlign = "left";
          lctx.fillText(lbl, latPanelX + 12, lpy + 20);
          lctx.fillStyle = "rgba(255,255,255,0.06)";
          lctx.font = "8px sans-serif";
          const rw = lctx.measureText(range).width + 12;
          roundRect(lctx, latPanelX + 12, lpy + 27, rw, 14, 3);
          lctx.fill();
          lctx.fillStyle = EX_MUTED;
          lctx.fillText(range, latPanelX + 18, lpy + 37);

          if (showSlopeComparison && post != null) {
            const preStr    = pre  != null ? `${pre.toFixed(1)}°`  : "—";
            const postStr   = `${post.toFixed(1)}°`;
            const preColor  = pre  != null ? (slopeOk(pre)  ? EX_NORMAL : EX_ABNORM) : EX_MUTED;
            const postColor = slopeOk(post) ? EX_NORMAL : EX_ABNORM;
            const midX = latPanelX + PANEL_W * 0.55;
            lctx.font = "bold 14px sans-serif";
            lctx.fillStyle = preColor;
            lctx.textAlign = "right";
            lctx.fillText(preStr, midX - 10, lpy + 50);
            lctx.fillStyle = EX_MUTED;
            lctx.font = "11px sans-serif";
            lctx.textAlign = "center";
            lctx.fillText("→", midX, lpy + 50);
            lctx.fillStyle = postColor;
            lctx.font = "bold 14px sans-serif";
            lctx.textAlign = "left";
            lctx.fillText(postStr, midX + 10, lpy + 50);
            if (pre != null) {
              const delta = post - pre;
              const dStr  = (delta >= 0 ? "+" : "") + delta.toFixed(1) + "°";
              lctx.fillStyle = "rgba(148,163,184,0.55)";
              lctx.font = "9px sans-serif";
              lctx.textAlign = "right";
              lctx.fillText(dStr, latPanelX + PANEL_W - 8, lpy + 50);
            }
          } else {
            const val    = pre;
            const valStr = val != null ? `${val.toFixed(1)}°` : "—";
            const color  = val != null ? (slopeOk(val) ? EX_NORMAL : EX_ABNORM) : EX_MUTED;
            lctx.fillStyle = color;
            lctx.font = "bold 20px sans-serif";
            lctx.textAlign = "right";
            lctx.fillText(valStr, latPanelX + PANEL_W - 12, lpy + 52);
          }
          lctx.textAlign = "left";
          lpy += CARD_H + 6;
        };

        latSectionHeader(tExport("export_slope_measurement"));
        slopeCard("Tibial Slope", "5–10°", slopeVal, lastOst?.slopeAfter);

        if (hasOst) {
          lpy += 10;
          latSectionHeader(tExport("export_correction_ost"), EX_ORANGE);

          for (let i = 0; i < confSagOsts.length; i++) {
            const co    = confSagOsts[i];
            const deg   = co.ost.correctionDeg;
            const delta = co.slopeAfter - co.slopeBefore;
            const details: [string, string][] = [
              [tExport("export_corr_angle"), `${deg >= 0 ? "+" : ""}${nExport(deg)}°`],
              [tExport("export_slope_before"), `${co.slopeBefore >= 0 ? "+" : ""}${nExport(co.slopeBefore)}°`],
              [tExport("export_slope_after"),  `${co.slopeAfter  >= 0 ? "+" : ""}${nExport(co.slopeAfter)}°`],
              ["Δ Slope",           `${delta >= 0 ? "+" : ""}${nExport(delta)}°`],
            ];
            const ostH = 28 + details.length * 17 + 10;

            lctx.fillStyle = "rgba(251,146,60,0.05)";
            roundRect(lctx, latPanelX, lpy, PANEL_W, ostH, 6);
            lctx.fill();

            lctx.beginPath();
            lctx.arc(latPanelX + 14, lpy + 14, 8, 0, Math.PI * 2);
            lctx.fillStyle = EX_ORANGE; lctx.fill();
            lctx.fillStyle = EX_BG;
            lctx.font = "bold 9px sans-serif";
            lctx.textAlign = "center";
            lctx.fillText(`${i + 1}`, latPanelX + 14, lpy + 17);

            lctx.fillStyle = EX_TEXT;
            lctx.font = "bold 11px sans-serif";
            lctx.textAlign = "left";
            lctx.fillText(tExport("export_anterior_slope"), latPanelX + 28, lpy + 18);

            let dy = lpy + 33;
            for (const [lbl, val] of details) {
              lctx.fillStyle = EX_MUTED; lctx.font = "10px sans-serif"; lctx.textAlign = "left";
              lctx.fillText(lbl, latPanelX + 12, dy);
              lctx.fillStyle = EX_TEXT; lctx.textAlign = "right";
              lctx.fillText(val, latPanelX + PANEL_W - 8, dy);
              dy += 17;
            }
            lpy += ostH + 8;
          }
        }

        lctx.textAlign = "left";
        return latCanvas.toDataURL("image/png");
      }

      // ── Long-leg AP export ─────────────────────────────────────────────────
      const rawImg  = rawImgRef.current;
      const lm      = landmarksRef.current;
      const ang     = anglesRef.current;
      const baseAng = baseAnglesRef.current;
      const confirmed = confirmedOstsRef.current;
      const hasOst  = confirmed.length > 0;
      const showComparison = hasOst && baseAng != null;

      // ── Layout constants ───────────────────────────────────────────────
      const HDR_H   = 72;    // premium header height
      const LABEL_H = 22;    // column label row above images
      const PAD     = 20;    // gap between columns and outer margins
      const BOT     = 24;    // bottom padding
      const PANEL_W = 292;   // right-side measurement + osteotomy panel
      const TOTAL_H = 920;
      const imgY    = HDR_H + PAD + LABEL_H;
      const IMG_H   = TOTAL_H - imgY - BOT;
      const IMG_W   = Math.round(img.naturalWidth * IMG_H / img.naturalHeight);
      const numImgs = hasOst ? 2 : 1;
      const totalW  = PAD + numImgs * IMG_W + (numImgs - 1) * PAD + PAD + PANEL_W + PAD;

      const canvas = document.createElement("canvas");
      canvas.width  = totalW;
      canvas.height = TOTAL_H;
      const ctx = canvas.getContext("2d")!;

      // ── Background ────────────────────────────────────────────────────
      ctx.fillStyle = EX_BG;
      ctx.fillRect(0, 0, totalW, TOTAL_H);

      // ── Header ────────────────────────────────────────────────────────
      ctx.fillStyle = EX_SURFACE;
      ctx.fillRect(0, 0, totalW, HDR_H);

      // Left accent bar
      ctx.fillStyle = EX_ACCENT;
      ctx.fillRect(0, 0, 4, HDR_H);

      // App name
      ctx.fillStyle = EX_TEXT;
      ctx.font = "bold 24px sans-serif";
      ctx.textAlign = "left";
      ctx.fillText("CADtomie", 22, 34);

      // Subtitle
      ctx.fillStyle = EX_ACCENT;
      ctx.font = "bold 9px sans-serif";
      ctx.fillText("ORTHOPÄDISCHE DEFORMITÄTSANALYSE", 22, 52);

      // Date (right)
      const dateStr = new Date().toLocaleDateString("de-DE", {
        day: "2-digit", month: "2-digit", year: "numeric",
      });
      ctx.fillStyle = EX_TEXT;
      ctx.font = "12px sans-serif";
      ctx.textAlign = "right";
      ctx.fillText(dateStr, totalW - PAD, 36);
      ctx.textAlign = "left";

      // Header divider
      ctx.strokeStyle = EX_BORDER;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, HDR_H);
      ctx.lineTo(totalW, HDR_H);
      ctx.stroke();

      // ── renderImgSection helper ───────────────────────────────────────
      // lmOverride / angOverride let the pre-op column use baseLandmarks/baseAngles
      // while the post-op column uses the current (transformed) values.
      const renderImgSection = (
        sectionImg: HTMLImageElement,
        withSim: boolean,
        lmOverride?: Landmarks | null,
        angOverride?: Angles | null,
      ): HTMLCanvasElement => {
        const c = document.createElement("canvas");
        c.width = IMG_W; c.height = IMG_H;
        const cx = c.getContext("2d")!;

        const s  = Math.min(IMG_W / sectionImg.naturalWidth, IMG_H / sectionImg.naturalHeight) * 0.95;
        const iw = sectionImg.naturalWidth  * s;
        const ih = sectionImg.naturalHeight * s;
        const ox = (IMG_W - iw) / 2;
        const oy = (IMG_H - ih) / 2;

        if (withSim && confirmed.length > 0) {
          let drawBase: (c: CanvasRenderingContext2D) => void =
            (c) => c.drawImage(sectionImg, ox, oy, iw, ih);
          for (const co of confirmed) {
            if (!co.plan.osteotomy_line || !co.plan.hinge_point || co.plan.correction_deg === 0) continue;
            const prev = drawBase;
            const off = document.createElement("canvas");
            off.width = IMG_W; off.height = IMG_H;
            const offCtx = off.getContext("2d")!;
            drawOsteotomySimulation(offCtx, prev, co.plan, co.landmarksAtConfirm, s, ox, oy);
            const cap = off;
            drawBase = (c) => c.drawImage(cap, 0, 0);
          }
          drawBase(cx);
        } else {
          cx.drawImage(sectionImg, ox, oy, iw, ih);
        }

        const effectiveLm  = lmOverride  ?? lm;
        const effectiveAng = angOverride ?? ang;
        if (effectiveLm) drawMeasurementLines(cx, effectiveLm, s, ox, oy);
        if (withSim && confirmed.length > 0) drawConfirmedOsteotomies(cx, confirmed, s, ox, oy);
        if (effectiveLm) drawExportLandmarkDots(cx, effectiveLm, s, ox, oy);
        if (effectiveAng && effectiveLm) drawAngleLabels(cx, effectiveLm, effectiveAng, s, ox, oy);

        return c;
      };

      // ── Image columns ─────────────────────────────────────────────────
      const drawImgCol = (colX: number, label: string, section: HTMLCanvasElement) => {
        // Column label
        ctx.fillStyle = EX_MUTED;
        ctx.font = "bold 9px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(label, colX + IMG_W / 2, imgY - 7);
        // Subtle frame
        ctx.strokeStyle = EX_BORDER;
        ctx.lineWidth = 1;
        ctx.strokeRect(colX, imgY, IMG_W, IMG_H);
        ctx.drawImage(section, colX, imgY);
        ctx.textAlign = "left";
      };

      const baseImg = rawImg ?? img;
      if (hasOst) {
        const baseLm  = baseLandmarksRef.current;
        const baseAng = baseAnglesRef.current;
        drawImgCol(PAD,               tExport("export_baseline"), renderImgSection(baseImg, false, baseLm, baseAng));
        drawImgCol(PAD + IMG_W + PAD, tExport("export_post_op"),  renderImgSection(baseImg, true));
      } else {
        drawImgCol(PAD, tExport("export_findings"), renderImgSection(baseImg, false));
      }

      // ── Right panel ───────────────────────────────────────────────────
      const panelX = PAD + numImgs * IMG_W + (numImgs > 1 ? PAD : 0) + PAD;
      let py = HDR_H + PAD;

      // Section header with accent underline
      const sectionHeader = (title: string, color = EX_ACCENT) => {
        ctx.fillStyle = color;
        ctx.font = "bold 9px sans-serif";
        ctx.textAlign = "left";
        ctx.fillText(title, panelX, py + 11);
        ctx.strokeStyle = color + "50";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(panelX, py + 17);
        ctx.lineTo(panelX + PANEL_W, py + 17);
        ctx.stroke();
        py += 28;
      };

      // Measurement card (pre → post or single)
      const angleCard = (
        lbl: string, range: string,
        pre: number | null | undefined,
        post: number | null | undefined,
        unit: string,
        ok: (v: number) => boolean,
      ) => {
        const CARD_H = 64;

        // Card background
        ctx.fillStyle = "rgba(255,255,255,0.035)";
        roundRect(ctx, panelX, py, PANEL_W, CARD_H, 6);
        ctx.fill();

        // Label
        ctx.fillStyle = EX_TEXT;
        ctx.font = "bold 14px sans-serif";
        ctx.textAlign = "left";
        ctx.fillText(lbl, panelX + 12, py + 20);

        // Normal range badge
        ctx.fillStyle = "rgba(255,255,255,0.06)";
        ctx.font = "8px sans-serif";
        const rangeW = ctx.measureText(range).width + 12;
        roundRect(ctx, panelX + 12, py + 27, rangeW, 14, 3);
        ctx.fill();
        ctx.fillStyle = EX_MUTED;
        ctx.fillText(range, panelX + 18, py + 37);

        if (showComparison && post != null) {
          // pre → post comparison
          const preStr   = pre != null ? `${pre.toFixed(1)}${unit}` : "—";
          const postStr  = `${post.toFixed(1)}${unit}`;
          const preColor = pre != null ? (ok(pre) ? EX_NORMAL : EX_ABNORM) : EX_MUTED;
          const postColor = ok(post) ? EX_NORMAL : EX_ABNORM;
          const midX = panelX + PANEL_W * 0.55;

          ctx.font = "bold 14px sans-serif";
          ctx.fillStyle = preColor;
          ctx.textAlign = "right";
          ctx.fillText(preStr, midX - 10, py + 50);

          ctx.fillStyle = EX_MUTED;
          ctx.font = "11px sans-serif";
          ctx.textAlign = "center";
          ctx.fillText("→", midX, py + 50);

          ctx.fillStyle = postColor;
          ctx.font = "bold 14px sans-serif";
          ctx.textAlign = "left";
          ctx.fillText(postStr, midX + 10, py + 50);

          // Delta (small, top-right corner)
          if (pre != null) {
            const delta = post - pre;
            const dStr = (delta >= 0 ? "+" : "") + delta.toFixed(1) + unit;
            ctx.fillStyle = "rgba(148,163,184,0.55)";
            ctx.font = "9px sans-serif";
            ctx.textAlign = "right";
            ctx.fillText(dStr, panelX + PANEL_W - 8, py + 50);
          }
        } else {
          // Single value, large and right-aligned
          const val    = pre;
          const valStr = val != null ? `${val.toFixed(1)}${unit}` : "—";
          const color  = val != null ? (ok(val) ? EX_NORMAL : EX_ABNORM) : EX_MUTED;
          ctx.fillStyle = color;
          ctx.font = "bold 20px sans-serif";
          ctx.textAlign = "right";
          ctx.fillText(valStr, panelX + PANEL_W - 12, py + 52);
        }

        ctx.textAlign = "left";
        py += CARD_H + 6;
      };

      // ── Measurements section ──────────────────────────────────────────
      sectionHeader(tExport("export_measurements"));

      const measRows: Array<{
        lbl: string; range: string; unit: string;
        pre: number | null | undefined;
        post: number | null | undefined;
        ok: (v: number) => boolean;
      }> = [
        { lbl: "HKA",   range: "0 ± 3°", unit: "°", pre: baseAng?.HKA_deg   ?? ang?.HKA_deg,   post: showComparison ? ang?.HKA_deg   : undefined, ok: v => Math.abs(v) <= 3   },
        { lbl: "mLDFA", range: "85–90°", unit: "°", pre: baseAng?.mLDFA_deg ?? ang?.mLDFA_deg, post: showComparison ? ang?.mLDFA_deg : undefined, ok: v => v >= 85 && v <= 90 },
        { lbl: "mMPTA", range: "85–90°", unit: "°", pre: baseAng?.mMPTA_deg ?? ang?.mMPTA_deg, post: showComparison ? ang?.mMPTA_deg : undefined, ok: v => v >= 85 && v <= 90 },
        { lbl: "JLCA",  range: "< 2°",   unit: "°", pre: baseAng?.JLCA_deg  ?? ang?.JLCA_deg,  post: showComparison ? ang?.JLCA_deg  : undefined, ok: v => Math.abs(v) <= 2   },
      ];
      for (const r of measRows) angleCard(r.lbl, r.range, r.pre, r.post, r.unit, r.ok);

      // ── Osteotomy plan section ────────────────────────────────────────
      if (hasOst) {
        py += 10;
        sectionHeader(tExport("export_osteotomy_plan"), EX_ORANGE);

        for (let i = 0; i < confirmed.length; i++) {
          const co   = confirmed[i];
          const plan = co.plan;
          const details: [string, string][] = [
            [tExport("export_wedge"),  plan.wedge_mm      != null ? `${nExport(plan.wedge_mm)} mm`            : "—"],
            [tExport("export_miniaci"),    plan.miniaci_deg   != null ? `${nExport(Math.abs(plan.miniaci_deg))}°` : "—"],
            [tExport("export_hka_corr"), plan.corrected_hka != null ? `${nExport(plan.corrected_hka)}°`         : "—"],
          ];
          const ostH = 28 + details.length * 17 + 10;

          ctx.fillStyle = "rgba(251,146,60,0.05)";
          roundRect(ctx, panelX, py, PANEL_W, ostH, 6);
          ctx.fill();

          // Index badge
          ctx.beginPath();
          ctx.arc(panelX + 14, py + 14, 8, 0, Math.PI * 2);
          ctx.fillStyle = EX_ORANGE; ctx.fill();
          ctx.fillStyle = EX_BG; ctx.font = "bold 9px sans-serif";
          ctx.textAlign = "center"; ctx.fillText(`${i + 1}`, panelX + 14, py + 17);

          ctx.fillStyle = EX_TEXT; ctx.font = "bold 11px sans-serif";
          ctx.textAlign = "left"; ctx.fillText(tExport(`kind_${plan.kind}`), panelX + 28, py + 18);

          let dy = py + 33;
          for (const [lbl, val] of details) {
            ctx.fillStyle = EX_MUTED; ctx.font = "10px sans-serif"; ctx.textAlign = "left";
            ctx.fillText(lbl, panelX + 12, dy);
            ctx.fillStyle = EX_TEXT; ctx.textAlign = "right";
            ctx.fillText(val, panelX + PANEL_W - 8, dy);
            dy += 17;
          }
          py += ostH + 8;
        }
      }

      ctx.textAlign = "left";
      return canvas.toDataURL("image/png");
    },
  }));
  const imgRef    = useRef<HTMLImageElement | null>(null);
  // Raw (unannotated) DICOM image — used as the simulation base so that
  // bone-fragment rotation never includes any backend-drawn axis lines.
  const rawImgRef = useRef<HTMLImageElement | null>(null);
  // Backend-annotated image frozen before the first osteotomy was confirmed.
  // Used as the "Ausgangsbefund" center column in the structured export.
  const baseAnnotatedImgRef = useRef<HTMLImageElement | null>(null);

  // Pan/zoom state
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const scaleRef = useRef(1);
  const offsetRef = useRef({ x: 0, y: 0 });

  // Dragging state
  const draggingHandle = useRef<Handle | null>(null);
  const handles = useRef<Handle[]>([]);
  const isPanning = useRef(false);
  const panStart = useRef({ mx: 0, my: 0, ox: 0, oy: 0 });

  const lastSessionKeyRef = useRef<string>("");

  const landmarksRef = useRef<Landmarks | null>(null);
  landmarksRef.current = landmarks;

  const planRef = useRef<OsteotomyPlan | null>(null);
  planRef.current = plan;

  const confirmedOstsRef = useRef<ConfirmedOsteotomy[]>([]);
  confirmedOstsRef.current = confirmedOsteotomies;

  const planHandles = useRef<Handle[]>([]);

  const showAnatomicalRef = useRef(false);
  showAnatomicalRef.current = showAnatomical;

  const anglesRef = useRef<Angles | null>(null);
  anglesRef.current = angles ?? null;

  const baseAnglesRef = useRef<Angles | null>(null);
  baseAnglesRef.current = baseAngles ?? null;

  const baseLandmarksRef = useRef<Landmarks | null>(null);
  baseLandmarksRef.current = baseLandmarks ?? null;

  const slopeStepRef = useRef<SlopeStep>("idle");
  slopeStepRef.current = slopeStep;
  const slopePtsRef = useRef<SlopePoints>(slopePts);
  slopePtsRef.current = slopePts;
  const slopeValueRef = useRef<number | null>(null);
  slopeValueRef.current = slopeValue ?? null;

  const imageTypeRef = useRef<ImageType>("long_leg_ap");
  imageTypeRef.current = imageType;

  const sagittalStepRef = useRef<SagittalStep>("idle");
  sagittalStepRef.current = sagittalStep;
  const sagittalOstRef = useRef<SagittalOsteotomy>(sagittalOst);
  sagittalOstRef.current = sagittalOst;
  const sagittalResultRef = useRef<SagittalResult | null>(null);
  sagittalResultRef.current = sagittalResult ?? null;
  const confirmedSagOstsRef = useRef<ConfirmedSagittalOst[]>([]);
  confirmedSagOstsRef.current = confirmedSagittalOsts;

  const calibModeRef = useRef<CalibMode>("none");
  const calibTypeRef = useRef<CalibType>("line");
  const calibPointsRef = useRef<{ p1?: Point; p2?: Point; p3?: Point }>({});
  calibModeRef.current = calibMode;
  calibTypeRef.current = calibType;
  calibPointsRef.current = calibPoints;

  const planningStepRef = useRef<PlanningStep>("idle");
  planningStepRef.current = planningStep;
  const pendingOstP1Ref = useRef<Point | null>(null);
  pendingOstP1Ref.current = pendingOstP1 ?? null;
  /** Tracks last known cursor image-coords for rubber-band preview */
  const cursorRef = useRef<Point | null>(null);

  const measureStepRef = useRef<MeasureStep>("idle");
  measureStepRef.current = measureStep;
  const activeToolRef = useRef<AnnotationTool>("none");
  activeToolRef.current = activeTool;
  const pixelSpacingRef = useRef<number | null>(null);
  pixelSpacingRef.current = pixelSpacingMm;
  const annotationsRef = useRef<Annotation[]>([]);
  annotationsRef.current = annotations;
  const pendingAnnotRef = useRef<Point[]>([]);
  pendingAnnotRef.current = pendingAnnotPts;
  const hipMeasRef = useRef<Point[]>([]);
  hipMeasRef.current = hipMeasPts;
  const femurMeasRef = useRef<Point[]>([]);
  femurMeasRef.current = femurMeasPts;
  const tibiaMeasRef = useRef<Point[]>([]);
  tibiaMeasRef.current = tibiaMeasPts;
  const ankleMeasRef = useRef<Point[]>([]);
  ankleMeasRef.current = ankleMeasPts;

  // Keep refs in sync
  scaleRef.current = scale;
  offsetRef.current = offset;

  // Load image — only reset zoom when a new session starts, not on every overlay update
  useEffect(() => {
    const isNewSession = sessionKey !== lastSessionKeyRef.current;
    if (isNewSession) lastSessionKeyRef.current = sessionKey;
    const img = new Image();
    img.src = `data:image/png;base64,${imageB64}`;
    img.onload = () => {
      imgRef.current = img;
      if (isNewSession) fitToContainer();
      else draw();
    };
  }, [imageB64]);

  // Load raw (unannotated) image — only fires when a new upload provides one
  useEffect(() => {
    if (!rawImageB64) return;
    const img = new Image();
    img.src = `data:image/png;base64,${rawImageB64}`;
    img.onload = () => { rawImgRef.current = img; };
  }, [rawImageB64]);

  // Load base annotated image (frozen before first osteotomy confirmation)
  useEffect(() => {
    if (!baseAnnotatedImageB64) { baseAnnotatedImgRef.current = null; return; }
    const img = new Image();
    img.src = `data:image/png;base64,${baseAnnotatedImageB64}`;
    img.onload = () => { baseAnnotatedImgRef.current = img; };
  }, [baseAnnotatedImageB64]);

  // Rebuild handles when landmarks/plan change
  useEffect(() => {
    handles.current = buildHandles(landmarks, showAnatomical, plan);
    planHandles.current = buildPlanHandles(plan);
    draw();
  }, [landmarks, scale, offset, showAnatomical, calibMode, calibPoints, plan, planningStep, pendingOstP1, confirmedOsteotomies, measureStep, hipMeasPts, femurMeasPts, tibiaMeasPts, ankleMeasPts, annotations, pendingAnnotPts, slopeStep, slopePts, slopeValue, sagittalStep, sagittalOst, sagittalResult, confirmedSagittalOsts]);

  const fitToContainer = useCallback(() => {
    const container = containerRef.current;
    const img = imgRef.current;
    if (!container || !img) return;
    const { width: cw, height: ch } = container.getBoundingClientRect();
    const s = Math.min(cw / img.naturalWidth, ch / img.naturalHeight) * 0.95;
    const ox = (cw - img.naturalWidth * s) / 2;
    const oy = (ch - img.naturalHeight * s) / 2;
    setScale(s);
    setOffset({ x: ox, y: oy });
  }, []);

  function drawCalibrationOverlay(
    ctx: CanvasRenderingContext2D,
    cp: { p1?: Point; p2?: Point; p3?: Point },
    ctype: CalibType,
    s: number, ox: number, oy: number,
  ) {
    const toC = (p: Point): [number, number] => [p.x * s + ox, p.y * s + oy];

    const drawCross = (x: number, y: number, label: string) => {
      const r = 8;
      ctx.strokeStyle = "#4ade80";
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x - r, y); ctx.lineTo(x + r, y); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x, y - r); ctx.lineTo(x, y + r); ctx.stroke();
      ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fillStyle = "#4ade80"; ctx.fill();
      ctx.fillStyle = "#4ade80";
      ctx.font = "11px Inter, sans-serif";
      ctx.fillText(label, x + 10, y - 6);
    };

    if (ctype === "line") {
      if (cp.p1) { const [x, y] = toC(cp.p1); drawCross(x, y, "P1"); }
      if (cp.p2) { const [x, y] = toC(cp.p2); drawCross(x, y, "P2"); }
      if (cp.p1 && cp.p2) {
        const [x1, y1] = toC(cp.p1);
        const [x2, y2] = toC(cp.p2);
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
        ctx.strokeStyle = "#4ade80"; ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 3]); ctx.stroke(); ctx.setLineDash([]);
        const px = Math.hypot(cp.p2.x - cp.p1.x, cp.p2.y - cp.p1.y);
        const mx = (x1 + x2) / 2; const my = (y1 + y2) / 2;
        const label = `${px.toFixed(1)} px`;
        ctx.fillStyle = "rgba(15,23,42,0.8)"; ctx.fillRect(mx - 28, my - 12, 56, 16);
        ctx.fillStyle = "#4ade80"; ctx.font = "bold 11px Inter, sans-serif";
        ctx.textAlign = "center"; ctx.fillText(label, mx, my); ctx.textAlign = "left";
      }
    } else {
      // Sphere mode — 3 points on circumference
      if (cp.p1) { const [x, y] = toC(cp.p1); drawCross(x, y, "P1"); }
      if (cp.p2) { const [x, y] = toC(cp.p2); drawCross(x, y, "P2"); }
      if (cp.p3) { const [x, y] = toC(cp.p3); drawCross(x, y, "P3"); }

      // Draw circumscribed circle when all 3 points are available
      if (cp.p1 && cp.p2 && cp.p3) {
        const circ = circumscribedCircle(cp.p1, cp.p2, cp.p3);
        if (circ) {
          const [cx, cy] = toC({ x: circ.cx, y: circ.cy });
          const r = circ.r * s;
          ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
          ctx.strokeStyle = "#4ade80"; ctx.lineWidth = 1.5;
          ctx.setLineDash([5, 3]); ctx.stroke(); ctx.setLineDash([]);
          // Diameter label at top of circle
          const label = `⌀ ${(2 * circ.r).toFixed(1)} px`;
          ctx.fillStyle = "rgba(15,23,42,0.8)"; ctx.fillRect(cx - 36, cy - r - 16, 72, 16);
          ctx.fillStyle = "#4ade80"; ctx.font = "bold 11px Inter, sans-serif";
          ctx.textAlign = "center"; ctx.fillText(label, cx, cy - r - 4); ctx.textAlign = "left";
        }
      }
    }
  }

  function drawConfirmedOsteotomies(
    ctx: CanvasRenderingContext2D,
    confirmed: ConfirmedOsteotomy[],
    s: number, ox: number, oy: number,
  ) {
    if (confirmed.length === 0) return;
    const toC = (pt: Point): [number, number] => [pt.x * s + ox, pt.y * s + oy];

    confirmed.forEach((co, i) => {
      const p = co.plan;
      if (!p.osteotomy_line || !p.hinge_point) return;

      const { p1, p2 } = p.osteotomy_line;
      const hinge = p.hinge_point;
      const cdeg = p.correction_deg;
      const isClosing = p.kind.includes("CLOSE");

      const [x1, y1] = toC(p1);
      const [x2, y2] = toC(p2);
      const [hx, hy] = toC(hinge);

      // ── Wedge fill (the removed/opened bone sector) ──
      if (cdeg !== 0) {
        const d1 = Math.hypot(p1.x - hinge.x, p1.y - hinge.y);
        const d2 = Math.hypot(p2.x - hinge.x, p2.y - hinge.y);
        // free = the endpoint further from the hinge (rotates the most)
        const free    = d1 >= d2 ? p1 : p2;
        const rotFree = rotatePoint(free, hinge, cdeg);
        const [fx, fy]   = toC(free);
        const [rfx, rfy] = toC(rotFree);

        // Wedge triangle: original free end → hinge → rotated free end
        ctx.beginPath();
        ctx.moveTo(fx, fy);
        ctx.lineTo(hx, hy);
        ctx.lineTo(rfx, rfy);
        ctx.closePath();
        ctx.fillStyle = isClosing
          ? "rgba(239,68,68,0.15)"
          : "rgba(249,115,22,0.15)";
        ctx.fill();
        ctx.strokeStyle = isClosing
          ? "rgba(239,68,68,0.55)"
          : "rgba(249,115,22,0.55)";
        ctx.lineWidth = 1;
        ctx.stroke();

        // Rotated cut-line edge (dashed) — shows where the fragment ended up
        const hingeEnd    = d1 >= d2 ? p2 : p1;
        const rotHingeEnd = rotatePoint(hingeEnd, hinge, cdeg);
        const [rhx, rhy] = toC(rotHingeEnd);
        ctx.beginPath();
        ctx.moveTo(rfx, rfy);
        ctx.lineTo(rhx, rhy);
        ctx.strokeStyle = "#fb923c99";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 3]);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // ── Original cut line (solid) ──
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.strokeStyle = "#fb923c";
      ctx.lineWidth = 2;
      ctx.setLineDash([]);
      ctx.stroke();

      // ── Hinge marker ──
      ctx.beginPath();
      ctx.arc(hx, hy, 5, 0, Math.PI * 2);
      ctx.fillStyle = "#ef444433";
      ctx.fill();
      ctx.strokeStyle = "#ef4444";
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // ── Index badge at midpoint of original cut line ──
      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2;
      ctx.beginPath();
      ctx.arc(mx, my, 9, 0, Math.PI * 2);
      ctx.fillStyle = "#fb923c";
      ctx.fill();
      ctx.fillStyle = "#0a0e1a";
      ctx.font = "bold 10px Inter, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(`${i + 1}`, mx, my);
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
    });
  }

  /**
   * Draw mechanical-axis and joint lines from the current landmark state.
   *
   * These lines are always recomputed from `lm` so they remain correct after
   * osteotomy confirmations, regardless of what is embedded in the base image.
   *
   * Lines drawn:
   *   Mikulicz line       hip → ankle        (magenta)
   *   Femoral mech axis   hip → knee         (red)
   *   Tibial mech axis    knee → ankle       (blue)
   *
   * Joint lines (DFL / PTL) are already drawn between handle pairs; we don't
   * duplicate them here.
   */
  function drawMeasurementLines(
    ctx: CanvasRenderingContext2D,
    lm: Landmarks | null,
    s: number, ox: number, oy: number,
  ) {
    if (!lm) return;
    const toC = (p: Point): [number, number] => [p.x * s + ox, p.y * s + oy];

    // Draw with shadow outline for contrast, then color on top
    const drawLine = (a: Point, b: Point, color: string, dash?: number[], lineW = 3) => {
      const [x1, y1] = toC(a);
      const [x2, y2] = toC(b);
      if (dash) ctx.setLineDash(dash); else ctx.setLineDash([]);
      // Shadow pass
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
      ctx.strokeStyle = "rgba(0,0,0,0.55)";
      ctx.lineWidth = lineW + 3;
      ctx.stroke();
      // Color pass
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
      ctx.strokeStyle = color;
      ctx.lineWidth = lineW;
      ctx.stroke();
      ctx.setLineDash([]);
    };

    const { hip_center: hip, knee_center: knee, ankle_center: ankle } = lm;

    // Mikulicz line (full mechanical axis hip → ankle)
    if (hip && ankle) drawLine(hip, ankle, "#e040fb");

    // Femoral mechanical axis
    if (hip && knee)  drawLine(hip,  knee,  "#ef5350", [6, 3]);

    // Tibial mechanical axis
    if (knee && ankle) drawLine(knee, ankle, "#42a5f5", [6, 3]);
  }

  /**
   * Draw anatomical axes from diaphysis shaft midpoints.
   *
   * Femoral axis: PCA direction through shaft midpoints, anchored at the
   * trochanter (hip_center), extended to the DFL intersection (analytical)
   * with perpendicular-foot and shaft-extent fallbacks.
   *
   * Tibial axis: PCA direction spanning the full cloud of tibia shaft midpoints.
   *
   * Mirrors the backend _femoral_anatomical_axis / _fit_axis logic so the
   * frontend and backend always draw the same geometry.
   */
  function drawAnatomicalAxes(
    ctx: CanvasRenderingContext2D,
    lm: Landmarks | null,
    s: number, ox: number, oy: number,
  ) {
    if (!lm) return;
    const toC = (p: Point): [number, number] => [p.x * s + ox, p.y * s + oy];

    const drawSeg = (a: Point, b: Point, color: string, label: string) => {
      const [x1, y1] = toC(a);
      const [x2, y2] = toC(b);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([]);
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.font = "10px Inter, sans-serif";
      ctx.fillText(label, x2 + 4, y2 + 4);
    };

    // ── Femoral anatomical axis ──────────────────────────────────────────
    const fLevels = lm.femur_diaphysis_levels ?? [];
    const hip = lm.hip_center;
    if (fLevels.length >= 2 && hip) {
      const mids = fLevels.map(l => ({
        x: (l.medial.x + l.lateral.x) / 2,
        y: (l.medial.y + l.lateral.y) / 2,
      }));
      const centX = mids.reduce((sum, p) => sum + p.x, 0) / mids.length;
      const centY = mids.reduce((sum, p) => sum + p.y, 0) / mids.length;
      let [dx, dy] = pca2D(mids);
      // Orient proximal → distal (hip center used only to pick which end is "up")
      if (dx * (centX - hip.x) + dy * (centY - hip.y) < 0) { dx = -dx; dy = -dy; }

      // Start: proximal end of the shaft cloud (trochanter level, not hip joint center)
      const ts = mids.map(m => (m.x - centX) * dx + (m.y - centY) * dy);
      const tMin = Math.min(...ts);
      const tMax = Math.max(...ts);
      const start: Point = { x: centX + tMin * dx, y: centY + tMin * dy };

      let end: Point;
      const dfl = lm.distal_femoral_line;
      if (dfl) {
        const ex = dfl.lateral.x - dfl.medial.x;
        const ey = dfl.lateral.y - dfl.medial.y;
        const denom = dx * ey - dy * ex;
        if (Math.abs(denom) > 1e-6) {
          // Analytical intersection: t = ((B − centroid) × E) / (D × E)
          const diffX = dfl.medial.x - centX;
          const diffY = dfl.medial.y - centY;
          const t = (diffX * ey - diffY * ex) / denom;
          end = { x: centX + t * dx, y: centY + t * dy };
        } else {
          // Near-parallel: foot of perpendicular from centroid onto DFL
          const eLen = Math.hypot(ex, ey);
          if (eLen > 1e-9) {
            const eu = ex / eLen, ev = ey / eLen;
            const sp = (centX - dfl.medial.x) * eu + (centY - dfl.medial.y) * ev;
            end = { x: dfl.medial.x + sp * eu, y: dfl.medial.y + sp * ev };
          } else {
            end = { x: centX + tMax * dx, y: centY + tMax * dy };
          }
        }
      } else {
        end = { x: centX + tMax * dx, y: centY + tMax * dy };
      }

      console.debug(
        "[DicomViewer] femur_anatomical  start=%o  end=%o  fLevels=%d  dfl=%o",
        start, end, fLevels.length, dfl,
      );
      drawSeg(start, end, "#c8c800", "Fem anat");
    }

    // ── Tibial anatomical axis ───────────────────────────────────────────
    const tLevels = lm.tibia_diaphysis_levels ?? [];
    if (tLevels.length >= 2) {
      const mids = tLevels.map(l => ({
        x: (l.medial.x + l.lateral.x) / 2,
        y: (l.medial.y + l.lateral.y) / 2,
      }));
      const centX = mids.reduce((sum, p) => sum + p.x, 0) / mids.length;
      const centY = mids.reduce((sum, p) => sum + p.y, 0) / mids.length;
      let [dx, dy] = pca2D(mids);
      // Orient proximal → distal (toward ankle)
      const knee = lm.knee_center;
      if (knee && dx * (centX - knee.x) + dy * (centY - knee.y) < 0) { dx = -dx; dy = -dy; }
      // Span the cloud (mirrors backend _fit_axis)
      const ts = mids.map(m => (m.x - centX) * dx + (m.y - centY) * dy);
      const tMin = Math.min(...ts), tMax = Math.max(...ts);
      const start: Point = { x: centX + tMin * dx, y: centY + tMin * dy };
      const end: Point   = { x: centX + tMax * dx, y: centY + tMax * dy };

      console.debug(
        "[DicomViewer] tibia_anatomical  start=%o  end=%o  tLevels=%d",
        start, end, tLevels.length,
      );
      drawSeg(start, end, "#00c8c8", "Tib anat");
    }
  }

  function drawPlanningOverlay(
    ctx: CanvasRenderingContext2D,
    p: OsteotomyPlan | null,
    lm: Landmarks | null,
    s: number, ox: number, oy: number,
  ) {
    if (!p) return;
    const toC = (pt: Point): [number, number] => [pt.x * s + ox, pt.y * s + oy];

    // Osteotomy cut line
    if (p.osteotomy_line) {
      const [x1, y1] = toC(p.osteotomy_line.p1);
      const [x2, y2] = toC(p.osteotomy_line.p2);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.strokeStyle = "#f97316";
      ctx.lineWidth = 2.5;
      ctx.setLineDash([8, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (lm) {
      const ov = computeOverlay(p, lm);

      // Original mechanical axis (faded)
      if (ov.origAxis) {
        const [x1, y1] = toC(ov.origAxis[0]);
        const [x2, y2] = toC(ov.origAxis[1]);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.strokeStyle = "rgba(255,255,255,0.22)";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Wedge fill — red tint for closing (bone removal), orange tint for opening (distraction)
      if (ov.wedge) {
        const pts = ov.wedge.map(toC);
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        ctx.lineTo(pts[1][0], pts[1][1]);
        ctx.lineTo(pts[2][0], pts[2][1]);
        ctx.closePath();
        ctx.fillStyle = ov.isClosingWedge ? "rgba(239,68,68,0.18)" : "rgba(249,115,22,0.18)";
        ctx.fill();
        ctx.strokeStyle = ov.isClosingWedge ? "#ef4444" : "#f97316";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      // New mechanical / femoral axis
      if (ov.newAxis) {
        const [x1, y1] = toC(ov.newAxis[0]);
        const [x2, y2] = toC(ov.newAxis[1]);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.strokeStyle = "#22c55e";
        ctx.lineWidth = 2;
        ctx.stroke();
      }

// New tibial segment (HTO: knee → new_ankle; DFO: new_knee → new_ankle)
      if (ov.newSegment) {
        const [x1, y1] = toC(ov.newSegment[0]);
        const [x2, y2] = toC(ov.newSegment[1]);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.strokeStyle = "#4ade80";
        ctx.lineWidth = 2.5;
        ctx.stroke();
      }

      // Correction arc
      if (ov.arc) {
        const [cx2, cy2] = toC(ov.arc.center);
        ctx.beginPath();
        ctx.arc(cx2, cy2, ov.arc.radius * s, ov.arc.start, ov.arc.end, ov.arc.end < ov.arc.start);
        ctx.strokeStyle = "#fbbf24";
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      // Rotated DFL (DFO)
      if (ov.rotatedDFL) {
        const [x1, y1] = toC(ov.rotatedDFL[0]);
        const [x2, y2] = toC(ov.rotatedDFL[1]);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.strokeStyle = "#a78bfa";
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 3]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // Plan handles (drawn on top)
    for (const h of planHandles.current) {
      const [sx, sy] = toC({ x: h.x, y: h.y });
      ctx.beginPath();
      ctx.arc(sx, sy, h.radius, 0, Math.PI * 2);
      ctx.fillStyle = h.color + "44";
      ctx.fill();
      ctx.strokeStyle = h.color;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = h.color;
      ctx.font = "10px Inter, sans-serif";
      ctx.fillText(h.label, sx + h.radius + 2, sy + 4);
    }
  }

  function drawMeasurePoints(
    ctx: CanvasRenderingContext2D,
    s: number, ox: number, oy: number,
  ) {
    const toC = (p: Point): [number, number] => [p.x * s + ox, p.y * s + oy];
    const dot = (p: Point, color: string, label: string) => {
      const [x, y] = toC(p);
      ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.fillStyle = color; ctx.fill();
      ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.fillStyle = color; ctx.font = "10px Inter, sans-serif";
      ctx.fillText(label, x + 9, y - 3);
    };

    const hp = hipMeasRef.current;
    hp.forEach((p, i) => dot(p, "#f472b6", `H${i + 1}`));
    if (hp.length === 3) {
      const circ = circumscribedCircle(hp[0], hp[1], hp[2]);
      if (circ) {
        const [cx2, cy2] = toC({ x: circ.cx, y: circ.cy });
        ctx.beginPath(); ctx.arc(cx2, cy2, circ.r * s, 0, Math.PI * 2);
        ctx.strokeStyle = "#f472b688"; ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 3]); ctx.stroke(); ctx.setLineDash([]);
        ctx.beginPath(); ctx.arc(cx2, cy2, 5, 0, Math.PI * 2);
        ctx.fillStyle = "#f472b6"; ctx.fill();
      }
    }

    // Femur base intermediate points + preview joint line
    const fp = femurMeasRef.current;
    fp.forEach((p, i) => dot(p, "#a78bfa", `F${i + 1}`));
    if (fp.length >= 2) {
      const [x1, y1] = toC(fp[0]); const [x2, y2] = toC(fp[1]);
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
      ctx.strokeStyle = "#a78bfa88"; ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 3]); ctx.stroke(); ctx.setLineDash([]);
    }

    // Tibia base intermediate points + preview joint line
    const tp = tibiaMeasRef.current;
    tp.forEach((p, i) => dot(p, "#38bdf8", `T${i + 1}`));
    if (tp.length >= 2) {
      const [x1, y1] = toC(tp[0]); const [x2, y2] = toC(tp[1]);
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
      ctx.strokeStyle = "#38bdf888"; ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 3]); ctx.stroke(); ctx.setLineDash([]);
    }

    // Ankle intermediate points + preview joint line
    const ap = ankleMeasRef.current;
    ap.forEach((p, i) => dot(p, "#fb923c", `A${i + 1}`));
    if (ap.length >= 2) {
      const [x1, y1] = toC(ap[0]); const [x2, y2] = toC(ap[1]);
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
      ctx.strokeStyle = "#fb923c88"; ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 3]); ctx.stroke(); ctx.setLineDash([]);
    }
  }

  function drawAnnotations(
    ctx: CanvasRenderingContext2D,
    s: number, ox: number, oy: number,
  ) {
    const toC = (p: Point): [number, number] => [p.x * s + ox, p.y * s + oy];
    const pxMm = pixelSpacingRef.current;

    const drawDot = (p: Point, color: string) => {
      const [x, y] = toC(p);
      ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fillStyle = color; ctx.fill();
    };

    const label = (text: string, x: number, y: number, color: string) => {
      const w = ctx.measureText(text).width + 8;
      ctx.fillStyle = "rgba(10,14,26,0.85)";
      ctx.fillRect(x - w / 2, y - 11, w, 14);
      ctx.fillStyle = color; ctx.font = "bold 11px Inter, sans-serif";
      ctx.textAlign = "center"; ctx.fillText(text, x, y); ctx.textAlign = "left";
    };

    for (const ann of annotationsRef.current) {
      if (ann.type === "line") {
        const [x1, y1] = toC(ann.p1); const [x2, y2] = toC(ann.p2);
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
        ctx.strokeStyle = "#38bdf8"; ctx.lineWidth = 1.5; ctx.stroke();
        drawDot(ann.p1, "#38bdf8"); drawDot(ann.p2, "#38bdf8");
        const dist = Math.hypot(ann.p2.x - ann.p1.x, ann.p2.y - ann.p1.y);
        const lbl = pxMm ? `${(dist * pxMm).toFixed(1)} mm` : `${dist.toFixed(0)} px`;
        label(lbl, (x1 + x2) / 2, (y1 + y2) / 2, "#38bdf8");
      }
      if (ann.type === "angle") {
        const [vx, vy] = toC(ann.vertex);
        const [x1, y1] = toC(ann.p1); const [x2, y2] = toC(ann.p2);
        ctx.beginPath(); ctx.moveTo(vx, vy); ctx.lineTo(x1, y1);
        ctx.strokeStyle = "#fbbf24"; ctx.lineWidth = 1.5; ctx.stroke();
        ctx.beginPath(); ctx.moveTo(vx, vy); ctx.lineTo(x2, y2);
        ctx.strokeStyle = "#fbbf24"; ctx.lineWidth = 1.5; ctx.stroke();
        drawDot(ann.vertex, "#fbbf24"); drawDot(ann.p1, "#fbbf24"); drawDot(ann.p2, "#fbbf24");
        const a1 = Math.atan2((y1 - vy), (x1 - vx));
        const a2 = Math.atan2((y2 - vy), (x2 - vx));
        ctx.beginPath(); ctx.arc(vx, vy, 18, a1, a2);
        ctx.strokeStyle = "#fbbf2488"; ctx.lineWidth = 1.5; ctx.stroke();
        const dx1 = ann.p1.x - ann.vertex.x; const dy1 = ann.p1.y - ann.vertex.y;
        const dx2 = ann.p2.x - ann.vertex.x; const dy2 = ann.p2.y - ann.vertex.y;
        const cos = (dx1*dx2+dy1*dy2) / (Math.hypot(dx1,dy1)*Math.hypot(dx2,dy2)+1e-9);
        const angleDeg = (180/Math.PI)*Math.acos(Math.max(-1,Math.min(1,cos)));
        const midA = (a1 + a2) / 2;
        label(`${angleDeg.toFixed(1)}°`, vx + 30 * Math.cos(midA), vy + 30 * Math.sin(midA), "#fbbf24");
      }
      if (ann.type === "text") {
        const [tx, ty] = toC(ann.pos);
        ctx.font = "13px Inter, sans-serif";
        const w = ctx.measureText(ann.text).width + 6;
        ctx.fillStyle = "rgba(10,14,26,0.75)"; ctx.fillRect(tx - 2, ty - 13, w, 16);
        ctx.fillStyle = "#fff"; ctx.fillText(ann.text, tx, ty);
      }
    }

    // Pending annotation preview
    const pending = pendingAnnotRef.current;
    const tool = activeToolRef.current;
    if (tool === "line" && pending.length >= 1) {
      drawDot(pending[0], "#38bdf888");
    }
    if (tool === "angle" && pending.length >= 1) {
      pending.forEach(p => drawDot(p, "#fbbf2488"));
      if (pending.length === 2) {
        const [x1, y1] = toC(pending[0]); const [x2, y2] = toC(pending[1]);
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
        ctx.strokeStyle = "#fbbf2444"; ctx.lineWidth = 1; ctx.stroke();
      }
    }
  }

  // ------------------------------------------------------------------
  // Angle label overlay
  // ------------------------------------------------------------------

  function drawAngleLabels(
    ctx: CanvasRenderingContext2D,
    lm: Landmarks | null,
    ang: Angles | null,
    s: number, ox: number, oy: number,
  ) {
    if (!lm || !ang) return;
    const toC = (p: Point): [number, number] => [p.x * s + ox, p.y * s + oy];

    const label = (text: string, cx: number, cy: number, color: string) => {
      ctx.font = "bold 13px Inter, sans-serif";
      const tw = ctx.measureText(text).width;
      const pw = 12, ph = 8;
      const w = tw + pw * 2;
      const h = 22;
      const bx = cx - w / 2, by = cy - h / 2;
      // Drop shadow
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.beginPath();
      ctx.roundRect(bx + 2, by + 2, w, h, 5);
      ctx.fill();
      // Background
      ctx.fillStyle = "rgba(8,12,22,0.92)";
      ctx.beginPath();
      ctx.roundRect(bx, by, w, h, 5);
      ctx.fill();
      // Colored border
      ctx.strokeStyle = color + "88";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(bx, by, w, h, 5);
      ctx.stroke();
      // Text
      ctx.fillStyle = color;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(text, cx, cy);
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
    };

    const normalColor   = "#4ade80";  // green
    const abnormalColor = "#f87171";  // red
    const unknownColor  = "#94a3b8";  // grey

    const colorFor = (key: "HKA" | "mLDFA" | "mMPTA" | "JLCA", val: number | null): string => {
      if (val === null) return unknownColor;
      switch (key) {
        case "HKA":   return Math.abs(val) <= 3          ? normalColor : abnormalColor;
        case "mLDFA": return val >= 85 && val <= 90      ? normalColor : abnormalColor;
        case "mMPTA": return val >= 85 && val <= 90      ? normalColor : abnormalColor;
        case "JLCA":  return Math.abs(val) <= 2          ? normalColor : abnormalColor;
        default:      return unknownColor;
      }
    };

    // mLDFA — midpoint of DFL, offset right and slightly up
    if (ang.mLDFA_deg !== null && lm.distal_femoral_line) {
      const dfl = lm.distal_femoral_line;
      const [mx, my] = [
        (dfl.medial.x + dfl.lateral.x) / 2,
        (dfl.medial.y + dfl.lateral.y) / 2,
      ];
      const [cx, cy] = toC({ x: mx, y: my });
      label(`mLDFA: ${ang.mLDFA_deg.toFixed(1)}°`, cx + 110, cy - 20, colorFor("mLDFA", ang.mLDFA_deg));
    }

    // mMPTA — midpoint of PTL, offset left
    if (ang.mMPTA_deg !== null && lm.proximal_tibial_line) {
      const ptl = lm.proximal_tibial_line;
      const [mx, my] = [
        (ptl.medial.x + ptl.lateral.x) / 2,
        (ptl.medial.y + ptl.lateral.y) / 2,
      ];
      const [cx, cy] = toC({ x: mx, y: my });
      label(`mMPTA: ${ang.mMPTA_deg.toFixed(1)}°`, cx - 110, cy, colorFor("mMPTA", ang.mMPTA_deg));
    }

    // JLCA — knee center, offset down
    if (ang.JLCA_deg !== null && lm.knee_center) {
      const [cx, cy] = toC(lm.knee_center);
      label(`JLCA: ${ang.JLCA_deg.toFixed(1)}°`, cx, cy + 45, colorFor("JLCA", ang.JLCA_deg));
    }

    // HKA — midpoint of hip→ankle axis, offset right
    if (ang.HKA_deg !== null && lm.hip_center && lm.ankle_center) {
      const mid = {
        x: (lm.hip_center.x + lm.ankle_center.x) / 2,
        y: (lm.hip_center.y + lm.ankle_center.y) / 2,
      };
      const [cx, cy] = toC(mid);
      const hkaText = `HKA: ${ang.HKA_deg.toFixed(1)}°`;
      label(hkaText, cx + 110, cy, colorFor("HKA", ang.HKA_deg));
    }
  }

  // ------------------------------------------------------------------
  // Confirmed sagittal osteotomies overlay
  // ------------------------------------------------------------------

  /**
   * Draw annotation overlays for each confirmed sagittal osteotomy.
   * The pixel-level simulation is handled by the confirmed-ost chaining in
   * draw(). This function draws the cut line, hinge marker, index badge,
   * and corrected-slope label on top.
   */
  function drawConfirmedSagittalOsts(
    ctx: CanvasRenderingContext2D,
    confirmed: ConfirmedSagittalOst[],
    s: number, ox: number, oy: number,
  ) {
    if (confirmed.length === 0) return;
    const toC = (p: Point): [number, number] => [p.x * s + ox, p.y * s + oy];

    confirmed.forEach((co, i) => {
      const { cutP1, cutP2, hingePoint } = co.ost;
      if (!cutP1 || !cutP2 || !hingePoint) return;

      const [x1, y1] = toC(cutP1);
      const [x2, y2] = toC(cutP2);
      const [hx, hy] = toC(hingePoint);

      // Cut line (orange, dashed)
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.strokeStyle = "#fb923c";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 3]);
      ctx.stroke();
      ctx.setLineDash([]);

      // Hinge marker
      ctx.beginPath();
      ctx.arc(hx, hy, 5, 0, Math.PI * 2);
      ctx.fillStyle = "#ef444433";
      ctx.fill();
      ctx.strokeStyle = "#ef4444";
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Index badge at midpoint of cut line
      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2;
      ctx.beginPath();
      ctx.arc(mx, my, 9, 0, Math.PI * 2);
      ctx.fillStyle = "#fb923c";
      ctx.fill();
      ctx.fillStyle = "#0a0e1a";
      ctx.font = "bold 10px Inter, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(`${i + 1}`, mx, my);
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";

      // Slope delta label above midpoint
      const isNormal = co.slopeAfter >= 5 && co.slopeAfter <= 10;
      const labelColor = isNormal ? "#4ade80" : "#f87171";
      const sign = co.slopeAfter > 0 ? "+" : "";
      const lbl = `→ ${sign}${co.slopeAfter.toFixed(1)}°`;
      ctx.font = "11px Inter, sans-serif";
      const tw = ctx.measureText(lbl).width;
      const lx = mx - tw / 2 - 3;
      const ly = my - 20;
      ctx.fillStyle = "rgba(0,0,0,0.65)";
      ctx.fillRect(lx, ly - 10, tw + 8, 14);
      ctx.fillStyle = labelColor;
      ctx.textAlign = "center";
      ctx.fillText(lbl, mx + 1, ly);
      ctx.textAlign = "left";
    });
  }

  // ------------------------------------------------------------------
  // Tibial slope overlay
  // ------------------------------------------------------------------

  /**
   * Dejour & Bonnin tibial slope overlay.
   *
   * Draws:
   *   1. Medial plateau tangent (yellow)
   *   2. Both cortex pairs with connecting line + midpoint marker (green / teal)
   *   3. Tibial shaft axis (line through both midpoints, white)
   *   4. Perpendicular reference line through the plateau midpoint (dashed white)
   *   5. Angle arc at the plateau midpoint
   *   6. Label: "TS: +X.X°"
   */
  function drawSlopeOverlay(
    ctx: CanvasRenderingContext2D,
    step: SlopeStep,
    pts: SlopePoints,
    slopeVal: number | null,
    s: number, ox: number, oy: number,
    /** Hide plateau tangent + angle annotation when sagittal sim has taken over. */
    skipPlateau = false,
  ) {
    const toC = (p: Point): [number, number] => [p.x * s + ox, p.y * s + oy];

    // Small labeled dot
    const dot = (p: Point, color: string, lbl: string) => {
      const [cx, cy] = toC(p);
      ctx.beginPath(); ctx.arc(cx, cy, 5, 0, Math.PI * 2);
      ctx.fillStyle = color + "44"; ctx.fill();
      ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();
      ctx.fillStyle = color; ctx.font = "10px Inter, sans-serif";
      ctx.fillText(lbl, cx + 8, cy + 3);
    };

    // Cross marker for midpoints
    const cross = (p: Point, color: string) => {
      const [cx, cy] = toC(p);
      const r = 6;
      ctx.strokeStyle = color; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy);
      ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r); ctx.stroke();
    };

    // Line between two canvas-coord points, optionally dashed
    const seg = (a: Point, b: Point, color: string, w = 1.6, dash: number[] = []) => {
      const [ax, ay] = toC(a); const [bx, by] = toC(b);
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
      ctx.strokeStyle = color; ctx.lineWidth = w;
      ctx.setLineDash(dash); ctx.stroke(); ctx.setLineDash([]);
    };

    // Extended infinite line through a and b, clipped to canvas
    const extLine = (a: Point, b: Point, color: string, w = 1.4, dash: number[] = []) => {
      const W = ctx.canvas.width; const H = ctx.canvas.height;
      const dx = b.x - a.x; const dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (len < 1) return;
      const ext = Math.hypot(W, H) / s + 200;
      const p1: Point = { x: a.x - (dx / len) * ext, y: a.y - (dy / len) * ext };
      const p2: Point = { x: a.x + (dx / len) * ext, y: a.y + (dy / len) * ext };
      seg(p1, p2, color, w, dash);
    };

    const {
      plateauP1: pP1, plateauP2: pP2,
      cortex1Ant: c1a, cortex1Post: c1p,
      cortex2Ant: c2a, cortex2Post: c2p,
    } = pts;

    // ── 1. Plateau tangent (yellow) — hidden when sagittal sim is active ──
    if (!skipPlateau) {
      if (pP1) dot(pP1, "#facc15", "Plateau");
      if (pP2) dot(pP2, "#facc15", "Plateau");
      if (pP1 && pP2) extLine(pP1, pP2, "#facc15bb", 1.8);
    }

    // ── 2. Cortex pair at ~5 cm (green) ─────────────────────────────────
    if (c1a) dot(c1a, "#4ade80", "ant.");
    if (c1p) dot(c1p, "#4ade80", "post.");
    if (c1a && c1p) {
      seg(c1a, c1p, "#4ade8099", 1.4, [5, 4]);
      const m1: Point = { x: (c1a.x + c1p.x) / 2, y: (c1a.y + c1p.y) / 2 };
      cross(m1, "#4ade80");
    }

    // ── 3. Cortex pair at ~15 cm (teal) ─────────────────────────────────
    if (c2a) dot(c2a, "#2dd4bf", "ant.");
    if (c2p) dot(c2p, "#2dd4bf", "post.");
    if (c2a && c2p) {
      seg(c2a, c2p, "#2dd4bf99", 1.4, [5, 4]);
      const m2: Point = { x: (c2a.x + c2p.x) / 2, y: (c2a.y + c2p.y) / 2 };
      cross(m2, "#2dd4bf");
    }

    // ── 4–6. Full overlay when all 6 points are placed ───────────────────
    if (step === "done" && pP1 && pP2 && c1a && c1p && c2a && c2p && slopeVal !== null) {
      const mid1: Point = { x: (c1a.x + c1p.x) / 2, y: (c1a.y + c1p.y) / 2 };
      const mid2: Point = { x: (c2a.x + c2p.x) / 2, y: (c2a.y + c2p.y) / 2 };

      // Tibial shaft axis (through midpoints, extended) — always drawn
      extLine(mid1, mid2, "rgba(255,255,255,0.55)", 1.6);

      // Shaft direction unit vector
      const dx_s = mid2.x - mid1.x; const dy_s = mid2.y - mid1.y;
      const len_s = Math.hypot(dx_s, dy_s);
      const sx = dx_s / len_s; const sy = dy_s / len_s;
      // Perpendicular to shaft (90° CCW: -y, x)
      const nx = -sy; const ny = sx;

      // Plateau-relative geometry — only when sagittal sim hasn't taken over
      if (!skipPlateau) {
        // Perpendicular reference through the midpoint of the plateau line
        const platMid: Point = { x: (pP1.x + pP2.x) / 2, y: (pP1.y + pP2.y) / 2 };
        const perpA: Point = { x: platMid.x + nx, y: platMid.y + ny };
        extLine(platMid, perpA, "rgba(255,255,255,0.35)", 1.4, [6, 5]);

        // Angle arc at the plateau midpoint (canvas coords)
        const [mcx, mcy] = toC(platMid);
        const ARC_R = 28;

        const plateauAngle = Math.atan2(
          (pP2.y - pP1.y) * s,
          (pP2.x - pP1.x) * s,
        );
        const perpAngle = Math.atan2(ny * s, nx * s);

        ctx.beginPath();
        ctx.arc(mcx, mcy, ARC_R, perpAngle, plateauAngle, slopeVal < 0);
        ctx.strokeStyle = "#facc1599"; ctx.lineWidth = 2;
        ctx.setLineDash([]); ctx.stroke();

        // "TS: +X.X°" label
        const sign = slopeVal > 0 ? "+" : "";
        const label = `TS: ${sign}${slopeVal.toFixed(1)}°`;
        ctx.font = "bold 13px Inter, sans-serif";
        const tw = ctx.measureText(label).width;
        const lx = mcx + ARC_R + 10; const ly = mcy - 6;
        ctx.fillStyle = "rgba(0,0,0,0.65)";
        ctx.fillRect(lx - 4, ly - 14, tw + 10, 20);
        ctx.fillStyle = "#facc15";
        ctx.fillText(label, lx + 1, ly);
      }
    }
  }

  // ------------------------------------------------------------------
  // Sagittal osteotomy overlay
  // ------------------------------------------------------------------

  /**
   * Anterior-closing osteotomy simulation overlay.
   *
   * Draws:
   *   1. Original plateau tangent (thin gray, dashed, extended)
   *   2. Hinge point (red marker)
   *   3. Cut line P1/P2 (orange dashed)
   *   4. Corrected plateau tangent (green, extended) + wedge fill
   *   5. Slope labels (before / after)
   */
  function drawSagittalOverlay(
    ctx: CanvasRenderingContext2D,
    step: SagittalStep,
    ost: SagittalOsteotomy,
    result: SagittalResult | null,
    slopePts: SlopePoints,
    origSlope: number | null,
    s: number, ox: number, oy: number,
  ) {
    if (step === "idle") return;

    const toC = (p: Point): [number, number] => [p.x * s + ox, p.y * s + oy];

    const dot = (p: Point, color: string, lbl: string, r = 5) => {
      const [cx, cy] = toC(p);
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = color + "44"; ctx.fill();
      ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();
      if (lbl) {
        ctx.fillStyle = color; ctx.font = "10px Inter, sans-serif";
        ctx.fillText(lbl, cx + r + 4, cy + 3);
      }
    };

    const seg = (a: Point, b: Point, color: string, w = 1.5, dash: number[] = []) => {
      const [ax, ay] = toC(a); const [bx, by] = toC(b);
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
      ctx.strokeStyle = color; ctx.lineWidth = w;
      ctx.setLineDash(dash); ctx.stroke(); ctx.setLineDash([]);
    };

    const extLine = (a: Point, b: Point, color: string, w = 1.4, dash: number[] = []) => {
      const W = ctx.canvas.width; const H = ctx.canvas.height;
      const dx = b.x - a.x; const dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (len < 1) return;
      const ext = Math.hypot(W, H) / s + 200;
      const p1: Point = { x: a.x - (dx / len) * ext, y: a.y - (dy / len) * ext };
      const p2: Point = { x: a.x + (dx / len) * ext, y: a.y + (dy / len) * ext };
      seg(p1, p2, color, w, dash);
    };

    // ── 1. Original plateau tangent (gray dashed, always visible once hinge placed) ──
    const { plateauP1: pP1, plateauP2: pP2 } = slopePts;
    if (pP1 && pP2) {
      extLine(pP1, pP2, "rgba(150,150,150,0.55)", 1.2, [5, 4]);
    }

    // ── 2. Hinge point ──────────────────────────────────────────────────────
    if (ost.hingePoint) {
      dot(ost.hingePoint, "#ef4444", "H", 7);
    }

    // ── 3. Cut line ─────────────────────────────────────────────────────────
    if (ost.cutP1) dot(ost.cutP1, "#f97316", "O1");
    if (ost.cutP2) dot(ost.cutP2, "#f97316", "O2");
    if (ost.cutP1 && ost.cutP2) {
      seg(ost.cutP1, ost.cutP2, "#f97316", 2, [6, 4]);
    }

    // ── 3b. Rubber-band: live preview line during cut_p2 placement ──────────
    if (step === "cut_p2" && ost.cutP1 && cursorRef.current) {
      const [p1x, p1y] = toC(ost.cutP1);
      const [cx, cy]   = toC(cursorRef.current);
      ctx.beginPath();
      ctx.moveTo(p1x, p1y);
      ctx.lineTo(cx, cy);
      ctx.strokeStyle = "#f9731688";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // ── 4. Corrected plateau (when simulation is active) ────────────────────
    // The pixel-level bone rotation is rendered by drawSagittalSimulation.
    // This overlay adds the mathematical corrected-plateau line and labels.
    if (result && ost.hingePoint && pP1 && pP2) {
      const { correctedP1: cp1, correctedP2: cp2, correctedSlope } = result;

      // Corrected plateau line (green if normal, red otherwise)
      const isNormal = correctedSlope >= 5 && correctedSlope <= 10;
      const lineColor = isNormal ? "#4ade80" : "#f87171";
      extLine(cp1, cp2, lineColor, 2);
      dot(cp1, lineColor, "");
      dot(cp2, lineColor, "");

      // Label: corrected slope at midpoint of corrected plateau
      const midX = (toC(cp1)[0] + toC(cp2)[0]) / 2;
      const midY = (toC(cp1)[1] + toC(cp2)[1]) / 2 - 18;
      const sign = correctedSlope > 0 ? "+" : "";
      const labelText = `→ ${sign}${correctedSlope.toFixed(1)}°`;
      ctx.font = "bold 13px Inter, sans-serif";
      const tw = ctx.measureText(labelText).width;
      ctx.fillStyle = "rgba(0,0,0,0.7)";
      ctx.fillRect(midX - tw / 2 - 4, midY - 13, tw + 10, 18);
      ctx.fillStyle = lineColor;
      ctx.textAlign = "center";
      ctx.fillText(labelText, midX + 1, midY);
      ctx.textAlign = "left";

      // Original slope label (small, gray, at original plateau midpoint)
      if (origSlope !== null) {
        const omx = (toC(pP1)[0] + toC(pP2)[0]) / 2;
        const omy = (toC(pP1)[1] + toC(pP2)[1]) / 2 - 18;
        const oSign = origSlope > 0 ? "+" : "";
        const oLabel = `${oSign}${origSlope.toFixed(1)}°`;
        ctx.font = "11px Inter, sans-serif";
        const otw = ctx.measureText(oLabel).width;
        ctx.fillStyle = "rgba(0,0,0,0.6)";
        ctx.fillRect(omx - otw / 2 - 3, omy - 11, otw + 8, 15);
        ctx.fillStyle = "rgba(200,200,200,0.8)";
        ctx.textAlign = "center";
        ctx.fillText(oLabel, omx, omy);
        ctx.textAlign = "left";
      }
    }
  }

  // ------------------------------------------------------------------
  // Main draw
  // ------------------------------------------------------------------

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return;

    const container = containerRef.current!;
    const { width: cw, height: ch } = container.getBoundingClientRect();
    canvas.width = cw;
    canvas.height = ch;

    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, cw, ch);

    const s = scaleRef.current;
    const { x: ox, y: oy } = offsetRef.current;

    // Image draw — build a chained draw function:
    //   base image → confirmed osteotomy simulations (in order) → active plan simulation
    // Each confirmed osteotomy permanently rotates the moving bone fragment so
    // the corrected anatomy persists visually after confirmation.
    const _plan      = planRef.current;
    const _lm        = landmarksRef.current;
    const _confirmed = confirmedOstsRef.current;
    const W = ctx.canvas.width;
    const H = ctx.canvas.height;

    const isLongLeg = imageTypeRef.current === "long_leg_ap";
    const isLateral = !isLongLeg;

    // Rendering gates — prevent partial/misleading measurements from showing
    const calibrated = pixelSpacingRef.current !== null;
    const _lmFull = landmarksRef.current;
    const landmarksComplete = isLongLeg && !!(
      _lmFull?.hip_center &&
      _lmFull?.distal_femoral_line &&
      _lmFull?.proximal_tibial_line &&
      _lmFull?.ankle_center
    );
    const readyToMeasure = calibrated && landmarksComplete;

    if (isLongLeg) {
      // Use the raw (unannotated) DICOM image as the simulation base when available.
      // This ensures bone-fragment rotation never clips or rotates axis lines that
      // were previously drawn by the backend renderer.  Falls back to the annotated
      // image when no raw image is loaded (e.g. sessions from before this feature).
      const simBase = rawImgRef.current ?? img;

      // drawBase: a callback that renders the current "source" image onto ctx
      let drawBase: (c: CanvasRenderingContext2D) => void = (c) =>
        c.drawImage(simBase, ox, oy, simBase.naturalWidth * s, simBase.naturalHeight * s);

      // Chain each confirmed osteotomy's simulation into an offscreen canvas
      for (const co of _confirmed) {
        if (!co.plan.osteotomy_line || !co.plan.hinge_point || co.plan.correction_deg === 0) continue;
        const prevDraw = drawBase;
        const offscreen = document.createElement("canvas");
        offscreen.width  = W;
        offscreen.height = H;
        const offCtx = offscreen.getContext("2d")!;
        drawOsteotomySimulation(offCtx, prevDraw, co.plan, co.landmarksAtConfirm, s, ox, oy);
        // Capture offscreen in closure so each iteration is independent
        const captured = offscreen;
        drawBase = (c) => c.drawImage(captured, 0, 0);
      }

      // Draw active plan simulation on top, or just the chained base
      if (_plan && _lm) {
        drawOsteotomySimulation(ctx, drawBase, _plan, _lm, s, ox, oy);
      } else {
        drawBase(ctx);
      }
    } else {
      // Lateral mode: use the raw (unannotated) image so that backend-drawn
      // axis lines (Mikulicz, mechanical axes) don't bleed into the slope view.
      const lateralBase = rawImgRef.current ?? img;
      const drawLateral = (c: CanvasRenderingContext2D) =>
        c.drawImage(lateralBase, ox, oy, lateralBase.naturalWidth * s, lateralBase.naturalHeight * s);

      // Chain each confirmed sagittal osteotomy into an offscreen canvas.
      // This permanently applies each confirmed bone rotation so subsequent
      // osteotomies and the active simulation build on the corrected anatomy.
      const _confirmedSagOsts = confirmedSagOstsRef.current;
      let drawSagBase = drawLateral;
      for (const co of _confirmedSagOsts) {
        if (!co.ost.cutP1 || !co.ost.cutP2 || !co.ost.hingePoint || co.ost.correctionDeg === 0) continue;
        const prevDraw = drawSagBase;
        const offscreen = document.createElement("canvas");
        offscreen.width  = W;
        offscreen.height = H;
        const offCtx = offscreen.getContext("2d")!;
        drawSagittalSimulation(offCtx, prevDraw, co.ost, slopePtsRef.current, s, ox, oy);
        const captured = offscreen;
        drawSagBase = (c) => c.drawImage(captured, 0, 0);
      }

      // Active simulation runs on top of the confirmed chain.
      const _sagOst = sagittalOstRef.current;
      if (
        sagittalStepRef.current === "active" &&
        _sagOst.cutP1 && _sagOst.cutP2 && _sagOst.hingePoint
      ) {
        drawSagittalSimulation(ctx, drawSagBase, _sagOst, slopePtsRef.current, s, ox, oy);
      } else {
        drawSagBase(ctx);
      }
    }

    if (isLongLeg) {
      // Draw handles
      for (const h of handles.current) {
        const sx = h.x * s + ox;
        const sy = h.y * s + oy;
        const isDraggable = h.draggable !== false;

        ctx.beginPath();
        ctx.arc(sx, sy, h.radius, 0, Math.PI * 2);
        ctx.fillStyle = h.color + (isDraggable ? "55" : "33");
        ctx.fill();
        ctx.strokeStyle = h.color;
        ctx.lineWidth = isDraggable ? 2 : 1.5;
        // Non-draggable handles (post-rotation position) get a dashed ring
        if (!isDraggable) ctx.setLineDash([4, 3]);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = h.color;
        ctx.font = "11px Inter, sans-serif";
        ctx.fillText(h.label, sx + h.radius + 3, sy + 4);
      }

      // Draw joint lines between paired handles
      const dflM = handles.current.find(h => h.id === "dfl_m");
      const dflL = handles.current.find(h => h.id === "dfl_l");
      if (dflM && dflL) {
        drawLine(ctx, dflM, dflL, "#a78bfa", s, ox, oy);
      }
      const ptlM = handles.current.find(h => h.id === "ptl_m");
      const ptlL = handles.current.find(h => h.id === "ptl_l");
      if (ptlM && ptlL) {
        drawLine(ctx, ptlM, ptlL, "#38bdf8", s, ox, oy);
      }

      // Draw diaphysis cortex level lines
      for (let i = 0; ; i++) {
        const fm = handles.current.find(h => h.id === `fd_${i}_m`);
        const fl = handles.current.find(h => h.id === `fd_${i}_l`);
        if (!fm || !fl) break;
        drawLine(ctx, fm, fl, "#c8c800", s, ox, oy);
      }
      for (let i = 0; ; i++) {
        const tm = handles.current.find(h => h.id === `td_${i}_m`);
        const tl = handles.current.find(h => h.id === `td_${i}_l`);
        if (!tm || !tl) break;
        drawLine(ctx, tm, tl, "#00c8c8", s, ox, oy);
      }
    }

    // Draw calibration overlay
    {
      const cp = calibPointsRef.current;
      if (cp.p1 || cp.p2 || cp.p3) drawCalibrationOverlay(ctx, cp, calibTypeRef.current, s, ox, oy);
    }

    if (isLongLeg && readyToMeasure) {
      // Measurement lines — always computed fresh from current landmarks so they
      // stay consistent with the transformed anatomy after osteotomy confirmation.
      drawMeasurementLines(ctx, landmarksRef.current, s, ox, oy);

      // Anatomical axes — only when the toggle is on; computed from shaft handles
      // using the same PCA/DFL-intersection logic as the backend.
      if (showAnatomicalRef.current) {
        drawAnatomicalAxes(ctx, landmarksRef.current, s, ox, oy);
      }
    }

    if (isLongLeg && readyToMeasure) {
      // Draw confirmed osteotomies (locked, below active plan)
      drawConfirmedOsteotomies(ctx, confirmedOstsRef.current, s, ox, oy);

      // Draw planning overlay (active plan on top)
      drawPlanningOverlay(ctx, planRef.current, landmarksRef.current, s, ox, oy);
    }

    if (isLongLeg) {
      // --- Rubber-band preview: show P1 dot + live line to cursor during placement ---
      const _step   = planningStepRef.current;
      const _p1     = pendingOstP1Ref.current;
      const _cursor = cursorRef.current;
      if (_step === "ost_p2" && _p1) {
        const toC2 = (pt: Point): [number, number] => [pt.x * s + ox, pt.y * s + oy];
        const [px, py] = toC2(_p1);
        // P1 marker
        ctx.beginPath();
        ctx.arc(px, py, 8, 0, Math.PI * 2);
        ctx.fillStyle = "#f9731644";
        ctx.fill();
        ctx.strokeStyle = "#f97316";
        ctx.lineWidth = 2;
        ctx.setLineDash([]);
        ctx.stroke();
        ctx.fillStyle = "#f97316";
        ctx.font = "10px Inter, sans-serif";
        ctx.fillText("O1", px + 10, py + 4);
        // Rubber-band to cursor
        if (_cursor) {
          const [cx2, cy2] = toC2(_cursor);
          ctx.beginPath();
          ctx.moveTo(px, py);
          ctx.lineTo(cx2, cy2);
          ctx.strokeStyle = "#f9731688";
          ctx.lineWidth = 1.5;
          ctx.setLineDash([6, 4]);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
    }

    // Measurement points and annotations in both modes
    drawMeasurePoints(ctx, s, ox, oy);
    drawAnnotations(ctx, s, ox, oy);

    if (isLongLeg && readyToMeasure) {
      // Angle labels — drawn last so they appear on top of everything
      drawAngleLabels(ctx, landmarksRef.current, anglesRef.current, s, ox, oy);
    }

    // Hint when calibrated but landmarks still incomplete
    if (isLongLeg && calibrated && !landmarksComplete) {
      const tDraw = (key: string): string => {
        const dict = translations[langRef.current] as Record<string, string>;
        const fallback = translations.en as Record<string, string>;
        return dict?.[key] ?? fallback?.[key] ?? key;
      };
      const hint = tDraw("hint_set_landmarks");
      ctx.font = "bold 13px Inter, sans-serif";
      const tw = ctx.measureText(hint).width;
      const hx = W / 2 - tw / 2;
      const hy = H - 18;
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(hx - 10, hy - 16, tw + 20, 24);
      ctx.fillStyle = "#93c5fd";
      ctx.fillText(hint, hx, hy);
    }

    // Tibial slope overlay (knee lateral mode — Dejour & Bonnin)
    if (isLateral) {
      const sagIsActive = sagittalStepRef.current === "active";
      drawSlopeOverlay(ctx, slopeStepRef.current, slopePtsRef.current, slopeValueRef.current, s, ox, oy, sagIsActive);
      drawConfirmedSagittalOsts(ctx, confirmedSagOstsRef.current, s, ox, oy);
      drawSagittalOverlay(ctx, sagittalStepRef.current, sagittalOstRef.current, sagittalResultRef.current, slopePtsRef.current, slopeValueRef.current, s, ox, oy);
    }
  }, []);

  function drawLine(ctx: CanvasRenderingContext2D, a: Handle, b: Handle, color: string, s: number, ox: number, oy: number) {
    ctx.beginPath();
    ctx.moveTo(a.x * s + ox, a.y * s + oy);
    ctx.lineTo(b.x * s + ox, b.y * s + oy);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Redraw whenever scale/offset changes
  useEffect(() => { draw(); }, [scale, offset, draw]);

  // ------------------------------------------------------------------
  // Mouse events
  // ------------------------------------------------------------------

  const toImageCoords = (clientX: number, clientY: number): Point => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const cx = clientX - rect.left;
    const cy = clientY - rect.top;
    const s = scaleRef.current;
    const { x: ox, y: oy } = offsetRef.current;
    return { x: (cx - ox) / s, y: (cy - oy) / s };
  };

  const hitTest = (clientX: number, clientY: number): Handle | null => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const cx = clientX - rect.left;
    const cy = clientY - rect.top;
    const s = scaleRef.current;
    const { x: ox, y: oy } = offsetRef.current;

    // Plan handles on top — check first; skip non-draggable landmark handles
    for (const h of [...planHandles.current, ...handles.current]) {
      if (h.draggable === false) continue;
      const sx = h.x * s + ox;
      const sy = h.y * s + oy;
      const dist = Math.hypot(cx - sx, cy - sy);
      if (dist <= h.radius + 4) return h;
    }
    return null;
  };

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;

    if (calibModeRef.current !== "none" && onCanvasClick) {
      const imgPt = toImageCoords(e.clientX, e.clientY);
      onCanvasClick(imgPt);
      return;
    }

    const ms = measureStepRef.current;
    if (ms !== "idle" && ms !== "done" && onCanvasClick) {
      const imgPt = toImageCoords(e.clientX, e.clientY);
      onCanvasClick(imgPt);
      return;
    }

    if (planningStepRef.current !== "idle" && onCanvasClick) {
      const imgPt = toImageCoords(e.clientX, e.clientY);
      onCanvasClick(imgPt);
      return;
    }

    if (activeToolRef.current !== "none" && onCanvasClick) {
      const imgPt = toImageCoords(e.clientX, e.clientY);
      onCanvasClick(imgPt);
      return;
    }

    if (slopeStepRef.current !== "idle" && slopeStepRef.current !== "done" && onCanvasClick) {
      const imgPt = toImageCoords(e.clientX, e.clientY);
      onCanvasClick(imgPt);
      return;
    }

    const _sagStep = sagittalStepRef.current;
    if ((_sagStep === "hinge" || _sagStep === "cut_p1" || _sagStep === "cut_p2") && onCanvasClick) {
      const imgPt = toImageCoords(e.clientX, e.clientY);
      onCanvasClick(imgPt);
      return;
    }

    const hit = hitTest(e.clientX, e.clientY);
    if (hit) {
      draggingHandle.current = hit;
    } else {
      isPanning.current = true;
      panStart.current = {
        mx: e.clientX, my: e.clientY,
        ox: offsetRef.current.x, oy: offsetRef.current.y,
      };
    }
  };

  const onMouseMove = (e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    if (draggingHandle.current) {
      const h = draggingHandle.current;
      const imgPt = toImageCoords(e.clientX, e.clientY);
      h.x = imgPt.x;
      h.y = imgPt.y;
      draw();
      return;
    }

    if (isPanning.current) {
      const dx = e.clientX - panStart.current.mx;
      const dy = e.clientY - panStart.current.my;
      setOffset({ x: panStart.current.ox + dx, y: panStart.current.oy + dy });
      return;
    }

    // During any planning step: track cursor for rubber-band + show crosshair
    if (planningStepRef.current !== "idle") {
      cursorRef.current = toImageCoords(e.clientX, e.clientY);
      canvas.style.cursor = "crosshair";
      draw();
      return;
    }

    const _sagCur = sagittalStepRef.current;

    // Rubber-band for sagittal cut line: track cursor and redraw during cut_p2
    if (_sagCur === "cut_p2") {
      cursorRef.current = toImageCoords(e.clientX, e.clientY);
      canvas.style.cursor = "crosshair";
      draw();
      return;
    }

    const isSagPlacing = _sagCur === "hinge" || _sagCur === "cut_p1";
    if (calibModeRef.current !== "none" ||
        (measureStepRef.current !== "idle" && measureStepRef.current !== "done") ||
        activeToolRef.current !== "none" ||
        (slopeStepRef.current !== "idle" && slopeStepRef.current !== "done") ||
        isSagPlacing) {
      canvas.style.cursor = "crosshair";
    } else {
      const hit = hitTest(e.clientX, e.clientY);
      canvas.style.cursor = hit ? "grab" : "default";
    }
  };

  const onMouseUp = (e: React.MouseEvent) => {
    if (draggingHandle.current) {
      const h = draggingHandle.current;
      const imgPt = toImageCoords(e.clientX, e.clientY);
      if (h.id.startsWith("plan_") && onPlanPointMove) {
        onPlanPointMove(h.target as "osteotomy_line_p1" | "osteotomy_line_p2" | "hinge_point" | "target_point", imgPt);
      } else {
        onLandmarkMove(h.target, imgPt, h.side as any);
      }
      draggingHandle.current = null;
    }
    isPanning.current = false;
    if (canvasRef.current && calibModeRef.current === "none") {
      canvasRef.current.style.cursor = "default";
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    const newScale = Math.min(Math.max(scaleRef.current * factor, 0.1), 20);
    const ratio = newScale / scaleRef.current;
    const newOx = cx - ratio * (cx - offsetRef.current.x);
    const newOy = cy - ratio * (cy - offsetRef.current.y);
    setScale(newScale);
    setOffset({ x: newOx, y: newOy });
  };

  return (
    <div ref={containerRef} className={styles.container}>
      {loading && <div className={styles.overlay}><div className={styles.spinner} /></div>}
      <canvas
        ref={canvasRef}
        className={styles.canvas}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={(e) => { cursorRef.current = null; onMouseUp(e); draw(); }}
        onWheel={onWheel}
      />
      <div className={styles.hint}>
        {calibMode !== "none"
          ? (calibMode === "p1" ? t("guided_hip_p1") : calibMode === "p2" ? t("guided_hip_p2") : t("guided_hip_p3"))
          : measureStep === "hip_1" ? t("guided_hip_p1")
          : measureStep === "hip_2" ? t("guided_hip_p2")
          : measureStep === "hip_3" ? t("guided_hip_p3")
          : measureStep === "femur_1" ? t("guided_knee_jl_p1")
          : measureStep === "femur_2" ? t("guided_knee_jl_p2")
          : measureStep === "femur_3" ? t("guided_knee_med_lat")
          : measureStep === "femur_4" ? t("guided_knee_med_lat")
          : measureStep === "tibia_1" ? t("guided_knee_jl_p1")
          : measureStep === "tibia_2" ? t("guided_knee_jl_p2")
          : measureStep === "tibia_3" ? t("guided_knee_med_lat")
          : measureStep === "tibia_4" ? t("guided_knee_med_lat")
          : measureStep === "ankle_1" ? t("guided_knee_jl_p1")
          : measureStep === "ankle_2" ? t("guided_knee_jl_p2")
          : measureStep === "ankle_3" ? t("guided_ankle_med")
          : measureStep === "ankle_4" ? t("guided_ankle_lat")
          : activeTool === "line" ? (pendingAnnotPts.length === 0 ? t("tool_hint_line_p1") : t("tool_hint_line_p2"))
          : activeTool === "angle" ? (pendingAnnotPts.length === 0 ? t("tool_hint_angle_p1") : pendingAnnotPts.length === 1 ? t("tool_hint_angle_p2") : t("tool_hint_angle_p3"))
          : activeTool === "text" ? t("tool_hint_text")
          : planningStep === "ost_p1" ? t("hint_ost_p1")
          : planningStep === "ost_p2" ? t("hint_ost_p2")
          : planningStep === "hinge" ? t("hint_hinge")
          : planningStep === "target" ? t("hint_target")
          : sagittalStep === "hinge"  ? t("hint_sag_hinge")
          : sagittalStep === "cut_p1" ? t("hint_sag_cut_p1")
          : sagittalStep === "cut_p2" ? t("hint_sag_cut_p2")
          : t("hint_default")}
      </div>
      <button className={`${styles.fitBtn} btn-ghost`} onClick={fitToContainer}>Fit</button>
    </div>
  );
});

export default DicomViewer;
