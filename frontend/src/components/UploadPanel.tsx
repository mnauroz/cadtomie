import React, { useRef } from "react";
import type { ImageType } from "../types";
import styles from "./UploadPanel.module.css";
import { useTranslation } from "../i18n/LanguageContext";

interface Props {
  onUpload: (file: File) => void;
  loading: boolean;
  imageType: ImageType;
  onImageTypeChange: (t: ImageType) => void;
}

export default function UploadPanel({ onUpload, loading, imageType, onImageTypeChange }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const { t } = useTranslation();

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) onUpload(file);
    e.target.value = "";
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) onUpload(file);
  };

  return (
    <div className={styles.panel}>
      <h2 className={styles.title}>{t("upload_title")}</h2>

      <div className={styles.typeSelector}>
        <label className={`${styles.typeOption} ${imageType === "long_leg_ap" ? styles.typeActive : ""}`}>
          <input
            type="radio"
            name="imageType"
            value="long_leg_ap"
            checked={imageType === "long_leg_ap"}
            onChange={() => onImageTypeChange("long_leg_ap")}
          />
          {t("upload_long_leg")}
          <span className={styles.typeDesc}>{t("upload_long_leg_desc")}</span>
        </label>
        <label className={`${styles.typeOption} ${imageType === "knee_lateral" ? styles.typeActive : ""}`}>
          <input
            type="radio"
            name="imageType"
            value="knee_lateral"
            checked={imageType === "knee_lateral"}
            onChange={() => onImageTypeChange("knee_lateral")}
          />
          {t("upload_lateral")}
          <span className={styles.typeDesc}>{t("upload_lateral_desc")}</span>
        </label>
      </div>

      <div
        className={styles.dropzone}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={handleDrop}
      >
        {loading ? (
          <div className={styles.spinner} />
        ) : (
          <>
            <div className={styles.icon}>⬆</div>
            <p className={styles.hint}>{t("upload_dropzone")}</p>
          </>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept=".dcm,.jpg,.jpeg,.png,.bmp,.tiff,.tif,application/dicom,image/*"
        onChange={handleChange}
      />
      <p className={styles.note}>
        {t("upload_note_dicom")}<br />
        {t("upload_note_jpg")}
      </p>
    </div>
  );
}
