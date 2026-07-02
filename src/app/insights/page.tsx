"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AppHeader } from "@/components/layout/AppHeader";

const INSIGHTS_PREFS_KEY = "clearsugar.insights.prefs";

interface Pattern {
  id: string;
  title: string;
  severity: "positive" | "low" | "moderate" | "high";
  description: string;
  suggestion: string;
}

interface WeeklyReport {
  generatedAt: string;
  days?: number;
  period: string;
  model?: string;
  provider?: string;
  durationMs?: number;
  summary: {
    readings: number;
    mean: number;
    tir: number;
    gmi: number;
    low: number;
    veryLow: number;
    high: number;
    veryHigh: number;
  };
  report: string;
  patterns: Pattern[];
  dataConsistencyWarning?: string;
  profileChanges?: Array<{ date: string; changes: string[] }>;
}

export { MODEL_OPTIONS } from "@/lib/insights/models";
import { MODEL_OPTIONS, DEFAULT_INSIGHTS_MODEL } from "@/lib/insights/models";

const SEVERITY_STYLES: Record<
  Pattern["severity"],
  { bg: string; border: string; icon: string; text: string }
> = {
  positive: {
    bg: "bg-emerald-500/5",
    border: "border-emerald-500/15",
    icon: "✓",
    text: "text-emerald-400",
  },
  low: {
    bg: "bg-[var(--bg-elevated)]",
    border: "border-[var(--border)]",
    icon: "○",
    text: "text-[var(--text-secondary)]",
  },
  moderate: {
    bg: "bg-amber-500/5",
    border: "border-amber-500/15",
    icon: "◐",
    text: "text-amber-400",
  },
  high: {
    bg: "bg-red-500/5",
    border: "border-red-500/15",
    icon: "●",
    text: "text-red-400",
  },
};

