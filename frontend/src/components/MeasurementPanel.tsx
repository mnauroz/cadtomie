import React from "react";
import type { Angles } from "../types";
import styles from "./MeasurementPanel.module.css";
import { useTranslation } from "../i18n/LanguageContext";

interface Props {
  angles: Angles;
}

const NORMAL_RANGES: Record<string, string> = {
  HKA: "0 ± 3°",
  mLDFA: "85–90°",
  mMPTA: "85–90°",
  JLCA: "< 2°",
};

function status(key: string, val: number | null): "normal" | "abnormal" | "unknown" {
  if (val === null) return "unknown";
  switch (key) {
    case "HKA":   return Math.abs(val) <= 3 ? "normal" : "abnormal";
    case "mLDFA": return val >= 85 && val <= 90 ? "normal" : "abnormal";
    case "mMPTA": return val >= 85 && val <= 90 ? "normal" : "abnormal";
    case "JLCA":  return Math.abs(val) <= 2 ? "normal" : "abnormal";
    default:      return "unknown";
  }
}

export default function MeasurementPanel({ angles }: Props) {
  const { t } = useTranslation();

  const DESCRIPTIONS: Record<string, string> = {
    HKA: t("meas_hka_desc"),
    mLDFA: t("meas_mldfa_desc"),
    mMPTA: t("meas_mmpta_desc"),
    JLCA: t("meas_jlca_desc"),
  };

  const rows: Array<{ key: string; val: number | null }> = [
    { key: "HKA",   val: angles.HKA_deg },
    { key: "mLDFA", val: angles.mLDFA_deg },
    { key: "mMPTA", val: angles.mMPTA_deg },
    { key: "JLCA",  val: angles.JLCA_deg },
  ];

  return (
    <div className={styles.panel}>
      <h2 className={styles.title}>{t("measurements_title")}</h2>
      {rows.map(({ key, val }) => {
        const s = status(key, val);
        return (
          <div key={key} className={styles.row}>
            <div className={styles.label}>
              <span className={styles.name}>{key}</span>
              <span className={styles.desc}>{DESCRIPTIONS[key]}</span>
            </div>
            <div className={styles.right}>
              <span className={styles.value}>
                {val !== null ? `${val.toFixed(1)}°` : "—"}
              </span>
              <span className={`${styles.badge} ${styles[s]}`}>
                {key === "HKA" && angles.notes?.HKA
                  ? angles.notes.HKA
                  : s === "normal" ? t("badge_normal") : s === "abnormal" ? t("badge_abnormal") : "—"}
              </span>
            </div>
            <div className={styles.norm}>{NORMAL_RANGES[key]}</div>
          </div>
        );
      })}
      {angles.notes && Object.keys(angles.notes).length > 0 && (
        <div className={styles.notes}>
          {Object.entries(angles.notes).map(([k, v]) => (
            <div key={k}><strong>{k}:</strong> {v}</div>
          ))}
        </div>
      )}
    </div>
  );
}
