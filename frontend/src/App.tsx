import React, { useState, useCallback, useRef, useEffect } from "react";
import { uploadDicom, updateLandmarks, setSide, setConfig, exportUrl, calibrateImage, exportPdfFromCanvas } from "./api";
import type { Angles, DiaphysisLevel, ImageType, Landmarks, UploadResponse, Point, JointLine, Side, MeasureStep, AnnotationTool, Annotation } from "./types";
import UploadPanel from "./components/UploadPanel";
import DicomViewer, { type DicomViewerHandle } from "./components/DicomViewer";
import MeasurementPanel from "./components/MeasurementPanel";
import GuidedLandmarkPanel from "./components/GuidedLandmarkPanel";
import AnnotationToolsPanel from "./components/AnnotationToolsPanel";
import SideToggle from "./components/SideToggle";
import CalibrationPanel from "./components/CalibrationPanel";
import type { CalibMode, CalibType } from "./components/CalibrationPanel";
import { circumscribedCircle } from "./components/CalibrationPanel";
import PlanningPanel from "./components/PlanningPanel";
import type { OsteotomyKind, OsteotomyPlan, PlanningStep, ConfirmedOsteotomy } from "./osteotomy/types";
import { initPlan, updatePlan, deletePlan } from "./osteotomy/api";
import { applyOsteotomyTransform } from "./osteotomy/engine";
import SlopePanel from "./components/SlopePanel";
import SlopeCorrectionPanel from "./components/SlopeCorrectionPanel";
import type { SlopeStep, SlopePoints, SagittalStep, SagittalOsteotomy, ConfirmedSagittalOst } from "./slope/types";
import { EMPTY_SLOPE_POINTS, EMPTY_SAGITTAL } from "./slope/types";
import { computeSlope } from "./slope/calculation";
import { computeSagittalCorrection } from "./slope/sagittal_engine";
import type { SagittalResult } from "./slope/sagittal_engine";
import styles from "./styles/App.module.css";
import { useTranslation } from "./i18n/LanguageContext";
import type { Lang } from "./i18n/translations";
import { useAuth } from "./hooks/useAuth";
import LoginPage from "./pages/LoginPage";
import SignupPage from "./pages/SignupPage";
import PricingPage from "./pages/PricingPage";
import PaywallPage from "./pages/PaywallPage";
import ResetPasswordPage from "./pages/ResetPasswordPage";

interface HistorySnapshot {
  landmarks: Landmarks | null;
  angles: Angles | null;
  imageB64: string;
  osteotomyPlan: OsteotomyPlan | null;
  planningStep: PlanningStep;
  pendingOstP1: Point | null;
  annotations: Annotation[];
  confirmedOsteotomies: ConfirmedOsteotomy[];
  baseLandmarks: Landmarks | null;
  /** Backend-annotated image captured before the first osteotomy was confirmed. */
  baseAnnotatedImageB64: string;
  /** Angle measurements captured before the first osteotomy was confirmed. */
  baseAngles: Angles | null;
  confirmedSagittalOsts: ConfirmedSagittalOst[];
  sagittalStep: SagittalStep;
  sagittalOst: SagittalOsteotomy;
}

/** Apply all confirmed osteotomies in order to base landmarks. Pure — no side effects. */
function reapplyAllOsteotomies(base: Landmarks, osteotomies: ConfirmedOsteotomy[]): Landmarks {
  let lm = base;
  for (const co of osteotomies) {
    lm = applyOsteotomyTransform(lm, co.plan);
  }
  return lm;
}

/** Build a backend patch object from a Landmarks snapshot. */
function landmarksPatch(lm: Landmarks): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (lm.hip_center)                      patch.hip_center            = lm.hip_center;
  if (lm.knee_center)                     patch.knee_center           = lm.knee_center;
  if (lm.ankle_center)                    patch.ankle_center          = lm.ankle_center;
  if (lm.distal_femoral_line)             patch.distal_femoral_line   = lm.distal_femoral_line;
  if (lm.proximal_tibial_line)            patch.proximal_tibial_line  = lm.proximal_tibial_line;
  if (lm.femur_diaphysis_levels?.length)  patch.femur_diaphysis_levels = lm.femur_diaphysis_levels;
  if (lm.tibia_diaphysis_levels?.length)  patch.tibia_diaphysis_levels = lm.tibia_diaphysis_levels;
  return patch;
}

const LOADING_SCREEN = (
  <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#0d1117" }}>
    <span style={{ color: "#8b949e", fontSize: 14 }}>Loading…</span>
  </div>
);

