import axios from "axios";
import type { Angles, DiaphysisLevel, JointLine, Landmarks, Point, UploadResponse } from "./types";
import { getAccessToken } from "./lib/supabase";

const BASE = import.meta.env.VITE_API_BASE_URL ?? "";  // e.g. https://api.cadtomie.com

export type Side = "right" | "left" | "unknown";

/** Axios instance that auto-attaches the Supabase JWT on every request. */
export const api = axios.create({ baseURL: BASE });

api.interceptors.request.use(async (config) => {
  const token = await getAccessToken();
  if (token) {
    config.headers = config.headers ?? {};
    config.headers["Authorization"] = `Bearer ${token}`;
  }
  return config;
});

export async function uploadDicom(file: File, side: Side = "unknown"): Promise<UploadResponse> {
  // Wake up the server first (Render may be cold-starting)
  try { await api.get("/health", { timeout: 30000 }); } catch { /* ignore */ }

  const form = new FormData();
  form.append("file", file);
  form.append("side", side);
  const { data } = await api.post<UploadResponse>("/upload", form, {
    headers: { "Content-Type": "multipart/form-data" },
    timeout: 120000, // 2 minutes for large DICOMs
  });
  return data;
}

export interface LandmarkPatch {
  hip_center?: Point;
  knee_center?: Point;
  ankle_center?: Point;
  distal_femoral_line?: JointLine;
  proximal_tibial_line?: JointLine;
  distal_tibial_line?: JointLine;
  femur_diaphysis_levels?: DiaphysisLevel[];
  tibia_diaphysis_levels?: DiaphysisLevel[];
}

export interface PatchResponse {
  angles: Angles;
  landmarks: Landmarks;
  image_b64: string;
}

export async function updateLandmarks(
  sessionId: string,
  patch: LandmarkPatch
): Promise<PatchResponse> {
  const { data } = await api.post<PatchResponse>(`/landmarks/${sessionId}`, patch);
  return data;
}

export interface SideResponse {
  angles: Angles;
  image_b64: string;
}

export async function setSide(sessionId: string, side: Side): Promise<SideResponse> {
  const { data } = await api.post<SideResponse>(`/side/${sessionId}?side=${side}`);
  return data;
}

export async function setConfig(
  sessionId: string,
  config: { show_anatomical: boolean }
): Promise<{ image_b64: string }> {
  const { data } = await api.post(`/config/${sessionId}`, config);
  return data;
}

export function exportUrl(sessionId: string, format: "png" | "pdf" | "json") {
  return `${BASE}/export/${sessionId}/${format}`;
}

/** POST the canvas PNG (as data URL) to the backend and receive a PDF blob. */
export async function exportPdfFromCanvas(sessionId: string, imageDataUrl: string): Promise<Blob> {
  const { data } = await api.post(
    `/export/${sessionId}/pdf-from-canvas`,
    { image_b64: imageDataUrl },
    { responseType: "blob" },
  );
  return data;
}

export interface CalibrationResult {
  pixel_spacing_mm: number;
  px_per_mm: number;
}

export async function calibrateImage(
  sessionId: string,
  p1: Point,
  p2: Point,
  known_mm: number
): Promise<CalibrationResult> {
  const { data } = await api.post<CalibrationResult>(`/calibrate/${sessionId}`, {
    p1,
    p2,
    known_mm,
  });
  return data;
}

export interface AutoCalibResult extends CalibrationResult {
  detected: { cx: number; cy: number; r: number };
}

export async function autoDetectBall(sessionId: string): Promise<AutoCalibResult> {
  const { data } = await api.post<AutoCalibResult>(`/calibrate/${sessionId}/auto`);
  return data;
}
