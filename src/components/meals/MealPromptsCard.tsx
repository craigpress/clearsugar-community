"use client";

import { useState } from "react";
import type {
  EatingNowResult,
  EatTiming,
  MealEpisode,
  ReplyInput,
  ReplyResult,
} from "@/lib/use-episodes";
import type { EstimateInput, EstimateResult, UploadPhotoResult } from "@/lib/use-meals";
import { PhotoEstimateField, formatCarbRange } from "@/components/meals/PhotoEstimateField";

const RECENTLY_ANSWERED_MS = 24 * 60 * 60 * 1000;

const BOLUS_CHIPS: { label: string; eatTiming: EatTiming }[] = [
  { label: "Ate with bolus", eatTiming: "with_bolus" },
  { label: "5 min later", eatTiming: "5" },
  { label: "15 min later", eatTiming: "15" },
  { label: "30 min later", eatTiming: "30" },
  { label: "60+ min later", eatTiming: "60plus" },
  { label: "Before bolus", eatTiming: "before_bolus" },
];

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Same body copy the push notification uses (plan section 4c). */
function episodeCopy(episode: MealEpisode): string {
  if (episode.trigger === "pump_bolus" && episode.bolusAt) {
    const units = episode.bolusInsulin != null ? `${episode.bolusInsulin} u` : "?";
    const grams = episode.bolusCarbs != null ? ` for ${episode.bolusCarbs} g` : "";
    return `${formatTime(episode.bolusAt)} bolus, ${units}${grams}. What did you eat?`;
  }
  if (episode.trigger === "glucose_rise" && episode.riseDetectedAt) {
    return `Rising since ${formatTime(episode.riseDetectedAt)}. Did you eat something?`;
  }
  if (episode.trigger === "eating_now" && episode.eatingAt) {
    return `Eating since ${formatTime(episode.eatingAt)}.`;
  }
  return "What did you eat?";
}

function replySummary(episode: MealEpisode): string {
  const reply = episode.reply;
  if (!reply) return "No reply";
  if (reply.kind === "dismiss") return "Dismissed";
  if (reply.kind === "text") return reply.text ? `"${reply.text}"` : "Replied";
  if (reply.kind === "photo") {
    return reply.nutrition ? formatCarbRange(reply.nutrition) : "Photo sent";
  }
  // chip
  if (reply.ateSomething === false) return "No";
  if (episode.trigger === "glucose_rise") {
    if (reply.bolused === true) return "Yes, bolused";
    if (reply.bolused === false) return "Yes, no bolus";
  }
  if (reply.eatTiming) {
    const chip = BOLUS_CHIPS.find((c) => c.eatTiming === reply.eatTiming);
    return chip?.label ?? reply.eatTiming;
  }
  return "Answered";
}

interface EpisodeRowProps {
  episode: MealEpisode;
  uploadPhoto: (file: File) => Promise<UploadPhotoResult>;
  estimate: (input: EstimateInput) => Promise<EstimateResult>;
  reply: (input: ReplyInput) => Promise<ReplyResult>;
  notPatient: boolean;
}

function OpenEpisodeRow({ episode, uploadPhoto, estimate, reply, notPatient }: EpisodeRowProps) {
  const [text, setText] = useState("");
  const [showPhoto, setShowPhoto] = useState(false);
  const [pendingReply, setPendingReply] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const send = async (input: Omit<ReplyInput, "episodeId">, key: string) => {
    if (pendingReply) return;
    setPendingReply(key);
    setError(null);
    const result = await reply({ episodeId: episode.id, ...input });
    setPendingReply(null);
    if (!result.ok && !result.notPatient) {
      setError(result.error);
    }
  };

  const handlePhotoEstimated = ({
    photoId,
    nutrition,
  }: {
    photoId: string | null;
    nutrition: NonNullable<ReplyInput["nutrition"]>;
  }) => {
    void send(
      { kind: "photo", photoId: photoId ?? undefined, nutrition },
      "photo"
    );
  };

  const isRise = episode.trigger === "glucose_rise";

  return (
    <li className="py-3 border-b border-[var(--border)] last:border-0 space-y-2">
      <div className="text-sm text-[var(--foreground)]">{episodeCopy(episode)}</div>

      {notPatient ? (
        <div className="text-xs text-[var(--text-secondary)]">
          Only Patient&apos;s account can reply.
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-1.5">
            {isRise ? (
              <>
                <button
                  type="button"
                  disabled={!!pendingReply}
                  onClick={() => send({ kind: "chip", ateSomething: true, bolused: true }, "yb")}
                  className="px-2.5 py-1 rounded-full text-xs font-medium bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:text-[var(--foreground)] disabled:opacity-50 transition-colors"
                >
                  {pendingReply === "yb" ? "Sending..." : "Yes, bolused"}
                </button>
                <button
                  type="button"
                  disabled={!!pendingReply}
                  onClick={() => send({ kind: "chip", ateSomething: true, bolused: false }, "ynb")}
                  className="px-2.5 py-1 rounded-full text-xs font-medium bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:text-[var(--foreground)] disabled:opacity-50 transition-colors"
                >
                  {pendingReply === "ynb" ? "Sending..." : "Yes, no bolus"}
                </button>
                <button
                  type="button"
                  disabled={!!pendingReply}
                  onClick={() => send({ kind: "chip", ateSomething: false }, "no")}
                  className="px-2.5 py-1 rounded-full text-xs font-medium bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:text-[var(--foreground)] disabled:opacity-50 transition-colors"
                >
                  {pendingReply === "no" ? "Sending..." : "No"}
                </button>
              </>
            ) : (
              BOLUS_CHIPS.map((chip) => (
                <button
                  key={chip.eatTiming}
                  type="button"
                  disabled={!!pendingReply}
                  onClick={() =>
                    send({ kind: "chip", ateSomething: true, eatTiming: chip.eatTiming }, chip.eatTiming)
                  }
                  className="px-2.5 py-1 rounded-full text-xs font-medium bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:text-[var(--foreground)] disabled:opacity-50 transition-colors"
                >
                  {pendingReply === chip.eatTiming ? "Sending..." : chip.label}
                </button>
              ))
            )}
            <button
              type="button"
              disabled={!!pendingReply}
              onClick={() => send({ kind: "dismiss" }, "dismiss")}
              className="px-2.5 py-1 rounded-full text-xs text-[var(--text-tertiary)] hover:text-[var(--foreground)] disabled:opacity-50 transition-colors"
            >
              {pendingReply === "dismiss" ? "..." : "Dismiss"}
            </button>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Or type what you ate..."
              className="flex-1 min-w-0 px-2 py-1.5 rounded-lg text-sm bg-[var(--bg-elevated)] border border-[var(--border)] text-[var(--foreground)]"
            />
            <button
              type="button"
              disabled={!text.trim() || !!pendingReply}
              onClick={() => send({ kind: "text", ateSomething: true, text: text.trim() }, "text")}
              className="px-3 py-1.5 rounded-full text-xs font-medium bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-50 transition-colors shrink-0"
            >
              {pendingReply === "text" ? "Sending..." : "Send"}
            </button>
          </div>

          {!showPhoto ? (
            <button
              type="button"
              onClick={() => setShowPhoto(true)}
              className="text-xs text-[var(--text-secondary)] hover:text-[var(--foreground)] underline"
            >
              Add photo
            </button>
          ) : (
            <PhotoEstimateField
              uploadPhoto={uploadPhoto}
              estimate={estimate}
              description={text}
              onEstimated={handlePhotoEstimated}
              compact
            />
          )}

          {error && (
            <div className="text-xs text-red-400" role="alert">
              {error}
            </div>
          )}
        </>
      )}
    </li>
  );
}