/** Inner app — only rendered when auth + subscription are confirmed active. */
function AppContent({ auth }: { auth: ReturnType<typeof useAuth> }) {
  const { t, lang, setLang } = useTranslation();

  // ── Image type selection ────────────────────────────────────────────────
  const [imageType, setImageType] = useState<ImageType>("long_leg_ap");

  const [session, setSession] = useState<UploadResponse | null>(null);
  const [imageB64, setImageB64] = useState<string>("");
  // Raw (unannotated) DICOM pixels — set once at upload, never overwritten.
  // Used as the simulation base so bone-fragment rotation doesn't inherit
  // any axis lines previously drawn by the backend renderer.
  const [rawImageB64, setRawImageB64] = useState<string>("");
  const [landmarks, setLandmarks] = useState<Landmarks | null>(null);
  const [angles, setAngles] = useState<Angles | null>(null);
  const [side, setSideState] = useState<Side>("unknown");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>("");
  const [showAnatomical, setShowAnatomical] = useState(false);

  // ── Tibial slope measurement (knee_lateral mode, Dejour & Bonnin) ─────────
  const [slopeStep, setSlopeStep] = useState<SlopeStep>("idle");
  const [slopePts, setSlopePts] = useState<SlopePoints>(EMPTY_SLOPE_POINTS);
  const [slopeValue, setSlopeValue] = useState<number | null>(null);

  // ── Sagittal osteotomy simulation ────────────────────────────────────────
  const [sagittalStep, setSagittalStep] = useState<SagittalStep>("idle");
  const [sagittalOst, setSagittalOst] = useState<SagittalOsteotomy>(EMPTY_SAGITTAL);
  const [sagittalResult, setSagittalResult] = useState<SagittalResult | null>(null);
  const [confirmedSagittalOsts, setConfirmedSagittalOsts] = useState<ConfirmedSagittalOst[]>([]);

  // Osteotomy planning state
  const [osteotomyPlan, setOsteotomyPlan] = useState<OsteotomyPlan | null>(null);
  const [planningStep, setPlanningStep] = useState<PlanningStep>("idle");
  const [pendingOstP1, setPendingOstP1] = useState<Point | null>(null);
  const [confirmedOsteotomies, setConfirmedOsteotomies] = useState<ConfirmedOsteotomy[]>([]);
  // Landmarks frozen at the moment of the first osteotomy confirmation.
  // All confirmed transforms are replayed on this baseline so deleting one
  // osteotomy restores the correct geometry without accumulation errors.
  const [baseLandmarks, setBaseLandmarks] = useState<Landmarks | null>(null);
  const _baseLandmarks = useRef<Landmarks | null>(null);
  _baseLandmarks.current = baseLandmarks;
  // Backend-annotated image captured before the first osteotomy is confirmed.
  // Used as the "Ausgangsbefund" (original anatomy) in the export center column.
  const [baseAnnotatedImageB64, setBaseAnnotatedImageB64] = useState<string>("");
  const _baseAnnotatedImageB64 = useRef<string>("");
  _baseAnnotatedImageB64.current = baseAnnotatedImageB64;
  // Angle measurements frozen before the first osteotomy was confirmed.
  // Used as the "Ausgangsbefund" pre-op column in the structured export comparison table.
  const [baseAngles, setBaseAngles] = useState<Angles | null>(null);
  const _baseAngles = useRef<Angles | null>(null);
  _baseAngles.current = baseAngles;
  // Snapshot of angles/image BEFORE the plan was activated — restored on reset
  const baselineAnglesRef = useRef<Angles | null>(null);
  const baselineImageRef  = useRef<string>("");

  // Ref to the live canvas — used by canvas-based export
  const viewerRef = useRef<DicomViewerHandle>(null);

  // Undo / redo history
  const historyPast   = useRef<HistorySnapshot[]>([]);
  const historyFuture = useRef<HistorySnapshot[]>([]);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  // Current-value refs — kept in sync with state for use inside callbacks
  const _landmarks     = useRef<Landmarks | null>(null);
  const _angles        = useRef<Angles | null>(null);
  const _imageB64      = useRef<string>("");
  const _ostPlan       = useRef<OsteotomyPlan | null>(null);
  const _planningStep  = useRef<PlanningStep>("idle");
  const _pendingOstP1  = useRef<Point | null>(null);
  const _annotations        = useRef<Annotation[]>([]);
  const _confirmedOsts      = useRef<ConfirmedOsteotomy[]>([]);
  const _confirmedSagOsts   = useRef<ConfirmedSagittalOst[]>([]);
  const _sagittalStepRef    = useRef<SagittalStep>("idle");
  const _sagittalOstRef     = useRef<SagittalOsteotomy>(EMPTY_SAGITTAL);
  _landmarks.current    = landmarks;
  _angles.current       = angles;
  _imageB64.current     = imageB64;
  _ostPlan.current      = osteotomyPlan;
  _planningStep.current = planningStep;
  _pendingOstP1.current = pendingOstP1;
  // _annotations synced below, after annotations state is declared

  // Guided landmark measurement state
  const [measureStep, setMeasureStep] = useState<MeasureStep>("idle");

  // Mobile panel visibility
  const [leftPanelOpen, setLeftPanelOpen] = useState(false);
  const [rightPanelOpen, setRightPanelOpen] = useState(false);

  const [hipMeasPts, setHipMeasPts] = useState<Point[]>([]);
  const [femurMeasPts, setFemurMeasPts] = useState<Point[]>([]);
  const [tibiaMeasPts, setTibiaMeasPts] = useState<Point[]>([]);
  const [ankleMeasPts, setAnkleMeasPts] = useState<Point[]>([]);

  // Annotation tool state
  const [activeTool, setActiveTool] = useState<AnnotationTool>("none");
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [pendingAnnotPts, setPendingAnnotPts] = useState<Point[]>([]);
  _annotations.current = annotations;
  _confirmedOsts.current    = confirmedOsteotomies;
  _confirmedSagOsts.current = confirmedSagittalOsts;
  _sagittalStepRef.current  = sagittalStep;
  _sagittalOstRef.current   = sagittalOst;

  // Calibration state
  const [calibMode, setCalibMode] = useState<CalibMode>("none");
  const [calibType, setCalibType] = useState<CalibType>("line");
  const [calibPoints, setCalibPoints] = useState<{ p1?: Point; p2?: Point; p3?: Point }>({});
  const [calibSpacingMm, setCalibSpacingMm] = useState<number | null>(null);

  const handleUpload = useCallback(async (file: File) => {
    setLoading(true);
    setError("");
    try {
      const resp = await uploadDicom(file, side);
      setSession(resp);
      setImageB64(resp.image_b64);
      setRawImageB64(resp.raw_image_b64);
      setLandmarks(resp.landmarks);
      setAngles(resp.angles);
      setCalibSpacingMm(null);
      setCalibPoints({});
      setOsteotomyPlan(null);
      setPlanningStep("idle");
      setPendingOstP1(null);
      setConfirmedOsteotomies([]);
      setBaseLandmarks(null);
      setBaseAnnotatedImageB64("");
      setBaseAngles(null);
      setSlopeStep("idle");
      setSlopePts(EMPTY_SLOPE_POINTS);
      setSlopeValue(null);
      historyPast.current = [];
      historyFuture.current = [];
      setCanUndo(false);
      setCanRedo(false);
      baselineAnglesRef.current = null;
      baselineImageRef.current  = "";
      setMeasureStep("idle");
      setHipMeasPts([]);
      setFemurMeasPts([]);
      setTibiaMeasPts([]);
      setAnkleMeasPts([]);
      setAnnotations([]);
      setActiveTool("none");
      setPendingAnnotPts([]);
      // Immediately enter calibration for AP mode — measurements require it.
      // In lateral mode calibration is optional (slope is pixel-based).
      if (imageType !== "knee_lateral") {
        setCalibMode("p1");
      }
    } catch (e: any) {
      setError(e.response?.data?.detail ?? e.message ?? "Upload failed");
    } finally {
      setLoading(false);
    }
  }, [side]);

  const handleSideChange = useCallback(async (newSide: Side) => {
    setSideState(newSide);
    if (!session) return;
    setLoading(true);
    try {
      const resp = await setSide(session.session_id, newSide);
      setImageB64(resp.image_b64);
      setAngles(resp.angles);
    } catch (e: any) {
      setError(e.response?.data?.detail ?? e.message ?? "Side update failed");
    } finally {
      setLoading(false);
    }
    // Start guided measurement workflow when side is selected for the first time
    // Only for long_leg_ap — slope (knee_lateral) does not need these landmarks
    if (measureStep === "idle" && calibSpacingMm !== null && imageType === "long_leg_ap") {
      setMeasureStep("hip_1");
    }
  }, [session, measureStep, calibSpacingMm, imageType]);

  const handleToggleAnatomical = useCallback(async () => {
    if (!session) {
      setShowAnatomical(v => !v);
      return;
    }
    const next = !showAnatomical;
    setShowAnatomical(next);
    setLoading(true);
    try {
      const resp = await setConfig(session.session_id, { show_anatomical: next });
      setImageB64(resp.image_b64);
    } catch (e: any) {
      setError(e.response?.data?.detail ?? e.message ?? "Config update failed");
    } finally {
      setLoading(false);
    }
  }, [session, showAnatomical]);

  // ------------------------------------------------------------------
  // Undo / Redo
  // ------------------------------------------------------------------

  const captureSnapshot = useCallback((): HistorySnapshot => ({
    landmarks:    _landmarks.current,
    angles:       _angles.current,
    imageB64:     _imageB64.current,
    osteotomyPlan: _ostPlan.current,
    planningStep: _planningStep.current,
    pendingOstP1: _pendingOstP1.current,
    annotations:  [..._annotations.current],
    confirmedOsteotomies: [..._confirmedOsts.current],
    baseLandmarks: _baseLandmarks.current,
    baseAnnotatedImageB64: _baseAnnotatedImageB64.current,
    baseAngles:            _baseAngles.current,
    confirmedSagittalOsts: [..._confirmedSagOsts.current],
    sagittalStep:          _sagittalStepRef.current,
    sagittalOst:           { ..._sagittalOstRef.current },
  }), []);

  const pushHistory = useCallback(() => {
    historyPast.current = [...historyPast.current, captureSnapshot()].slice(-50);
    historyFuture.current = [];
    setCanUndo(true);
    setCanRedo(false);
  }, [captureSnapshot]);

  /** Restore snapshot to frontend immediately + sync backend fire-and-forget */
  const applySnapshot = useCallback((snap: HistorySnapshot) => {
    setLandmarks(snap.landmarks);
    setAngles(snap.angles);
    setImageB64(snap.imageB64);
    setOsteotomyPlan(snap.osteotomyPlan);
    setPlanningStep(snap.planningStep);
    setPendingOstP1(snap.pendingOstP1);
    setAnnotations(snap.annotations);
    setConfirmedOsteotomies(snap.confirmedOsteotomies);
    setBaseLandmarks(snap.baseLandmarks);
    setBaseAnnotatedImageB64(snap.baseAnnotatedImageB64);
    setBaseAngles(snap.baseAngles);
    setConfirmedSagittalOsts(snap.confirmedSagittalOsts);
    setSagittalStep(snap.sagittalStep);
    setSagittalOst(snap.sagittalOst);
    setSagittalResult(null);

    if (!session) return;
    // Sync landmark state on backend (so next move uses correct base)
    if (snap.landmarks) {
      const lm = snap.landmarks;
      const patch: Record<string, any> = {};
      if (lm.hip_center)            patch.hip_center            = lm.hip_center;
      if (lm.knee_center)           patch.knee_center           = lm.knee_center;
      if (lm.ankle_center)          patch.ankle_center          = lm.ankle_center;
      if (lm.distal_femoral_line)   patch.distal_femoral_line   = lm.distal_femoral_line;
      if (lm.proximal_tibial_line)  patch.proximal_tibial_line  = lm.proximal_tibial_line;
      if (lm.femur_diaphysis_levels) patch.femur_diaphysis_levels = lm.femur_diaphysis_levels;
      if (lm.tibia_diaphysis_levels) patch.tibia_diaphysis_levels = lm.tibia_diaphysis_levels;
      updateLandmarks(session.session_id, patch).catch(() => {});
    }
    // Sync plan state on backend
    if (snap.osteotomyPlan) {
      updatePlan(session.session_id, {
        osteotomy_line: snap.osteotomyPlan.osteotomy_line ?? undefined,
        hinge_point:   snap.osteotomyPlan.hinge_point    ?? undefined,
        target_point:  snap.osteotomyPlan.target_point   ?? undefined,
        correction_deg: snap.osteotomyPlan.correction_deg,
      }).catch(() => {});
    } else {
      deletePlan(session.session_id).catch(() => {});
    }
  }, [session]);

  const handleUndo = useCallback(() => {
    if (historyPast.current.length === 0) return;
    const curr = captureSnapshot();
    historyFuture.current = [curr, ...historyFuture.current].slice(0, 50);
    const prev = historyPast.current[historyPast.current.length - 1];
    historyPast.current = historyPast.current.slice(0, -1);
    setCanUndo(historyPast.current.length > 0);
    setCanRedo(true);
    applySnapshot(prev);
  }, [captureSnapshot, applySnapshot]);

  const handleRedo = useCallback(() => {
    if (historyFuture.current.length === 0) return;
    const curr = captureSnapshot();
    historyPast.current = [...historyPast.current, curr].slice(-50);
    const next = historyFuture.current[0];
    historyFuture.current = historyFuture.current.slice(1);
    setCanUndo(true);
    setCanRedo(historyFuture.current.length > 0);
    applySnapshot(next);
  }, [captureSnapshot, applySnapshot]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ctrlOrCmd = navigator.platform.includes("Mac") ? e.metaKey : e.ctrlKey;
      if (!ctrlOrCmd) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "z" && !e.shiftKey) { e.preventDefault(); handleUndo(); }
      else if (e.key === "z" && e.shiftKey) { e.preventDefault(); handleRedo(); }
      else if (e.key === "y") { e.preventDefault(); handleRedo(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleUndo, handleRedo]);

  // ------------------------------------------------------------------

  const handleLandmarkMove = useCallback(
    async (target: string, newPoint: Point, lineSide?: "medial" | "lateral") => {
      if (!session || !landmarks) return;
      pushHistory();
      setLoading(true);

      const patch: Record<string, any> = {};
      if (target === "hip_center" || target === "knee_center" || target === "ankle_center") {
        patch[target] = newPoint;
      } else if (target === "distal_femoral_line" && lineSide && landmarks.distal_femoral_line) {
        const updated: JointLine = { ...landmarks.distal_femoral_line };
        updated[lineSide] = newPoint;
        patch.distal_femoral_line = updated;
      } else if (target === "proximal_tibial_line" && lineSide && landmarks.proximal_tibial_line) {
        const updated: JointLine = { ...landmarks.proximal_tibial_line };
        updated[lineSide] = newPoint;
        patch.proximal_tibial_line = updated;
      } else if (target.match(/^femur_diaphysis_(\d+)_(medial|lateral)$/)) {
        const parts = target.split("_");
        const idx = parseInt(parts[2]);
        const side = parts[3] as "medial" | "lateral";
        const updated: DiaphysisLevel[] = [...(landmarks.femur_diaphysis_levels ?? [])];
        updated[idx] = { ...updated[idx], [side]: newPoint };
        patch.femur_diaphysis_levels = updated;
      } else if (target.match(/^tibia_diaphysis_(\d+)_(medial|lateral)$/)) {
        const parts = target.split("_");
        const idx = parseInt(parts[2]);
        const side = parts[3] as "medial" | "lateral";
        const updated: DiaphysisLevel[] = [...(landmarks.tibia_diaphysis_levels ?? [])];
        updated[idx] = { ...updated[idx], [side]: newPoint };
        patch.tibia_diaphysis_levels = updated;
      }

      try {
        const resp = await updateLandmarks(session.session_id, patch);
        setImageB64(resp.image_b64);
        setLandmarks(resp.landmarks);
        setAngles(resp.angles);
      } catch (e: any) {
        setError(e.response?.data?.detail ?? e.message ?? "Update failed");
      } finally {
        setLoading(false);
      }
    },
    [session, landmarks, pushHistory]
  );

  /** Project point p onto the infinite line through a and b. */
  function projectOnLine(p: Point, a: Point, b: Point): Point {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-9) return { ...a };
    const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
    return { x: a.x + t * dx, y: a.y + t * dy };
  }

  // ── Slope measurement click handler (Dejour & Bonnin, 6 clicks) ──────────
  const handleSlopeClick = useCallback((pt: Point) => {
    setSlopePts(prev => {
      const next = { ...prev };
      let nextStep: SlopeStep = "idle";

      if      (slopeStep === "plateau_1")    { next.plateauP1   = pt; nextStep = "plateau_2";    }
      else if (slopeStep === "plateau_2")    { next.plateauP2   = pt; nextStep = "cortex1_ant";  }
      else if (slopeStep === "cortex1_ant")  { next.cortex1Ant  = pt; nextStep = "cortex1_post"; }
      else if (slopeStep === "cortex1_post") { next.cortex1Post = pt; nextStep = "cortex2_ant";  }
      else if (slopeStep === "cortex2_ant")  { next.cortex2Ant  = pt; nextStep = "cortex2_post"; }
      else if (slopeStep === "cortex2_post") {
        next.cortex2Post = pt;
        nextStep = "done";
        setSlopeValue(computeSlope(next));
      }

      setSlopeStep(nextStep);
      return next;
    });
  }, [slopeStep]);

  const handleSlopeStart = useCallback(() => { setSlopeStep("plateau_1"); }, []);

  const handleSagittalReset = useCallback(() => {
    setSagittalStep("idle");
    setSagittalOst(EMPTY_SAGITTAL);
    setSagittalResult(null);
  }, []);

  const handleConfirmSagittal = useCallback(() => {
    if (!sagittalResult || sagittalOst.correctionDeg === 0) return;
    if (!sagittalOst.cutP1 || !sagittalOst.cutP2 || !sagittalOst.hingePoint) return;

    pushHistory();

    const confirmed: ConfirmedSagittalOst = {
      id: `sag_${Date.now()}`,
      ost: { ...sagittalOst },
      slopeBefore: slopeValue ?? 0,
      slopeAfter: sagittalResult.correctedSlope,
      correctedP1: sagittalResult.correctedP1,
      correctedP2: sagittalResult.correctedP2,
    };

    setConfirmedSagittalOsts(prev => [...prev, confirmed]);
    // Reset active simulation so the next osteotomy can be planned on top
    setSagittalStep("idle");
    setSagittalOst(EMPTY_SAGITTAL);
    setSagittalResult(null);
  }, [sagittalOst, sagittalResult, slopeValue, pushHistory]);

  const handleSlopeReset = useCallback(() => {
    setSlopeStep("idle");
    setSlopePts(EMPTY_SLOPE_POINTS);
    setSlopeValue(null);
    // Sagittal correction depends on slope points — reset it too
    setSagittalStep("idle");
    setSagittalOst(EMPTY_SAGITTAL);
    setSagittalResult(null);
    setConfirmedSagittalOsts([]);
  }, []);

  const handleSagittalClick = useCallback((pt: Point) => {
    setSagittalOst(prev => {
      const next = { ...prev };
      let nextStep: SagittalStep = sagittalStep;
      if (sagittalStep === "cut_p1") {
        next.cutP1 = pt;
        nextStep = "cut_p2";
      } else if (sagittalStep === "cut_p2") {
        next.cutP2 = pt;
        nextStep = "hinge";
      } else if (sagittalStep === "hinge") {
        next.hingePoint = pt;
        nextStep = "active";
      }
      setSagittalStep(nextStep);
      return next;
    });
  }, [sagittalStep]);

  // Recompute sagittal result whenever the osteotomy geometry or correction changes
  useEffect(() => {
    if (sagittalStep === "active" && sagittalOst.hingePoint && slopePts.plateauP1 && slopePts.plateauP2) {
      const r = computeSagittalCorrection(slopePts, sagittalOst.hingePoint, sagittalOst.correctionDeg);
      setSagittalResult(r);
    } else {
      setSagittalResult(null);
    }
  }, [sagittalStep, sagittalOst, slopePts]);

  // Clear mode-specific state when the image type changes to prevent
  // long-leg measurement coordinates from appearing on a lateral image and vice versa.
  useEffect(() => {
    if (imageType === "knee_lateral") {
      setLandmarks(null);
      setAngles(null);
      setMeasureStep("idle");
    } else {
      setSlopeStep("idle");
      setSlopePts(EMPTY_SLOPE_POINTS);
      setSlopeValue(null);
      setSagittalStep("idle");
      setSagittalOst(EMPTY_SAGITTAL);
      setSagittalResult(null);
      setConfirmedSagittalOsts([]);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageType]);

  const handleCanvasClick = useCallback(async (pt: Point) => {
    // Slope measurement mode takes priority
    if (imageType === "knee_lateral" && slopeStep !== "idle" && slopeStep !== "done") {
      handleSlopeClick(pt);
      return;
    }

    // Sagittal osteotomy placement
    if (imageType === "knee_lateral" && (sagittalStep === "hinge" || sagittalStep === "cut_p1" || sagittalStep === "cut_p2")) {
      handleSagittalClick(pt);
      return;
    }

    // Guided landmark placement FSM
    if (measureStep !== "idle" && measureStep !== "done") {
      if (measureStep === "hip_1") {
        setHipMeasPts([pt]);
        setMeasureStep("hip_2");
        return;
      }
      if (measureStep === "hip_2") {
        setHipMeasPts(prev => [...prev, pt]);
        setMeasureStep("hip_3");
        return;
      }
      if (measureStep === "hip_3") {
        const pts = [...hipMeasPts, pt];
        const circ = circumscribedCircle(pts[0], pts[1], pts[2]);
        if (!circ) {
          setError(t("error_hip_collinear"));
          setMeasureStep("hip_1");
          setHipMeasPts([]);
          return;
        }
        await handleLandmarkMove("hip_center", { x: circ.cx, y: circ.cy });
        setHipMeasPts([]);
        setMeasureStep("femur_1");
        return;
      }
      // ── Femur base (4 points → DFL + knee center) ───────────────────────
      if (measureStep === "femur_1") { setFemurMeasPts([pt]); setMeasureStep("femur_2"); return; }
      if (measureStep === "femur_2") { setFemurMeasPts(prev => [...prev, pt]); setMeasureStep("femur_3"); return; }
      if (measureStep === "femur_3") { setFemurMeasPts(prev => [...prev, pt]); setMeasureStep("femur_4"); return; }
      if (measureStep === "femur_4") {
        const fPts = [...femurMeasPts, pt];
        const [fp1, fp2, fp3, fp4] = fPts;
        const proj3 = projectOnLine(fp3, fp1, fp2);
        const proj4 = projectOnLine(fp4, fp1, fp2);
        const dfl: JointLine = proj3.x <= proj4.x
          ? { medial: proj3, lateral: proj4 }
          : { medial: proj4, lateral: proj3 };
        const kneeCenter: Point = {
          x: (dfl.medial.x + dfl.lateral.x) / 2,
          y: (dfl.medial.y + dfl.lateral.y) / 2,
        };
        pushHistory();
        setLoading(true);
        try {
          const resp = await updateLandmarks(session!.session_id, {
            distal_femoral_line: dfl,
            knee_center: kneeCenter,
          });
          setImageB64(resp.image_b64);
          setLandmarks(resp.landmarks);
          setAngles(resp.angles);
          setFemurMeasPts([]);
          setMeasureStep("tibia_1");
        } catch (e: any) {
          setError(e.response?.data?.detail ?? e.message ?? "Update failed");
        } finally {
          setLoading(false);
        }
        return;
      }
      // ── Tibia base (4 points → PTL) ──────────────────────────────────────
      if (measureStep === "tibia_1") { setTibiaMeasPts([pt]); setMeasureStep("tibia_2"); return; }
      if (measureStep === "tibia_2") { setTibiaMeasPts(prev => [...prev, pt]); setMeasureStep("tibia_3"); return; }
      if (measureStep === "tibia_3") { setTibiaMeasPts(prev => [...prev, pt]); setMeasureStep("tibia_4"); return; }
      if (measureStep === "tibia_4") {
        const tPts = [...tibiaMeasPts, pt];
        const [tp1, tp2, tp3, tp4] = tPts;
        const proj3 = projectOnLine(tp3, tp1, tp2);
        const proj4 = projectOnLine(tp4, tp1, tp2);
        const ptl: JointLine = proj3.x <= proj4.x
          ? { medial: proj3, lateral: proj4 }
          : { medial: proj4, lateral: proj3 };
        pushHistory();
        setLoading(true);
        try {
          const resp = await updateLandmarks(session!.session_id, {
            proximal_tibial_line: ptl,
          });
          setImageB64(resp.image_b64);
          setLandmarks(resp.landmarks);
          setAngles(resp.angles);
          setTibiaMeasPts([]);
          setMeasureStep("ankle_1");
        } catch (e: any) {
          setError(e.response?.data?.detail ?? e.message ?? "Update failed");
        } finally {
          setLoading(false);
        }
        return;
      }
      // ── Ankle (4 points → DTL + ankle center) ────────────────────────────
      if (measureStep === "ankle_1") { setAnkleMeasPts([pt]); setMeasureStep("ankle_2"); return; }
      if (measureStep === "ankle_2") { setAnkleMeasPts(prev => [...prev, pt]); setMeasureStep("ankle_3"); return; }
      if (measureStep === "ankle_3") { setAnkleMeasPts(prev => [...prev, pt]); setMeasureStep("ankle_4"); return; }
      if (measureStep === "ankle_4") {
        const aPts = [...ankleMeasPts, pt];
        const [ap1, ap2, ap3, ap4] = aPts;
        const proj3 = projectOnLine(ap3, ap1, ap2);
        const proj4 = projectOnLine(ap4, ap1, ap2);
        const dtl: JointLine = proj3.x <= proj4.x
          ? { medial: proj3, lateral: proj4 }
          : { medial: proj4, lateral: proj3 };
        pushHistory();
        setLoading(true);
        try {
          const resp = await updateLandmarks(session!.session_id, {
            distal_tibial_line: dtl,
          });
          setImageB64(resp.image_b64);
          setLandmarks(resp.landmarks);
          setAngles(resp.angles);
          setAnkleMeasPts([]);
          setMeasureStep("done");
        } catch (e: any) {
          setError(e.response?.data?.detail ?? e.message ?? "Update failed");
        } finally {
          setLoading(false);
        }
        return;
      }
      return;
    }

    if (calibMode === "p1") {
      setCalibPoints({ p1: pt });
      setCalibMode("p2");
      return;
    }
    if (calibMode === "p2") {
      setCalibPoints(prev => ({ ...prev, p2: pt }));
      if (calibType === "sphere") {
        setCalibMode("p3");
      }
      return;
    }
    if (calibMode === "p3") {
      setCalibPoints(prev => ({ ...prev, p3: pt }));
      return;
    }

    // Annotation tools FSM
    if (activeTool !== "none") {
      if (activeTool === "line") {
        if (pendingAnnotPts.length === 0) {
          setPendingAnnotPts([pt]);
        } else {
          pushHistory();
          setAnnotations(prev => [...prev, {
            id: `line_${Date.now()}`, type: "line" as const,
            p1: pendingAnnotPts[0], p2: pt,
          }]);
          setPendingAnnotPts([]);
        }
        return;
      }
      if (activeTool === "angle") {
        if (pendingAnnotPts.length < 2) {
          setPendingAnnotPts(prev => [...prev, pt]);
        } else {
          pushHistory();
          setAnnotations(prev => [...prev, {
            id: `angle_${Date.now()}`, type: "angle" as const,
            p1: pendingAnnotPts[0], vertex: pendingAnnotPts[1], p2: pt,
          }]);
          setPendingAnnotPts([]);
        }
        return;
      }
      if (activeTool === "text") {
        const text = window.prompt(t("text_annotation_prompt"), "Text");
        if (text) {
          pushHistory();
          setAnnotations(prev => [...prev, {
            id: `text_${Date.now()}`, type: "text" as const,
            pos: pt, text,
          }]);
        }
        setPendingAnnotPts([]);
        return;
      }
      return;
    }

    if (planningStep === "ost_p1") {
      pushHistory();
      setPendingOstP1(pt);
      setPlanningStep("ost_p2");
      return;
    }
    if (planningStep === "ost_p2" && session && pendingOstP1) {
      pushHistory();
      const p1 = pendingOstP1;
      setPendingOstP1(null);
      setLoading(true);
      try {
        const resp = await updatePlan(session.session_id, { osteotomy_line: { p1, p2: pt } });
        setOsteotomyPlan(resp);
        setAngles(resp.post_angles);
        setPlanningStep("hinge");
      } catch (e: any) {
        setError(e.response?.data?.detail ?? e.message ?? "Update failed");
        setPlanningStep("idle");
      } finally {
        setLoading(false);
      }
      return;
    }
    if (planningStep === "hinge" && session) {
      pushHistory();
      setLoading(true);
      try {
        const resp = await updatePlan(session.session_id, { hinge_point: pt });
        setOsteotomyPlan(resp);
        setAngles(resp.post_angles);
        setPlanningStep("target");
      } catch (e: any) {
        setError(e.response?.data?.detail ?? e.message ?? "Update failed");
        setPlanningStep("idle");
      } finally {
        setLoading(false);
      }
      return;
    }
    if (planningStep === "target" && session) {
      pushHistory();
      setLoading(true);
      try {
        const resp = await updatePlan(session.session_id, { target_point: pt });
        setOsteotomyPlan(resp);
        setAngles(resp.post_angles);
        setPlanningStep("idle");
      } catch (e: any) {
        setError(e.response?.data?.detail ?? e.message ?? "Update failed");
        setPlanningStep("idle");
      } finally {
        setLoading(false);
      }
      return;
    }
  }, [imageType, slopeStep, handleSlopeClick, sagittalStep, handleSagittalClick, measureStep, hipMeasPts, femurMeasPts, tibiaMeasPts, ankleMeasPts, activeTool, pendingAnnotPts, calibMode, calibType, planningStep, pendingOstP1, session, handleLandmarkMove, pushHistory]);

  const handleStartCalib = useCallback(() => {
    setCalibMode("p1");
    setCalibPoints({});
  }, []);

  const handleTypeChange = useCallback((type: CalibType) => {
    setCalibType(type);
    setCalibPoints({});
    if (calibMode !== "none") setCalibMode("p1");
  }, [calibMode]);

  const handleApplyCalib = useCallback(async (knownMm: number) => {
    if (!session) return;
    setLoading(true);
    try {
      let p1Arg: Point;
      let p2Arg: Point;

      if (calibType === "sphere") {
        if (!calibPoints.p1 || !calibPoints.p2 || !calibPoints.p3) return;
        const circ = circumscribedCircle(calibPoints.p1, calibPoints.p2, calibPoints.p3);
        if (!circ) { setError(t("error_sphere_collinear")); return; }
        // Virtual diameter endpoints for the backend (distance = 2r = diameter in pixels)
        p1Arg = { x: circ.cx - circ.r, y: circ.cy };
        p2Arg = { x: circ.cx + circ.r, y: circ.cy };
      } else {
        if (!calibPoints.p1 || !calibPoints.p2) return;
        p1Arg = calibPoints.p1;
        p2Arg = calibPoints.p2;
      }

      const result = await calibrateImage(session.session_id, p1Arg, p2Arg, knownMm);
      setCalibSpacingMm(result.pixel_spacing_mm);
      setCalibMode("none");
      setCalibPoints({});
      if (side !== "unknown" && measureStep === "idle" && imageType === "long_leg_ap") {
        setMeasureStep("hip_1");
      }
    } catch (e: any) {
      setError(e.response?.data?.detail ?? e.message ?? t("error_calib_failed"));
    } finally {
      setLoading(false);
    }
  }, [session, calibType, calibPoints, side, measureStep]);


  const handleResetCalib = useCallback(() => {
    setCalibMode("none");
    setCalibPoints({});
    // Note: does NOT reset pixel_spacing_override on backend (would need a separate call)
    // Just hides the UI state. For full reset, user would need to re-upload.
  }, []);

  const handleResetSection = useCallback((to: MeasureStep) => {
    setMeasureStep(to);
    if (to === "hip_1") {
      setHipMeasPts([]);
    } else if (to === "femur_1") {
      setFemurMeasPts([]);
    } else if (to === "tibia_1") {
      setTibiaMeasPts([]);
    } else if (to === "ankle_1") {
      setAnkleMeasPts([]);
    }
  }, []);

  const handleDeleteAnnotation = useCallback((id: string) => {
    setAnnotations(prev => prev.filter(a => a.id !== id));
  }, []);

  const handleClearAnnotations = useCallback(() => {
    setAnnotations([]);
    setPendingAnnotPts([]);
  }, []);

  const handleToolChange = useCallback((tool: AnnotationTool) => {
    setActiveTool(tool);
    setPendingAnnotPts([]);
  }, []);

  // ------------------------------------------------------------------
  // Osteotomy planning handlers
  // ------------------------------------------------------------------

  const handleInitPlan = useCallback(async (kind: OsteotomyKind) => {
    if (!session) return;
    setLoading(true);
    try {
      // Save baseline before any plan modifies the displayed angles
      if (!baselineAnglesRef.current) {
        baselineAnglesRef.current = angles;
        baselineImageRef.current  = imageB64;
      }
      // auto_place=false: creates plan with kind only, no geometry, correction_deg=0.
      // Simulation only starts after the user manually places cut line + hinge and
      // moves the slider (or clicks "Anwenden").
      const resp = await initPlan(session.session_id, kind, false);
      setOsteotomyPlan(resp);
      // angles stay as baseline — no simulation yet
      setPlanningStep("ost_p1");   // guide user straight to cut-line placement
      setPendingOstP1(null);
    } catch (e: any) {
      setError(e.response?.data?.detail ?? e.message ?? "Plan init failed");
    } finally {
      setLoading(false);
    }
  }, [session, angles, imageB64]);

  const handleSlider = useCallback(async (value: number) => {
    if (!session || !osteotomyPlan) return;
    pushHistory();
    setLoading(true);
    try {
      const resp = await updatePlan(session.session_id, { slider_value: value });
      setOsteotomyPlan(resp);
      setAngles(resp.post_angles);
    } catch (e: any) {
      setError(e.response?.data?.detail ?? e.message ?? "Slider update failed");
    } finally {
      setLoading(false);
    }
  }, [session, osteotomyPlan, pushHistory]);

  const handleResetPlan = useCallback(async () => {
    if (!session) return;
    try {
      const resp = await deletePlan(session.session_id);
      // Restore baseline state
      setAngles(resp.angles);
      setImageB64(resp.image_b64);
    } catch (_) { /* ignore — still clear local state */ }
    // Restore from in-memory baseline snapshot as fallback
    if (baselineAnglesRef.current) setAngles(baselineAnglesRef.current);
    if (baselineImageRef.current)  setImageB64(baselineImageRef.current);
    baselineAnglesRef.current = null;
    baselineImageRef.current  = "";
    setOsteotomyPlan(null);
    setPlanningStep("idle");
    setPendingOstP1(null);
  }, [session]);

  // ESC / Backspace: step-wise undo for osteotomy placement
  React.useEffect(() => {
    if (planningStep === "idle") return;
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key !== "Escape" && e.key !== "Backspace") return;
      e.preventDefault();
      if (planningStep === "ost_p2") {
        // p1 is only local state — no backend call was made yet
        setPendingOstP1(null);
        setPlanningStep("ost_p1");
      } else {
        // cut line / hinge / target already sent → full reset
        handleResetPlan();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [planningStep, handleResetPlan]);

  const handlePlanPointMove = useCallback(async (
    field: "osteotomy_line_p1" | "osteotomy_line_p2" | "hinge_point" | "target_point",
    pt: Point,
  ) => {
    if (!session || !osteotomyPlan) return;
    pushHistory();
    setLoading(true);
    try {
      let patch: Parameters<typeof updatePlan>[1] = {};
      if (field === "osteotomy_line_p1" && osteotomyPlan.osteotomy_line) {
        patch = { osteotomy_line: { ...osteotomyPlan.osteotomy_line, p1: pt } };
      } else if (field === "osteotomy_line_p2" && osteotomyPlan.osteotomy_line) {
        patch = { osteotomy_line: { ...osteotomyPlan.osteotomy_line, p2: pt } };
      } else if (field === "hinge_point") {
        patch = { hinge_point: pt };
      } else if (field === "target_point") {
        patch = { target_point: pt };
      }
      const resp = await updatePlan(session.session_id, patch);
      setOsteotomyPlan(resp);
      setAngles(resp.post_angles);
    } catch (e: any) {
      setError(e.response?.data?.detail ?? e.message ?? "Plan point update failed");
    } finally {
      setLoading(false);
    }
  }, [session, osteotomyPlan, pushHistory]);

  const handleConfirmPlan = useCallback(async () => {
    if (!session || !osteotomyPlan || !landmarks) return;
    if (!osteotomyPlan.osteotomy_line || !osteotomyPlan.hinge_point) return;

    pushHistory();
    setLoading(true);

    // Freeze the visual record BEFORE any async work.
    const confirmed: ConfirmedOsteotomy = {
      id: `ost_${Date.now()}`,
      plan: { ...osteotomyPlan },
      landmarksAtConfirm: { ...landmarks },
    };

    // Determine (or capture) the immutable base — frozen at the FIRST confirmation.
    const isFirstConfirmation = confirmedOsteotomies.length === 0;
    const base = isFirstConfirmation ? landmarks : (baseLandmarks ?? landmarks);
    // Capture the current backend-annotated image and angles before we overwrite them —
    // these become the "Ausgangsbefund" column in the structured export comparison.
    // Use the baseline refs (set at plan-initiation time, BEFORE any slider/simulation
    // updates _angles.current / _imageB64.current) so pre-op values are never contaminated
    // by the correction that was applied while the user was adjusting the osteotomy.
    const capturedBaseImage  = isFirstConfirmation
      ? (baselineImageRef.current  || _imageB64.current)
      : _baseAnnotatedImageB64.current;
    const capturedBaseAngles = isFirstConfirmation
      ? (baselineAnglesRef.current ?? _angles.current)
      : _baseAngles.current;
    const newConfirmed = [...confirmedOsteotomies, confirmed];

    // Derive current positions by replaying ALL plans on the base — never accumulate.
    const transformedLm = reapplyAllOsteotomies(base, newConfirmed);

    try {
      // 1. Delete the active plan on the backend (clears plan state).
      await deletePlan(session.session_id);

      // 2. Push the replayed landmarks so the backend recalculates axes/angles.
      const resp = await updateLandmarks(session.session_id, landmarksPatch(transformedLm));
      setLandmarks(resp.landmarks);
      setAngles(resp.angles);
      setImageB64(resp.image_b64);

      // Commit confirmed list and base only after successful backend update.
      setConfirmedOsteotomies(newConfirmed);
      if (isFirstConfirmation) {
        setBaseLandmarks(base);
        setBaseAnnotatedImageB64(capturedBaseImage);
        setBaseAngles(capturedBaseAngles);
      }
    } catch (e: any) {
      setError(e.response?.data?.detail ?? e.message ?? "Confirm failed");
    } finally {
      setLoading(false);
    }

    // Clear plan state
    baselineAnglesRef.current = null;
    baselineImageRef.current  = "";
    setOsteotomyPlan(null);
    setPlanningStep("idle");
    setPendingOstP1(null);
  }, [session, osteotomyPlan, landmarks, confirmedOsteotomies, baseLandmarks, pushHistory]);

  const handleDeleteConfirmed = useCallback(async (id: string) => {
    if (!session || !baseLandmarks) return;
    pushHistory();
    setLoading(true);

    const newConfirmed = confirmedOsteotomies.filter(o => o.id !== id);
    // Replay remaining plans on the frozen base; empty list restores original.
    const restoredLm = reapplyAllOsteotomies(baseLandmarks, newConfirmed);

    try {
      const resp = await updateLandmarks(session.session_id, landmarksPatch(restoredLm));
      setLandmarks(resp.landmarks);
      setAngles(resp.angles);
      setImageB64(resp.image_b64);
      setConfirmedOsteotomies(newConfirmed);
      // Release base when all osteotomies are gone.
      if (newConfirmed.length === 0) {
        setBaseLandmarks(null);
        setBaseAnnotatedImageB64("");
        setBaseAngles(null);
      }
    } catch (e: any) {
      setError(e.response?.data?.detail ?? e.message ?? "Delete failed");
    } finally {
      setLoading(false);
    }
  }, [session, baseLandmarks, confirmedOsteotomies, pushHistory]);

  const handleExport = useCallback(async (format: "png" | "pdf" | "json") => {
    if (!session) return;

    // JSON has no visual content — keep backend route unchanged.
    if (format === "json") {
      window.open(exportUrl(session.session_id, format), "_blank");
      return;
    }

    // PNG and PDF: capture the structured 4-column export layout so the
    // export includes measurement table, annotated image, osteotomy view,
    // and osteotomy details — all composed onto a single canvas.
    const dataUrl = viewerRef.current?.captureExportCanvas();
    if (!dataUrl) return;

    if (format === "png") {
      const link = document.createElement("a");
      link.href = dataUrl;
      link.download = `cadtomie_${session.session_id.slice(0, 8)}.png`;
      link.click();
      return;
    }

    if (format === "pdf") {
      setLoading(true);
      try {
        const pdfBlob = await exportPdfFromCanvas(session.session_id, dataUrl);
        const url = URL.createObjectURL(pdfBlob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `cadtomie_${session.session_id.slice(0, 8)}.pdf`;
        link.click();
        URL.revokeObjectURL(url);
      } catch (e: any) {
        setError(e.response?.data?.detail ?? e.message ?? "PDF export failed");
      } finally {
        setLoading(false);
      }
    }
  }, [session]);

  const isCalibrated = calibSpacingMm !== null;
  const isLateral = imageType === "knee_lateral";
  // In lateral mode the slope workflow works immediately after upload (no AP landmark setup needed).
  // In AP mode the user must calibrate + select side before drawing tools unlock.
  const isApReady = isCalibrated && side !== "unknown";
  const isReady = isLateral ? !!imageB64 : isApReady;

  return (
    <div className={styles.layout}>
      <header className={styles.header}>
        <span className={styles.logo}>CADtomie</span>
        <span className={styles.subtitle}>{t("app_subtitle")}</span>

        {/* Undo / Redo */}
        <div className={styles.undoRedoBtns}>
          <button
            className={styles.iconBtn}
            onClick={handleUndo}
            disabled={!canUndo}
            title={t("undo_title")}
            aria-label={t("undo")}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 7v6h6"/>
              <path d="M3 13C5.5 6.5 11 3 17 3a9 9 0 0 1 0 18 9 9 0 0 1-6.2-2.5"/>
            </svg>
          </button>
          <button
            className={styles.iconBtn}
            onClick={handleRedo}
            disabled={!canRedo}
            title={t("redo_title")}
            aria-label={t("redo")}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 7v6h-6"/>
              <path d="M21 13C18.5 6.5 13 3 7 3a9 9 0 0 0 0 18 9 9 0 0 0 6.2-2.5"/>
            </svg>
          </button>
        </div>

        <button
          className={`btn-ghost ${showAnatomical ? styles.activeToggle : ""}`}
          onClick={handleToggleAnatomical}
          disabled={loading || !isApReady}
          title={t("anat_axes_title")}
        >
          {t("anat_axes")} {showAnatomical ? "✓" : "○"}
        </button>
        {session && isReady && (
          <div className={styles.exportBtns}>
            <button className="btn-ghost" onClick={() => handleExport("png")}>{t("export_png")}</button>
            <button className="btn-ghost" onClick={() => handleExport("pdf")}>{t("export_pdf")}</button>
          </div>
        )}
        <a
          href="https://www.youtube.com/@cadtomie"
          target="_blank"
          rel="noopener noreferrer"
          title="Tutorial-Video"
          style={{ display: "flex", alignItems: "center", gap: "0.35rem", color: "#8b949e", textDecoration: "none", fontSize: 13, padding: "4px 8px", borderRadius: 6, border: "1px solid #30363d" }}
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
            <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>
          </svg>
          Tutorial-Video
        </a>
        <div className={styles.langSwitcher}>
          {(["de", "en", "es"] as Lang[]).map(l => (
            <button
              key={l}
              className={`${styles.langBtn} ${lang === l ? styles.langActive : ""}`}
              onClick={() => setLang(l)}
              title={l === "de" ? "Deutsch" : l === "en" ? "English" : "Español"}
            >
              {l === "de" ? "🇩🇪" : l === "en" ? "🇬🇧" : "🇪🇸"}
            </button>
          ))}
        </div>
        <button
          onClick={auth.logout}
          title="Sign out"
          style={{ background: "none", border: "1px solid #30363d", borderRadius: 6, color: "#8b949e", cursor: "pointer", fontSize: 12, padding: "4px 10px" }}
        >
          {auth.user?.email?.split("@")[0] ?? "Sign out"} ↩
        </button>
      </header>

      <main className={styles.main}>
        <aside className={`${styles.leftPanel}${leftPanelOpen ? " " + styles.panelOpen : ""}`}>
          <UploadPanel
            onUpload={handleUpload}
            loading={loading}
            imageType={imageType}
            onImageTypeChange={setImageType}
          />
          <SideToggle side={side} onChange={handleSideChange} disabled={loading} />
          {error && <div className={styles.error}>{error}</div>}
          <CalibrationPanel
            sessionId={session?.session_id ?? null}
            calibMode={calibMode}
            calibType={calibType}
            calibPoints={calibPoints}
            pixelSpacingMm={calibSpacingMm}
            loading={loading}
            onStartCalib={handleStartCalib}
            onTypeChange={handleTypeChange}
            onApplyCalib={handleApplyCalib}
            onReset={handleResetCalib}
          />
          {imageType === "long_leg_ap" && isReady && measureStep !== "done" && (
            <GuidedLandmarkPanel
              measureStep={measureStep}
              hipPoints={hipMeasPts}
              femurPts={femurMeasPts}
              tibiaPts={tibiaMeasPts}
              anklePts={ankleMeasPts}
              hipCenter={landmarks?.hip_center ?? null}
              dfl={landmarks?.distal_femoral_line ?? null}
              kneeCenter={landmarks?.knee_center ?? null}
              ptl={landmarks?.proximal_tibial_line ?? null}
              ankleCenter={landmarks?.ankle_center ?? null}
              dtl={landmarks?.distal_tibial_line ?? null}
              onResetSection={handleResetSection}
            />
          )}
          {imageType === "long_leg_ap" && isReady && measureStep === "done" && angles && (
            <MeasurementPanel angles={angles} />
          )}
        </aside>

        <section className={styles.viewer}>
          {imageB64 ? (
            <>
              <DicomViewer
                ref={viewerRef}
                imageB64={imageType === "long_leg_ap" && measureStep !== "done" && rawImageB64 ? rawImageB64 : imageB64}
                rawImageB64={rawImageB64}
                baseAnnotatedImageB64={baseAnnotatedImageB64 || undefined}
                baseAngles={baseAngles ?? undefined}
                baseLandmarks={baseLandmarks ?? undefined}
                sessionKey={session?.session_id ?? ""}
                landmarks={imageType === "long_leg_ap" && measureStep !== "done" ? null : landmarks}
                onLandmarkMove={handleLandmarkMove}
                loading={loading}
                showAnatomical={showAnatomical}
                onCanvasClick={handleCanvasClick}
                calibMode={calibMode}
                calibType={calibType}
                calibPoints={calibPoints}
                plan={isReady ? osteotomyPlan : null}
                planningStep={isReady ? planningStep : "idle"}
                pendingOstP1={isReady ? pendingOstP1 : null}
                confirmedOsteotomies={isReady ? confirmedOsteotomies : []}
                onPlanPointMove={handlePlanPointMove}
                measureStep={measureStep}
                hipMeasPts={hipMeasPts}
                femurMeasPts={femurMeasPts}
                tibiaMeasPts={tibiaMeasPts}
                ankleMeasPts={ankleMeasPts}
                annotations={annotations}
                activeTool={activeTool}
                pendingAnnotPts={pendingAnnotPts}
                pixelSpacingMm={calibSpacingMm}
                angles={imageType === "long_leg_ap" && measureStep === "done" ? angles : null}
                slopeStep={slopeStep}
                slopePts={slopePts}
                slopeValue={slopeValue}
                sagittalStep={sagittalStep}
                sagittalOst={sagittalOst}
                sagittalResult={sagittalResult}
                confirmedSagittalOsts={confirmedSagittalOsts}
                imageType={imageType}
                lang={lang}
              />
              {!isLateral && !isCalibrated && (
                <div className={styles.calibBanner}>
                  {t("calib_banner")}
                </div>
              )}
              {!isLateral && isCalibrated && !isApReady && (
                <div className={styles.sideBanner}>
                  {t("side_banner")}
                </div>
              )}
            </>
          ) : (
            <div className={styles.placeholder}>
              <p>{t("placeholder")}</p>
            </div>
          )}
        </section>

        {/* Mobile overlay backdrop */}
        {(leftPanelOpen || rightPanelOpen) && (
          <div
            className={styles.panelOverlay}
            onClick={() => { setLeftPanelOpen(false); setRightPanelOpen(false); }}
          />
        )}

        {/* Mobile panel toggle buttons */}
        <div className={styles.mobilePanelToggle}>
          <button
            className={`${styles.mobilePanelBtn}${leftPanelOpen ? " " + styles.active : ""}`}
            onClick={() => { setLeftPanelOpen(v => !v); setRightPanelOpen(false); }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            Upload
          </button>
          <button
            className={`${styles.mobilePanelBtn}${rightPanelOpen ? " " + styles.active : ""}`}
            onClick={() => { setRightPanelOpen(v => !v); setLeftPanelOpen(false); }}
          >
            Tools
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="9 18 15 12 9 6"/></svg>
          </button>
        </div>

        <aside className={`${styles.rightPanel}${rightPanelOpen ? " " + styles.panelOpen : ""}`}>
          {imageType === "knee_lateral" && imageB64 ? (
            <>
              <SlopePanel
                step={slopeStep}
                slope={slopeValue}
                onStart={handleSlopeStart}
                onReset={handleSlopeReset}
              />
              {slopeStep === "done" && slopeValue !== null && (
                <SlopeCorrectionPanel
                  step={sagittalStep}
                  originalSlope={slopeValue}
                  ost={sagittalOst}
                  result={sagittalResult}
                  confirmedOsts={confirmedSagittalOsts}
                  onStart={() => setSagittalStep("cut_p1")}
                  onReset={handleSagittalReset}
                  onConfirm={handleConfirmSagittal}
                  onCorrectionChange={deg =>
                    setSagittalOst(prev => ({ ...prev, correctionDeg: deg }))
                  }
                />
              )}
              <AnnotationToolsPanel
                activeTool={activeTool}
                annotations={annotations}
                pixelSpacingMm={calibSpacingMm}
                pendingCount={pendingAnnotPts.length}
                onToolChange={handleToolChange}
                onDeleteAnnotation={handleDeleteAnnotation}
                onClearAll={handleClearAnnotations}
              />
            </>
          ) : isReady ? (
            <>
              {measureStep === "done" && (
                <PlanningPanel
                  plan={osteotomyPlan}
                  step={planningStep}
                  landmarks={landmarks}
                  loading={loading}
                  confirmedOsteotomies={confirmedOsteotomies}
                  onInit={handleInitPlan}
                  onStep={setPlanningStep}
                  onSlider={handleSlider}
                  onReset={handleResetPlan}
                  onConfirm={handleConfirmPlan}
                  onDeleteConfirmed={handleDeleteConfirmed}
                />
              )}
              <AnnotationToolsPanel
                activeTool={activeTool}
                annotations={annotations}
                pixelSpacingMm={calibSpacingMm}
                pendingCount={pendingAnnotPts.length}
                onToolChange={handleToolChange}
                onDeleteAnnotation={handleDeleteAnnotation}
                onClearAll={handleClearAnnotations}
              />
            </>
          ) : isCalibrated && session ? (
            <div className={styles.sideGate}>
              <span>↔</span>
              <p>{t("side_gate_heading")}</p>
              <p>{t("side_gate_desc")}</p>
              <div className={styles.sideGateBtns}>
                <button
                  className={styles.sideGateBtn}
                  onClick={() => handleSideChange("left")}
                  disabled={loading}
                >
                  {t("side_left")}
                </button>
                <button
                  className={styles.sideGateBtn}
                  onClick={() => handleSideChange("right")}
                  disabled={loading}
                >
                  {t("side_right")}
                </button>
              </div>
            </div>
          ) : session ? (
            <div className={styles.calibGate}>
              <span>🔒</span>
              <p>{t("calib_gate_heading")}</p>
              <p>{t("calib_gate_desc")}</p>
            </div>
          ) : null}
        </aside>
      </main>
    </div>
  );
}

/** Root component — handles auth routing before rendering AppContent. */
export default function App() {
  const auth = useAuth();
  const [authScreen, setAuthScreen] = useState<"login" | "signup">("login");
  const [isRecovery, setIsRecovery] = useState(() =>
    window.location.hash.includes("type=recovery")
  );

  if (isRecovery) {
    return <ResetPasswordPage onDone={() => setIsRecovery(false)} />;
  }

  if (auth.loading || auth.subscriptionStatus === "loading") {
    return LOADING_SCREEN;
  }

  if (!auth.user) {
    return authScreen === "login"
      ? <LoginPage auth={auth} onSwitchToSignup={() => setAuthScreen("signup")} />
      : <SignupPage auth={auth} onSwitchToLogin={() => setAuthScreen("login")} />;
  }

  const activeSub =
    auth.subscriptionStatus === "trialing" || auth.subscriptionStatus === "active";
  if (!activeSub) return <PaywallPage auth={auth} />;

  return <AppContent auth={auth} />;
}
