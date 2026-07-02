"use client";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="min-h-screen bg-[var(--background)] flex items-center justify-center p-8">
      <div className="max-w-md text-center space-y-4">
        <p className="text-[var(--foreground)] font-medium">
          The Analysis tab hit an error while rendering.
        </p>
        <p className="text-sm text-[var(--text-secondary)] font-[family-name:var(--font-geist-mono)] break-words">
          {error.message}
        </p>
        <button
          onClick={reset}
          className="px-4 py-2 rounded-lg bg-[var(--accent)] text-white text-sm font-medium hover:bg-[var(--accent-hover)]"
        >
          Retry
        </button>
      </div>
    </div>
  );
}
