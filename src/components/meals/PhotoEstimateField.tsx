"use client";

import { useEffect, useRef, useState } from "react";
import type {
  EstimateInput,
  EstimateResult,
  NutritionEstimate,
  UploadPhotoResult,
} from "@/lib/use-meals";

interface PhotoEstimateFieldProps {
  uploadPhoto: (file: File) => Promise<UploadPhotoResult>;
  estimate: (input: EstimateInput) => Promise<EstimateResult>;
  /** Current free-text description, if any — enables "Estimate from description". */
  description?: string;
  /** Fired every time a new estimate succeeds. */
  onEstimated: (result: { photoId: string | null; nutrition: NutritionEstimate }) => void;
  /** Tighter spacing for use inside an inline reply row. */
  compact?: boolean;
  onPhotoChanged?: (photoId: string | null) => void;
  onPendingChange?: (pending: boolean) => void;
}

function confidenceColor(confidence: number): string {
  if (confidence >= 0.66) return "bg-emerald-500";
  if (confidence >= 0.33) return "bg-amber-500";
  return "bg-red-500";
}

export function formatCarbRange(nutrition: NutritionEstimate): string {
  const { low, mid, high } = nutrition.carbs;
  return `Most likely ${mid} g (${low}-${high} g), confidence ${Math.round(
    nutrition.confidence * 100
  )}%`;
}

export function PhotoEstimateField({
  uploadPhoto,
  estimate,
  description,
  onEstimated,
  compact,
  onPhotoChanged,
  onPendingChange,
}: PhotoEstimateFieldProps) {
  const [followUp, setFollowUp] = useState("");
  const [revisionPending, setRevisionPending] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [photoId, setPhotoId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<NutritionEstimate | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    onPendingChange?.(busy || !!followUp.trim() || (!!file && !photoId));
  }, [busy, followUp, file, photoId, onPendingChange]);

  const canEstimateFromDescription = !file && !!description?.trim();

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = e.target.files?.[0] ?? null;
    setError(null);
    setResult(null);
    setPhotoId(null);
    setFollowUp("");
    onPhotoChanged?.(null);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setFile(next);
    setPreviewUrl(next ? URL.createObjectURL(next) : null);
    if (next) {
      setBusy(true);
      const uploaded = await uploadPhoto(next);
      if (uploaded.ok) {
        setPhotoId(uploaded.photoId);
        onPhotoChanged?.(uploaded.photoId);
      } else setError(uploaded.error);
      setBusy(false);
    }
  };

  const runEstimate = async () => {
    if (busy) return;
    if (!file && !description?.trim()) return;
    setBusy(true);
    setError(null);
    try {
      let uploadedPhotoId: string | null = photoId;
      if (file && !uploadedPhotoId) {
        const uploadResult = await uploadPhoto(file);
        if (!uploadResult.ok) {
          setError(uploadResult.error);
          return;
        }
        uploadedPhotoId = uploadResult.photoId;
        setPhotoId(uploadedPhotoId);
      }
      const estimateResult = await estimate({
        photoId: uploadedPhotoId ?? undefined,
        description: description?.trim() || undefined,
        followUp: followUp.trim() || undefined,
        previousEstimate: result ?? undefined,
      });
      if (!estimateResult.ok) {
        setError(estimateResult.error);
        return;
      }
      setResult(estimateResult.estimate);
      setRevisionPending(false);
      setFollowUp("");
      onEstimated({ photoId: uploadedPhotoId, nutrition: estimateResult.estimate });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={compact ? "space-y-2" : "space-y-3"}>
      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={busy}
          className="px-3 py-1.5 rounded-full text-xs font-medium bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:text-[var(--foreground)] transition-colors"
        >
          {file ? "Change photo" : "Add photo"}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          onChange={handleFileChange}
          className="hidden"
        />
        {previewUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={previewUrl}
            alt="Selected meal photo"
            className="w-10 h-10 rounded-lg object-cover border border-[var(--border)]"
          />
        )}
        {(file || canEstimateFromDescription) && (
          <button
            type="button"
            onClick={runEstimate}
            disabled={busy}
            className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
              busy
                ? "bg-[var(--accent)]/60 text-white cursor-wait"
                : "bg-[var(--accent)] text-white hover:opacity-90"
            }`}
          >
            {busy
              ? "Estimating..."
              : file
                ? "Estimate"
                : "Estimate from description"}
          </button>
        )}
      </div>

      {error && (
        <div className="text-xs text-red-400" role="alert">
          {error}
        </div>
      )}

      {result && (
        <div className="rounded-lg bg-[var(--bg-elevated)] p-2.5 space-y-1.5">
          <div className="text-sm font-medium text-[var(--carb-amber)]">
            {formatCarbRange(result)}
          </div>
          <div className="h-1.5 w-full rounded-full bg-[var(--border)] overflow-hidden">
            <div
              className={`h-full ${confidenceColor(result.confidence)}`}
              style={{ width: `${Math.round(result.confidence * 100)}%` }}
            />
          </div>
          {result.items && result.items.length > 0 && (
            <ul className="text-xs text-[var(--text-secondary)] space-y-0.5">
              {result.items.map((item, idx) => (
                <li key={idx}>
                  {item.name} ({item.portion}) — {item.carbs} g
                </li>
              ))}
            </ul>
          )}
          <label className="block text-xs">
            Ask about this estimate
            <input type="text" value={followUp} maxLength={1000}
              placeholder="Did you account for the BBQ sauce on the ribs?"
              onChange={event => { setFollowUp(event.target.value); setRevisionPending(true); }}
              className="mt-1 w-full rounded-lg bg-[var(--bg-surface)] p-2" />
          </label>
          <button type="button" onClick={runEstimate} disabled={busy || !followUp.trim()}
            className="text-xs underline disabled:opacity-50">{busy ? "Revising..." : "Ask and revise estimate"}</button>
          {revisionPending && <p className="text-xs">Submit your question to update the estimate before saving.</p>}
          {result.notes && (
            <div className="text-xs text-[var(--text-tertiary)]">{result.notes}</div>
          )}
        </div>
      )}
    </div>
  );
}
