"use client";

import { useState, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

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
}

// Same ReactMarkdown component map as the Insights report view, with print-safe
// colors that fall back to readable black on white when printed.
const MARKDOWN_COMPONENTS = {
  h1: ({ children }: { children?: React.ReactNode }) => <h1 className="text-xl font-bold mt-6 mb-3 first:mt-0">{children}</h1>,
  h2: ({ children }: { children?: React.ReactNode }) => <h2 className="text-lg font-semibold mt-6 mb-3 first:mt-0">{children}</h2>,
  h3: ({ children }: { children?: React.ReactNode }) => <h3 className="text-base font-semibold mt-5 mb-2">{children}</h3>,
  p: ({ children }: { children?: React.ReactNode }) => <p className="text-sm leading-relaxed mb-3">{children}</p>,
  strong: ({ children }: { children?: React.ReactNode }) => <strong className="font-semibold">{children}</strong>,
  em: ({ children }: { children?: React.ReactNode }) => <em className="opacity-80">{children}</em>,
  ul: ({ children }: { children?: React.ReactNode }) => <ul className="list-disc list-outside ml-4 space-y-1.5 text-sm mb-4">{children}</ul>,
  ol: ({ children }: { children?: React.ReactNode }) => <ol className="list-decimal list-outside ml-4 space-y-2 text-sm mb-4">{children}</ol>,
  li: ({ children }: { children?: React.ReactNode }) => <li className="leading-relaxed">{children}</li>,
  hr: () => <hr className="my-5 border-gray-300" />,
  code: ({ children }: { children?: React.ReactNode }) => <code className="px-1.5 py-0.5 rounded text-xs bg-gray-100">{children}</code>,
  blockquote: ({ children }: { children?: React.ReactNode }) => <blockquote className="border-l-2 pl-4 my-3 text-sm italic border-gray-400">{children}</blockquote>,
  table: ({ children }: { children?: React.ReactNode }) => <div className="overflow-x-auto mb-4"><table className="w-full text-sm border-collapse">{children}</table></div>,
  thead: ({ children }: { children?: React.ReactNode }) => <thead className="border-b border-gray-400">{children}</thead>,
  th: ({ children }: { children?: React.ReactNode }) => <th className="text-left px-3 py-2 text-xs font-semibold uppercase tracking-wider">{children}</th>,
  td: ({ children }: { children?: React.ReactNode }) => <td className="px-3 py-2 border-b border-gray-200">{children}</td>,
};

export default function ReportPage() {
  const [report, setReport] = useState<WeeklyReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [patientContext, setPatientContext] = useState("the patient");

  useEffect(() => {
    fetch("/api/insights/refresh")
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.json().catch(() => null);
          throw new Error(body?.error || `No report available (${r.status})`);
        }
        return r.json();
      })
      .then((data) => setReport(data))
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load report"))
      .finally(() => setLoading(false));

    fetch("/api/profile")
      .then((r) => (r.ok ? r.json() : null))
      .then((p: { name?: string; ageYears?: number | null; pump?: string; cgm?: string } | null) => {
        if (!p) return;
        const parts = [p.name || "the patient"];
        if (p.ageYears) parts.push(`${p.ageYears}yo, Type 1 Diabetes`);
        else parts.push("Type 1 Diabetes");
        const devices = [p.pump, p.cgm].filter(Boolean).join(" · ");
        setPatientContext([parts.join(" · "), devices].filter(Boolean).join(" · "));
      })
      .catch(() => {});
  }, []);

  const cleanedReport = report
    ? report.report.replace(/\$\\rightarrow\$/g, "→").replace(/\$([^$]+)\$/g, "$1")
    : "";

  return (
    <div className="report-root min-h-screen bg-white text-black">
      {/* Print styles — hide controls, force white background + black text,
          sensible page breaks. */}
      <style>{`
        @media print {
          .no-print { display: none !important; }
          .report-root { background: #fff !important; color: #000 !important; }
          .page-break-avoid { break-inside: avoid; }
          @page { margin: 1.5cm; }
        }
      `}</style>

      <div className="max-w-3xl mx-auto px-6 py-8">
        {/* Print control bar (hidden when printing) */}
        <div className="no-print flex items-center justify-between mb-6">
          <a href="/insights" className="text-sm text-gray-500 hover:text-black">← Back to Insights</a>
          <button
            onClick={() => window.print()}
            disabled={!report}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-black text-white disabled:opacity-40"
          >
            Print / Save as PDF
          </button>
        </div>

        {loading && <div className="text-sm text-gray-500">Loading report…</div>}
        {error && !loading && (
          <div className="text-sm text-red-600">
            {error} — generate one from the Insights tab first.
          </div>
        )}

        {report && (
          <>
            {/* Header */}
            <header className="mb-6 pb-4 border-b border-gray-300 page-break-avoid">
              <h1 className="text-2xl font-bold mb-1">ClearSugar Glucose Report</h1>
              <div className="text-sm text-gray-700">{patientContext}</div>
              <div className="text-xs text-gray-600 mt-2">
                {report.period}
                {" · "}Generated {new Date(report.generatedAt).toLocaleString()}
                {report.model && report.model !== "fallback" && <> · Model: {report.model}</>}
              </div>
            </header>

            {/* Summary stats */}
            <section className="mb-6 page-break-avoid">
              <div className="grid grid-cols-5 gap-3 text-center">
                <SummaryStat label="TIR" value={`${report.summary.tir}%`} />
                <SummaryStat label="Mean" value={`${report.summary.mean}`} unit="mg/dL" />
                <SummaryStat label="GMI" value={`${report.summary.gmi}%`} />
                <SummaryStat label="Low" value={`${report.summary.low}%`} />
                <SummaryStat
                  label="High"
                  value={`${report.summary.high + report.summary.veryHigh}%`}
                />
              </div>
              <div className="text-[11px] text-gray-500 mt-2 text-center">
                {report.summary.readings.toLocaleString()} readings analyzed
              </div>
            </section>

            {/* AI report markdown */}
            <section className="mb-8">
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
                {cleanedReport}
              </ReactMarkdown>
            </section>

            {/* Rule-based patterns */}
            {report.patterns.length > 0 && (
              <section className="mb-8">
                <h2 className="text-lg font-semibold mb-3">Detected Patterns</h2>
                <div className="space-y-3">
                  {report.patterns.map((p) => (
                    <div key={p.id} className="page-break-avoid border border-gray-300 rounded-lg p-3">
                      <div className="font-medium text-sm mb-1">
                        <span className="uppercase text-[10px] tracking-wider text-gray-500 mr-2">
                          {p.severity}
                        </span>
                        {p.title}
                      </div>
                      <div className="text-sm text-gray-700 mb-1">{p.description}</div>
                      <div className="text-sm text-gray-800">→ {p.suggestion}</div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            <footer className="text-[11px] text-gray-500 border-t border-gray-300 pt-4">
              Generated by AI analysis of glucose data patterns. Not medical advice —
              discuss any changes with your endocrinologist.
            </footer>
          </>
        )}
      </div>
    </div>
  );
}

function SummaryStat({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="border border-gray-300 rounded-lg py-2 page-break-avoid">
      <div className="text-[10px] uppercase tracking-wider text-gray-500">{label}</div>
      <div className="text-lg font-semibold tabular-nums">
        {value}
        {unit && <span className="text-[10px] text-gray-500 ml-0.5">{unit}</span>}
      </div>
    </div>
  );
}
