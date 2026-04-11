import React from "react";
import type { Annotation, AnnotationTool } from "../types";
import styles from "./AnnotationToolsPanel.module.css";
import { useTranslation } from "../i18n/LanguageContext";
import type { TranslationKey } from "../i18n/translations";

interface Props {
  activeTool: AnnotationTool;
  annotations: Annotation[];
  pixelSpacingMm: number | null;
  pendingCount: number;
  onToolChange: (tool: AnnotationTool) => void;
  onDeleteAnnotation: (id: string) => void;
  onClearAll: () => void;
}

function annotationLabel(
  ann: Annotation,
  pxMm: number | null,
  t: (k: TranslationKey) => string,
  n: (v: number, d?: number) => string,
): string {
  if (ann.type === "line") {
    const dist = Math.hypot(ann.p2.x - ann.p1.x, ann.p2.y - ann.p1.y);
    return pxMm ? `${t("tool_distance")}: ${n(dist * pxMm)} mm` : `${t("tool_distance")}: ${dist.toFixed(0)} px`;
  }
  if (ann.type === "angle") {
    const dx1 = ann.p1.x - ann.vertex.x; const dy1 = ann.p1.y - ann.vertex.y;
    const dx2 = ann.p2.x - ann.vertex.x; const dy2 = ann.p2.y - ann.vertex.y;
    const cos = (dx1*dx2+dy1*dy2) / (Math.hypot(dx1,dy1)*Math.hypot(dx2,dy2)+1e-9);
    const angle = (180/Math.PI) * Math.acos(Math.max(-1, Math.min(1, cos)));
    return `${t("tool_angle")}: ${n(angle)}°`;
  }
  if (ann.type === "text") {
    return `${t("tool_text")}: "${ann.text}"`;
  }
  return "";
}

export default function AnnotationToolsPanel({
  activeTool,
  annotations,
  pixelSpacingMm,
  pendingCount,
  onToolChange,
  onDeleteAnnotation,
  onClearAll,
}: Props) {
  const { t, n } = useTranslation();

  const tools: { id: AnnotationTool; icon: string; label: string }[] = [
    { id: "none",  icon: "↖",  label: t("tool_pointer") },
    { id: "line",  icon: "—",  label: t("tool_distance") },
    { id: "angle", icon: "∠",  label: t("tool_angle") },
    { id: "text",  icon: "T",  label: t("tool_text") },
  ];

  const toolHint: Record<AnnotationTool, string> = {
    none: "",
    line: pendingCount === 0 ? t("tool_hint_line_p1") : t("tool_hint_line_p2"),
    angle: pendingCount === 0 ? t("tool_hint_angle_p1") : pendingCount === 1 ? t("tool_hint_angle_p2") : t("tool_hint_angle_p3"),
    text: t("tool_hint_text"),
  };

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.title}>{t("tools_title")}</span>
        {annotations.length > 0 && (
          <button className={styles.clearBtn} onClick={onClearAll} title={t("tool_clear_all")}>✕</button>
        )}
      </div>

      <div className={styles.toolRow}>
        {tools.map(tool => (
          <button
            key={tool.id}
            className={`${styles.toolBtn} ${activeTool === tool.id ? styles.toolActive : ""}`}
            onClick={() => onToolChange(activeTool === tool.id && tool.id !== "none" ? "none" : tool.id)}
            title={tool.label}
          >
            <span className={styles.toolIcon}>{tool.icon}</span>
            <span className={styles.toolLabel}>{tool.label}</span>
          </button>
        ))}
      </div>

      {activeTool !== "none" && (
        <p className={styles.toolHint}>{toolHint[activeTool]}</p>
      )}

      {annotations.length === 0 ? (
        <p className={styles.empty}>{t("tool_no_measurements")}</p>
      ) : (
        <div className={styles.list}>
          {annotations.map(ann => (
            <div key={ann.id} className={styles.item}>
              <span className={styles.itemIcon}>
                {ann.type === "line" ? "—" : ann.type === "angle" ? "∠" : "T"}
              </span>
              <span className={styles.itemLabel}>
                {annotationLabel(ann, pixelSpacingMm, t, n)}
              </span>
              <button
                className={styles.deleteBtn}
                onClick={() => onDeleteAnnotation(ann.id)}
                title={t("tool_delete")}
              >×</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