export default function InsightsPage() {
  const [report, setReport] = useState<WeeklyReport | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  // Default 90 days — long windows are where the AI analysis works best;
  // the report also self-compares the most recent 14 days vs the full period.
  const [days, setDays] = useState(90);
  const [model, setModel] = useState(DEFAULT_INSIGHTS_MODEL);
  const [activeTab, setActiveTab] = useState<"report" | "patterns" | "ask">(
    "report"
  );

  // Restore persisted days/model prefs on mount (guard SSR)
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(INSIGHTS_PREFS_KEY);
      if (raw) {
        const prefs = JSON.parse(raw);
        if (typeof prefs.days === "number") setDays(prefs.days);
        if (typeof prefs.model === "string") setModel(prefs.model);
      }
    } catch {
      // Ignore malformed/blocked storage
    }
  }, []);

  // Persist days/model prefs
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(INSIGHTS_PREFS_KEY, JSON.stringify({ days, model }));
    } catch {
      // Ignore quota/blocked storage
    }
  }, [days, model]);

  // Load cached report from API on mount
  useEffect(() => {
    fetch("/api/insights/refresh")
      .then((r) => {
        if (!r.ok) return null;
        return r.json();
      })
      .then((data) => {
        if (data) {
          setReport(data);
          // Sync selectors to what generated the displayed report.
          if (typeof data.days === "number") setDays(data.days);
          if (typeof data.model === "string" && data.model !== "fallback") {
            if (MODEL_OPTIONS.some((m) => m.id === data.model)) setModel(data.model);
          }
        }
      })
      .catch(() => {});
  }, []);

  // Refresh insights on demand — pulls live data and recomputes
  const handleRefresh = async () => {
    setIsRefreshing(true);
    setRefreshError(null);
    try {
      const res = await fetch(`/api/insights/refresh?days=${days}&model=${model}`, { method: "POST" });
      if (res.ok) {
        // The route streams keepalive whitespace while the LLM generates, then the
        // final JSON. res.json() buffers the whole body and ignores leading
        // whitespace. An in-stream failure arrives as {error} with a 200 status.
        const freshReport = await res.json();
        if (freshReport?.error) {
          setRefreshError(freshReport.error);
        } else {
          setReport(freshReport);
        }
      } else {
        const body = await res.json().catch(() => null);
        setRefreshError(body?.error || `Refresh failed (${res.status})`);
      }
    } catch {
      setRefreshError("Network error — could not reach server");
    } finally {
      setIsRefreshing(false);
    }
  };

  return (
    <div className="min-h-screen bg-[var(--background)]">
      <AppHeader />

      <main className="max-w-4xl mx-auto px-4 py-6 space-y-6">
        {/* Sub-tabs + refresh button */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1">
            {[
              { key: "report" as const, label: "Weekly Report" },
              { key: "patterns" as const, label: "Patterns" },
              { key: "ask" as const, label: "Ask ClearSugar" },
            ].map((tab) => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  activeTab === tab.key
                    ? "bg-[var(--accent)] text-white"
                    : "text-[var(--text-secondary)] hover:text-[var(--foreground)] hover:bg-[var(--bg-elevated)]"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <select
              value={days}
              onChange={(e) => setDays(parseInt(e.target.value))}
              className="px-2 py-1.5 rounded-lg text-xs bg-[var(--bg-elevated)] border border-[var(--border)] text-[var(--foreground)]"
            >
              <option value={7}>7 days</option>
              <option value={14}>14 days</option>
              <option value={30}>30 days</option>
              <option value={60}>60 days</option>
              <option value={90}>90 days</option>
            </select>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="px-2 py-1.5 rounded-lg text-xs bg-[var(--bg-elevated)] border border-[var(--border)] text-[var(--foreground)]"
            >
              {MODEL_OPTIONS.map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
            <button
              onClick={handleRefresh}
              disabled={isRefreshing}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                isRefreshing
                  ? "bg-[var(--bg-elevated)] text-[var(--text-secondary)] cursor-wait"
                  : "bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)]"
              }`}
            >
              {isRefreshing ? "Analyzing..." : "Refresh Insights"}
            </button>
            <Link
              href="/report"
              className="px-3 py-1.5 rounded-lg text-xs font-medium border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--foreground)] hover:bg-[var(--bg-elevated)] transition-colors"
              title="Open a print-friendly report for your endocrinologist"
            >
              Export
            </Link>
          </div>
        </div>

        {refreshError && (
          <div className="rounded-xl bg-red-500/10 border border-red-500/20 px-4 py-3 text-sm text-red-400">
            {refreshError}
          </div>
        )}

        {!report ? (
          <div className="flex flex-col items-center justify-center h-64 gap-3 text-[var(--text-secondary)]">
            <div className="text-4xl opacity-20">📊</div>
            <div className="text-sm">No insights yet — select a date range and click Refresh Insights</div>
          </div>
        ) : (
          <>
            {activeTab === "report" && <ReportView report={report} />}
            {activeTab === "patterns" && (
              <PatternsView patterns={report.patterns} />
            )}
            {activeTab === "ask" && <AskView reportModel={report.model} />}
          </>
        )}
      </main>
    </div>
  );
}

// Estimate CGM coverage from the report summary. Raw timestamped readings
// aren't available client-side here, so this uses the readings count against an
// expected 288/day (one Dexcom reading per 5 min). Only shown when days known.
function coverageNote(report: WeeklyReport): { text: string; warn: boolean } | null {
  const actual = report.summary?.readings;
  if (typeof actual !== "number" || actual <= 0) return null;
  if (!report.days || report.days <= 0) {
    return { text: `${actual.toLocaleString()} readings`, warn: false };
  }
  const expected = report.days * 288;
  const pct = Math.min(100, Math.round((actual / expected) * 100));
  return {
    text: `CGM active ${pct}% (${actual.toLocaleString()} of ~${expected.toLocaleString()} expected readings)`,
    warn: pct < 70,
  };
}

function ReportView({ report }: { report: WeeklyReport }) {
  // Clean up any LaTeX artifacts from the LLM
  const cleanedReport = report.report
    .replace(/\$\\rightarrow\$/g, "→")
    .replace(/\$([^$]+)\$/g, "$1");

  return (
    <div className="space-y-4">
      {/* Summary banner */}
      <div className="rounded-2xl bg-[var(--bg-surface)] border border-[var(--border)] p-5">
        <div className="flex items-center justify-between mb-4">
          <div>
            <div className="text-xs text-[var(--text-secondary)] uppercase tracking-wider">
              AI {report.days && report.days > 7 ? `${report.days}-Day` : "Weekly"} Report
            </div>
            <div className="text-[11px] text-[var(--text-secondary)] mt-0.5">
              {report.period} · Generated{" "}
              {new Date(report.generatedAt).toLocaleDateString()}
              {report.model && report.model !== "fallback" && (
                <span className="ml-1 opacity-60">
                  · {report.model}{report.durationMs ? ` (${(report.durationMs / 1000).toFixed(1)}s)` : ""}
                </span>
              )}
            </div>
          </div>
          <div className="flex items-baseline gap-1">
            <span className="text-3xl font-semibold tabular-nums text-[var(--glucose-in-range)]">
              {report.summary.tir}%
            </span>
            <span className="text-sm text-[var(--text-secondary)]">TIR</span>
          </div>
        </div>

        <div className="grid grid-cols-4 gap-3">
          <MiniStat label="Mean" value={report.summary.mean} unit="mg/dL" />
          <MiniStat label="GMI" value={report.summary.gmi} unit="%" />
          <MiniStat label="Lows" value={`${report.summary.low}%`} />
          <MiniStat label="Highs" value={`${report.summary.high + report.summary.veryHigh}%`} />
        </div>

        {/* Pump settings changes detected within the period — the report was
            told to compare before/after and anchor advice on current settings */}
        {report.profileChanges && report.profileChanges.length > 0 && (
          <div className="mt-3 rounded-lg bg-[var(--accent)]/10 border border-[var(--accent)]/20 px-3 py-2 text-[11px] text-[var(--text-secondary)]">
            <span className="font-medium text-[var(--foreground)]">
              ⚙ Pump settings changed during this period:
            </span>{" "}
            {report.profileChanges
              .map((ev) => `${ev.date} (${ev.changes.length} change${ev.changes.length > 1 ? "s" : ""})`)
              .join(" · ")}
            <span className="opacity-70">
              {" "}
              — the analysis compares before/after and bases recommendations on
              current settings.
            </span>
          </div>
        )}

        {/* CGM coverage note — computed from the report summary. Raw readings
            aren't available here, so we estimate against an expected 288/day. */}
        {(() => {
          const note = coverageNote(report);
          if (!note) return null;
          return (
            <div className={`mt-3 text-[11px] ${note.warn ? "text-amber-400" : "text-[var(--text-secondary)] opacity-60"}`}>
              {note.text}
            </div>
          );
        })()}
      </div>

      {/* Data-consistency warning (item 15) — amber banner above the report */}
      {report.dataConsistencyWarning && (
        <div className="rounded-2xl border border-amber-500/40 bg-amber-500/10 text-amber-300 text-sm p-4">
          {report.dataConsistencyWarning}
        </div>
      )}

      {/* Report content — proper markdown rendering */}
      <div className="rounded-2xl bg-[var(--bg-surface)] border border-[var(--border)] p-5">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            h1: ({ children }) => <h1 className="text-xl font-bold mt-6 mb-3 first:mt-0 text-[var(--foreground)]">{children}</h1>,
            h2: ({ children }) => <h2 className="text-lg font-semibold mt-6 mb-3 first:mt-0 text-[var(--foreground)]">{children}</h2>,
            h3: ({ children }) => <h3 className="text-base font-semibold mt-5 mb-2 text-[var(--foreground)]">{children}</h3>,
            p: ({ children }) => <p className="text-sm text-[var(--text-secondary)] leading-relaxed mb-3">{children}</p>,
            strong: ({ children }) => <strong className="text-[var(--foreground)] font-semibold">{children}</strong>,
            em: ({ children }) => <em className="opacity-80">{children}</em>,
            ul: ({ children }) => <ul className="list-disc list-outside ml-4 space-y-1.5 text-sm text-[var(--text-secondary)] mb-4">{children}</ul>,
            ol: ({ children }) => <ol className="list-decimal list-outside ml-4 space-y-2 text-sm text-[var(--text-secondary)] mb-4">{children}</ol>,
            li: ({ children }) => <li className="leading-relaxed">{children}</li>,
            hr: () => <hr className="border-[var(--border)] my-5" />,
            code: ({ children }) => <code className="bg-[var(--bg-elevated)] px-1.5 py-0.5 rounded text-xs">{children}</code>,
            blockquote: ({ children }) => <blockquote className="border-l-2 border-[var(--accent)] pl-4 my-3 text-sm text-[var(--text-secondary)] italic">{children}</blockquote>,
            table: ({ children }) => <div className="overflow-x-auto mb-4"><table className="w-full text-sm border-collapse">{children}</table></div>,
            thead: ({ children }) => <thead className="border-b border-[var(--border)]">{children}</thead>,
            th: ({ children }) => <th className="text-left px-3 py-2 text-xs font-semibold text-[var(--foreground)] uppercase tracking-wider">{children}</th>,
            td: ({ children }) => <td className="px-3 py-2 text-[var(--text-secondary)] border-b border-[var(--border)]/50">{children}</td>,
          }}
        >
          {cleanedReport}
        </ReactMarkdown>
      </div>

      <div className="rounded-2xl bg-amber-500/5 border border-amber-500/10 p-4 text-xs text-[var(--text-secondary)]">
        This report is generated by AI analysis of glucose data patterns. It
        is not medical advice. Always discuss changes with your endocrinologist.
      </div>
    </div>
  );
}

function PatternsView({ patterns }: { patterns: Pattern[] }) {

  // Sort: high → moderate → low → positive
  const order: Pattern["severity"][] = ["high", "moderate", "low", "positive"];
  const sorted = [...patterns].sort(
    (a, b) => order.indexOf(a.severity) - order.indexOf(b.severity)
  );

  return (
    <div className="space-y-3">
      {sorted.map((p) => {
        const style = SEVERITY_STYLES[p.severity];
        return (
          <div
            key={p.id}
            className={`rounded-2xl ${style.bg} border ${style.border} p-4`}
          >
            <div className="flex items-start gap-3">
              <span className={`text-lg ${style.text} mt-0.5`}>
                {style.icon}
              </span>
              <div className="flex-1">
                <div className="font-medium mb-1">{p.title}</div>
                <div className="text-sm text-[var(--text-secondary)] leading-relaxed mb-2">
                  {p.description}
                </div>
                <div className="text-sm text-[var(--foreground)] opacity-80">
                  💬 {p.suggestion}
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

function AskView({ reportModel }: { reportModel?: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  // Chat picks its own model, defaulting to the report's model when valid.
  const [chatModel, setChatModel] = useState(() =>
    reportModel && MODEL_OPTIONS.some((m) => m.id === reportModel)
      ? reportModel
      : DEFAULT_INSIGHTS_MODEL
  );
  const chatEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Abort any in-flight stream on unmount (e.g. navigating away).
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const scrollToBottom = () => {
    setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
  };

  const suggestedQuestions = [
    "Why was last night so bad?",
    "Which days are worst and why?",
    "Is his morning basal correct?",
    "How effective are his corrections?",
    "What should we discuss at the next endo visit?",
    "Are there signs of illness in the data?",
  ];

  const sendMessage = async (text: string) => {
    if (!text.trim() || isStreaming) return;

    const userMsg: ChatMessage = { role: "user", content: text.trim() };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput("");
    setIsStreaming(true);
    scrollToBottom();

    // Abort any previous in-flight stream before starting a new send.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch("/api/insights/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: newMessages, model: chatModel }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({ error: "Request failed" }));
        setMessages([...newMessages, { role: "assistant", content: `Error: ${err.error}` }]);
        setIsStreaming(false);
        return;
      }

      // Stream the response
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let assistantContent = "";

      setMessages([...newMessages, { role: "assistant", content: "" }]);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        assistantContent += decoder.decode(value, { stream: true });
        setMessages([...newMessages, { role: "assistant", content: assistantContent }]);
        scrollToBottom();
      }
    } catch (err) {
      // Aborts are intentional (new message / unmount) — handle silently.
      if (err instanceof DOMException && err.name === "AbortError") {
        return;
      }
      setMessages([...newMessages, { role: "assistant", content: "AI provider unreachable — check your LLM_PROVIDER settings." }]);
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setIsStreaming(false);
    }
  };

  return (
    <div className="flex flex-col" style={{ minHeight: "60vh" }}>
      {/* Chat messages */}
      <div className="flex-1 space-y-3 mb-4">
        {messages.length === 0 && (
          <div className="space-y-4">
            <div className="rounded-2xl bg-[var(--bg-surface)] border border-[var(--border)] p-6 text-center">
              <div className="text-4xl mb-3 opacity-20">💬</div>
              <div className="text-lg font-medium mb-2">Ask ClearSugar</div>
              <div className="text-sm text-[var(--text-secondary)]">
                Ask questions about the patient&apos;s glucose data. Powered by local AI.
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              {suggestedQuestions.map((q) => (
                <button
                  key={q}
                  onClick={() => sendMessage(q)}
                  className="rounded-full px-3 py-1.5 text-xs bg-[var(--accent)]/10 text-[var(--accent)] border border-[var(--accent)]/20 hover:bg-[var(--accent)]/20 transition-colors"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-[85%] rounded-2xl px-4 py-3 ${
                msg.role === "user"
                  ? "rounded-br-md bg-[var(--accent)] text-white"
                  : "rounded-bl-md bg-[var(--bg-surface)] border border-[var(--border)]"
              }`}
            >
              {msg.role === "assistant" && (
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-5 h-5 rounded-full bg-[var(--accent)] flex items-center justify-center text-[10px] text-white font-bold">
                    CS
                  </div>
                  <span className="text-xs text-[var(--text-secondary)]">ClearSugar</span>
                </div>
              )}
              {msg.role === "assistant" ? (
                <div className="text-sm leading-relaxed text-[var(--text-secondary)] [&_strong]:text-[var(--foreground)] [&_strong]:font-semibold [&_p]:mb-2 [&_ul]:list-disc [&_ul]:ml-4 [&_ol]:list-decimal [&_ol]:ml-4 [&_li]:mb-1 [&_h3]:font-semibold [&_h3]:text-[var(--foreground)] [&_h3]:mt-3 [&_h3]:mb-1 [&_hr]:border-[var(--border)] [&_hr]:my-3">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {msg.content || "Thinking..."}
                  </ReactMarkdown>
                </div>
              ) : (
                <div className="text-sm leading-relaxed">{msg.content}</div>
              )}
            </div>
          </div>
        ))}

        {isStreaming && messages[messages.length - 1]?.content === "" && (
          <div className="flex justify-start">
            <div className="rounded-2xl rounded-bl-md bg-[var(--bg-surface)] border border-[var(--border)] px-4 py-3">
              <div className="flex items-center gap-1.5">
                <div className="w-2 h-2 rounded-full bg-[var(--accent)] animate-pulse" />
                <div className="w-2 h-2 rounded-full bg-[var(--accent)] animate-pulse [animation-delay:0.2s]" />
                <div className="w-2 h-2 rounded-full bg-[var(--accent)] animate-pulse [animation-delay:0.4s]" />
              </div>
            </div>
          </div>
        )}

        <div ref={chatEndRef} />
      </div>

      {/* Input */}
      <div className="sticky bottom-0 bg-[var(--background)] pt-2 pb-4">
        <div className="flex items-center justify-end gap-1.5 mb-2">
          <span className="text-[10px] text-[var(--text-secondary)] opacity-60">Model</span>
          <select
            value={chatModel}
            onChange={(e) => setChatModel(e.target.value)}
            disabled={isStreaming}
            className="px-2 py-1 rounded-lg text-[11px] bg-[var(--bg-elevated)] border border-[var(--border)] text-[var(--foreground)] disabled:opacity-50"
          >
            {MODEL_OPTIONS.map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
        </div>
        <form
          onSubmit={(e) => { e.preventDefault(); sendMessage(input); }}
          className="flex gap-2"
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask about the patient's glucose patterns..."
            disabled={isStreaming}
            className="flex-1 rounded-xl bg-[var(--bg-surface)] border border-[var(--border)] px-4 py-3 text-sm text-[var(--foreground)] placeholder:text-[var(--text-secondary)] focus:outline-none focus:border-[var(--accent)]"
          />
          <button
            type="submit"
            disabled={isStreaming || !input.trim()}
            className="px-4 py-3 rounded-xl bg-[var(--accent)] text-white text-sm font-medium disabled:opacity-40 hover:bg-[var(--accent-hover)] transition-colors"
          >
            Send
          </button>
        </form>
        <div className="text-[10px] text-[var(--text-secondary)] text-center mt-2 opacity-60">
          Powered by local AI — not medical advice
        </div>
      </div>
    </div>
  );
}

function MiniStat({
  label,
  value,
  unit,
}: {
  label: string;
  value: string | number;
  unit?: string;
}) {
  return (
    <div className="text-center">
      <div className="text-[10px] text-[var(--text-secondary)] uppercase tracking-wider">
        {label}
      </div>
      <div className="flex items-baseline justify-center gap-0.5">
        <span className="text-lg font-semibold tabular-nums">{value}</span>
        {unit && (
          <span className="text-[10px] text-[var(--text-secondary)]">
            {unit}
          </span>
        )}
      </div>
    </div>
  );
}