interface MealPromptsCardProps {
  episodes: MealEpisode[];
  loading: boolean;
  notPatient: boolean;
  reply: (input: ReplyInput) => Promise<ReplyResult>;
  eatingNow: () => Promise<EatingNowResult>;
  uploadPhoto: (file: File) => Promise<UploadPhotoResult>;
  estimate: (input: EstimateInput) => Promise<EstimateResult>;
}

export function MealPromptsCard({
  episodes,
  loading,
  notPatient,
  reply,
  eatingNow,
  uploadPhoto,
  estimate,
}: MealPromptsCardProps) {
  const [eatingPending, setEatingPending] = useState(false);
  const [eatingError, setEatingError] = useState<string | null>(null);
  const [showAnswered, setShowAnswered] = useState(false);

  const handleEatingNow = async () => {
    if (eatingPending) return;
    setEatingPending(true);
    setEatingError(null);
    const result = await eatingNow();
    setEatingPending(false);
    if (!result.ok && !result.notPatient) {
      setEatingError(result.error);
    }
  };

  if (loading && episodes.length === 0) return null;

  const open = episodes.filter((e) => e.status === "open" || e.status === "prompted");
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();
  const answered = episodes
    .filter(
      (e) =>
        (e.status === "answered" || e.status === "reconciled" || e.status === "closed") &&
        now - (e.answeredAt ?? e.openedAt) < RECENTLY_ANSWERED_MS
    )
    .slice(0, 10);

  return (
    <div className="rounded-2xl bg-[var(--bg-surface)] border border-[var(--border)] p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-xs text-[var(--text-secondary)] uppercase tracking-wider">
          Meal prompts
        </div>
        {!notPatient && (
          <button
            type="button"
            onClick={handleEatingNow}
            disabled={eatingPending}
            className="px-3 py-1.5 rounded-full text-xs font-medium bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-50 transition-colors"
          >
            {eatingPending ? "Logging..." : "Eating now"}
          </button>
        )}
      </div>

      {eatingError && (
        <div className="text-xs text-red-400" role="alert">
          {eatingError}
        </div>
      )}

      {open.length === 0 ? (
        <div className="text-sm text-[var(--text-secondary)]">No open prompts.</div>
      ) : (
        <ul>
          {open.map((episode) => (
            <OpenEpisodeRow
              key={episode.id}
              episode={episode}
              uploadPhoto={uploadPhoto}
              estimate={estimate}
              reply={reply}
              notPatient={notPatient}
            />
          ))}
        </ul>
      )}

      {answered.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setShowAnswered((v) => !v)}
            aria-expanded={showAnswered}
            className="text-xs text-[var(--text-secondary)] hover:text-[var(--foreground)]"
          >
            {showAnswered ? "Hide" : "Show"} recently answered ({answered.length})
          </button>
          {showAnswered && (
            <ul className="mt-2 space-y-1.5">
              {answered.map((episode) => (
                <li
                  key={episode.id}
                  className="flex items-center justify-between gap-3 text-xs py-1 border-b border-[var(--border)] last:border-0"
                >
                  <span className="text-[var(--text-secondary)] truncate">
                    {episodeCopy(episode)}
                  </span>
                  <span className="text-[var(--text-tertiary)] shrink-0">
                    {replySummary(episode)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
