import React from "react";
import { Loader2 } from "@/icons/lucide-compat";
import type { PreviewProxyEntry } from "../../../services/preview-proxy-cache";

export const PreviewPreparationStatus: React.FC<{
  entry: Pick<PreviewProxyEntry, "status" | "error"> | undefined;
  onRetry: () => void;
}> = ({ entry, onRetry }) => {
  if (entry?.status === "encoding" || entry?.status === "queued") {
    return (
      <div role="status" aria-live="polite" className="absolute inset-x-3 bottom-3 z-40 flex items-center gap-2 rounded bg-black/85 px-3 py-2 text-xs text-white">
        <Loader2 size={14} className="shrink-0 animate-spin" aria-hidden="true" />
        <span>Preparing preview…</span>
      </div>
    );
  }

  if (entry?.status !== "error") return null;

  return (
    <div role="alert" className="absolute inset-x-3 bottom-3 z-40 flex flex-wrap items-center gap-2 rounded bg-black/90 px-3 py-2 text-xs text-white">
      <span className="min-w-0 flex-1">{entry.error || "Original preview could not be prepared."}</span>
      <button type="button" onClick={onRetry} className="min-h-8 shrink-0 rounded border border-white/40 px-2 text-white hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white">
        Retry preview
      </button>
    </div>
  );
};
