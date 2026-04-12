import axios from "axios";
import type { Angles, Point } from "../types";
import type { OsteotomyKind, OsteotomyPlan, OstLine } from "./types";

const BASE = import.meta.env.VITE_API_BASE_URL ?? "";

/**
 * Response from init/update endpoints.
 * Includes the plan fields PLUS post_angles — the full recalculated angle
 * set derived from the post-osteotomy landmark positions.
 *
 * The frontend MUST update its angles state from post_angles on every plan
 * change so that the MeasurementPanel always reflects the current geometry.
 */
export interface PlanResponse extends OsteotomyPlan {
  /** All 5 angles recalculated from the transformed (post-osteotomy) landmarks. */
  post_angles: Angles;
}

/**
 * Response from the delete endpoint.
 * Contains the baseline (pre-osteotomy) angles and image for state restoration.
 */
export interface DeletePlanResponse {
  angles: Angles;
  image_b64: string;
}

export async function initPlan(
  sessionId: string,
  kind: OsteotomyKind,
  autoPlace = false,
): Promise<PlanResponse> {
  const { data } = await axios.post<PlanResponse>(
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
  /** Non-negative magnitude; sign is locked to miniaci_deg on the backend. */
  slider_value?: number;
  /** Override with explicit signed angle (advanced). */
  correction_deg?: number;
}

export async function updatePlan(sessionId: string, patch: PlanPatch): Promise<PlanResponse> {
  const { data } = await axios.patch<PlanResponse>(
    `${BASE}/osteotomy/${sessionId}`,
    patch
  );
  return data;
}

export async function deletePlan(sessionId: string): Promise<DeletePlanResponse> {
  const { data } = await axios.delete<DeletePlanResponse>(`${BASE}/osteotomy/${sessionId}`);
  return data;
}
