import { api } from "../api";
import type { Angles, Point } from "../types";
import type { OsteotomyKind, OsteotomyPlan, OstLine } from "./types";

const BASE = import.meta.env.VITE_API_BASE_URL ?? "";

export interface PlanResponse extends OsteotomyPlan {
  post_angles: Angles;
}

export interface DeletePlanResponse {
  angles: Angles;
  image_b64: string;
}

export async function initPlan(
  sessionId: string,
  kind: OsteotomyKind,
  autoPlace = false,
): Promise<PlanResponse> {
  const { data } = await api.post<PlanResponse>(
    `${BASE}/osteotomy/${sessionId}/init?kind=${kind}&auto_place=${autoPlace}`
  );
  return data;
}

export interface PlanPatch {
  kind?: OsteotomyKind;
  osteotomy_line?: OstLine;
  hinge_point?: Point;
  target_point?: Point;
  target_plateau_pct?: number;
  slider_value?: number;
  correction_deg?: number;
}

export async function updatePlan(sessionId: string, patch: PlanPatch): Promise<PlanResponse> {
  const { data } = await api.patch<PlanResponse>(
    `${BASE}/osteotomy/${sessionId}`,
    patch
  );
  return data;
}

export async function deletePlan(sessionId: string): Promise<DeletePlanResponse> {
  const { data } = await api.delete<DeletePlanResponse>(`${BASE}/osteotomy/${sessionId}`);
  return data;
}
