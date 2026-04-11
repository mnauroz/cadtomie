import React from "react";
import type { Side } from "../types";
import styles from "./SideToggle.module.css";
import { useTranslation } from "../i18n/LanguageContext";

interface Props {
  side: Side;
  onChange: (side: Side) => void;
  disabled?: boolean;
}

export default function SideToggle({ side, onChange, disabled }: Props) {
  const { t } = useTranslation();

  return (
    <div className={styles.wrapper}>
      <div className={styles.header}>
        <span className={styles.label}>{t("side_toggle_header")}</span>
        <span className={styles.hint}>{t("side_toggle_hint")}</span>
      </div>
      <div className={styles.group}>
        <button
          className={`${styles.btn} ${side === "left" ? styles.active : ""}`}
          onClick={() => onChange("left")}
          disabled={disabled}
          title={t("side_left_title")}
        >
          {t("side_left_label")}
        </button>
        <button
          className={`${styles.btn} ${side === "unknown" ? styles.neutral : ""}`}
          onClick={() => onChange("unknown")}
          disabled={disabled}
          title={t("side_unknown_title")}
        >
          ?
        </button>
        <button
          className={`${styles.btn} ${side === "right" ? styles.active : ""}`}
          onClick={() => onChange("right")}
          disabled={disabled}
          title={t("side_right_title")}
        >
          {t("side_right_label")}
        </button>
      </div>
    </div>
  );
}
