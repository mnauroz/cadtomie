import React, { useState } from "react";
import type { Landmarks } from "../types";
import type { OsteotomyKind, OsteotomyPlan, PlanningStep, ConfirmedOsteotomy } from "../osteotomy/types";
import { VALGISIEREND, VARISIEREND } from "../osteotomy/types";
import styles from "./PlanningPanel.module.css";
import { useTranslation } from "../i18n/LanguageContext";
import type { TranslationKey } from "../i18n/translations";

interface Props {
  plan: OsteotomyPlan | null;
  step: PlanningStep;
  landmarks: Landmarks | null;
  loading: boolean;
  confirmedOsteotomies: ConfirmedOsteotomy[];
  onInit: (kind: OsteotomyKind) => void;
  onStep: (step: PlanningStep) => void;
  onSlider: (value: number) => void;
  onReset: () => void;
  onConfirm: () => void;
  onDeleteConfirmed: (id: string) => void;
}

export default function PlanningPanel({ plan, step, landmarks, loading, confirmedOsteotomies, onInit, onStep, onSlider, onReset, onConfirm, onDeleteConfirmed }: Props) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const { t } = useTranslation();

  const STEP_LABELS_T: Record<PlanningStep, string> = {
    idle:   "",
    ost_p1: t("plan_step_ost_p1"),
    ost_p2: t("plan_step_ost_p2"),
    hinge:  t("plan_step_hinge_set"),
    target: t("plan_step_target_set"),
  };

  const hasPlan = plan !== null;
  const miniaci = plan?.miniaci_deg;
  const corrDeg = plan?.correction_deg ?? 0;
  const sliderVal = Math.abs(corrDeg);
  const maxSlider = 20;

  return (
    <section className={styles.panel}>
      <header className={styles.header}>
        <span className={styles.title}>{t("plan_title")}</span>
        {hasPlan && (
          <button className={styles.resetBtn} onClick={onReset} disabled={loading} title={t("plan_reset")}>✕</button>
        )}
      </header>

      {/* Osteotomy type selector — grouped by correction goal */}
      <div className={styles.kindSection}>
        <div className={styles.kindGroupLabel}>{t("plan_group_valgus")}</div>
        <div className={styles.kindGroup}>
          {VALGISIEREND.map(k => (
            <button
              key={k}
              className={`${styles.kindBtn} ${plan?.kind === k ? styles.kindActive : ""}`}
              onClick={() => onInit(k)}
              disabled={loading}
            >
              {t(`kind_${k}` as TranslationKey)}
            </button>
          ))}
        </div>
        <div className={styles.kindGroupLabel}>{t("plan_group_varus")}</div>
        <div className={styles.kindGroup}>
          {VARISIEREND.map(k => (
            <button
              key={k}
              className={`${styles.kindBtn} ${plan?.kind === k ? styles.kindActive : ""}`}
              onClick={() => onInit(k)}
              disabled={loading}
            >
              {t(`kind_${k}` as TranslationKey)}
            </button>
          ))}
        </div>
      </div>

      {hasPlan && (
        <>
          {/* Geometry placement steps */}
          <div className={styles.section}>
            <div className={styles.sectionTitle}>{t("plan_geometry")}</div>
            <div className={styles.stepRow}>
              <StepButton
                label={t("plan_step_cut_line")}
                active={step === "ost_p1" || step === "ost_p2"}
                done={!!plan.osteotomy_line}
                onClick={() => onStep("ost_p1")}
                disabled={loading}
              />
              <StepButton
                label={t("plan_step_hinge")}
                active={step === "hinge"}
                done={!!plan.hinge_point}
                onClick={() => onStep("hinge")}
                disabled={loading}
              />
              <StepButton
                label={t("plan_step_target")}
                active={step === "target"}
                done={!!plan.target_point}
                onClick={() => onStep("target")}
                disabled={loading}
              />
            </div>
            {step !== "idle" && (
              <div className={styles.stepHint}>
                👉 {STEP_LABELS_T[step]}
                <button className={styles.cancelStep} onClick={() => onStep("idle")}>{t("plan_cancel")}</button>
              </div>
            )}
          </div>

          {/* Correction slider */}
          <div className={styles.section}>
            <div className={styles.sectionTitle}>{t("plan_correction")}</div>

            {miniaci != null && (
              <div className={styles.miniaci}>
                Miniaci-Winkel: <strong>{Math.abs(miniaci).toFixed(1)}°</strong>
                <button
                  className={styles.applyMiniaci}
                  onClick={() => onSlider(Math.abs(miniaci))}
                  disabled={loading}
                >
                  {t("plan_apply_miniaci")}
                </button>
              </div>
            )}

            <div className={styles.sliderRow}>
              <span className={styles.sliderLabel}>0°</span>
              <input
                type="range"
                min={0}
                max={maxSlider}
                step={0.1}
                value={sliderVal}
                className={styles.slider}
                onChange={e => onSlider(parseFloat(e.target.value))}
                disabled={loading || !plan.hinge_point}
              />
              <span className={styles.sliderLabel}>{maxSlider}°</span>
            </div>
            <div className={styles.sliderValue}>{sliderVal.toFixed(1)}°</div>
          </div>

          {/* Results */}
          <div className={styles.section}>
            <div className={styles.sectionTitle}>{t("plan_results")}</div>
            <table className={styles.results}>
              <tbody>
                <ResultRow label={t("plan_wedge_size")} value={plan.wedge_mm} unit=" mm" />
                <ResultRow label={t("plan_hka_corrected")} value={plan.corrected_hka} unit="°" />
                {plan.kind.startsWith("HTO") && (
                  <ResultRow label={t("plan_mmpta_corrected")} value={plan.corrected_mmpta} unit="°" />
                )}
                {plan.kind.startsWith("DFO") && (
                  <ResultRow label={t("plan_mldfa_corrected")} value={plan.corrected_mldfa} unit="°" />
                )}
              </tbody>
            </table>
          </div>

          {/* Confirm action */}
          <div className={styles.confirmSection}>
            {plan.osteotomy_line && plan.hinge_point && plan.correction_deg !== 0 ? (
              <button className={styles.confirmBtn} onClick={onConfirm} disabled={loading}>
                {t("plan_confirm")}
              </button>
            ) : plan.osteotomy_line && plan.hinge_point ? (
              <p className={styles.confirmHint}>
                {t("plan_hint_set_angle")}
              </p>
            ) : (
              <p className={styles.confirmHint}>
                {t("plan_hint_set_geometry")}
              </p>
            )}
          </div>
        </>
      )}

      {/* Confirmed osteotomies list */}
      {confirmedOsteotomies.length > 0 && (
        <div className={styles.section}>
          <div className={styles.sectionTitle}>{t("plan_confirmed_header")} ({confirmedOsteotomies.length})</div>
          {confirmedOsteotomies.map((co, i) => {
            const isExpanded = expandedId !== co.id; // collapsed only when explicitly toggled off
            return (
              <div key={co.id} className={`${styles.confirmedRow} ${styles.confirmedRowExpanded}`}>
                <div
                  className={styles.confirmedHeader}
                  onClick={() => setExpandedId(isExpanded ? co.id : null)}
                >
                  <span className={styles.confirmedIndex}>{i + 1}</span>
                  <span className={styles.confirmedKind}>{t(`kind_${co.plan.kind}` as TranslationKey)}</span>
                  {co.plan.corrected_hka != null && (
                    <span className={styles.confirmedAngle}>HKA {co.plan.corrected_hka.toFixed(1)}°</span>
                  )}
                  <span className={styles.confirmedChevron}>{isExpanded ? "▲" : "▼"}</span>
                  <button
                    className={styles.deleteConfirmedBtn}
                    onClick={e => { e.stopPropagation(); onDeleteConfirmed(co.id); }}
                    disabled={loading}
                    title={t("plan_remove")}
                  >✕</button>
                </div>
                {isExpanded && (
                  <div className={styles.confirmedDetails}>
                    <div className={styles.confirmedDetailRow}>
                      <span>{t("plan_wedge_size")}</span>
                      <span>{co.plan.wedge_mm != null ? `${co.plan.wedge_mm.toFixed(1)} mm` : "—"}</span>
                    </div>
                    <div className={styles.confirmedDetailRow}>
                      <span>Miniaci-Winkel</span>
                      <span>{co.plan.miniaci_deg != null ? `${Math.abs(co.plan.miniaci_deg).toFixed(1)}°` : "—"}</span>
                    </div>
                    <div className={styles.confirmedDetailRow}>
                      <span>{t("plan_correction")}</span>
                      <span>{co.plan.correction_deg.toFixed(1)}°</span>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {!hasPlan && (
        <p className={styles.hint}>{t("plan_no_type")}</p>
      )}
    </section>
  );
}

function StepButton({ label, active, done, onClick, disabled }: {
  label: string; active: boolean; done: boolean; onClick: () => void; disabled: boolean;
}) {
  return (
    <button
      className={`${styles.stepBtn} ${active ? styles.stepActive : ""} ${done ? styles.stepDone : ""}`}
      onClick={onClick}
      disabled={disabled}
    >
      {done && !active ? "✓ " : ""}{label}
    </button>
  );
}

function ResultRow({ label, value, unit }: { label: string; value: number | null | undefined; unit: string }) {
  return (
    <tr>
      <td className={styles.resultLabel}>{label}</td>
      <td className={styles.resultValue}>
        {value != null ? `${value.toFixed(1)}${unit}` : "—"}
      </td>
    </tr>
  );
}
