import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { streamChat } from "@/lib/insights/llm-client";
import { buildAskSystemPrompt } from "@/lib/insights/chat-prompt";
import { loadLatestReport } from "@/lib/insights/report-store";
import { DEFAULT_INSIGHTS_MODEL } from "@/lib/insights/models";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const denied = await requireApiAuth(req);
  if (denied) return denied;

  try {
    const body = await req.json();
    const messages: Array<{ role: "user" | "assistant"; content: string }> = body.messages || [];
    const model: string = body.model || DEFAULT_INSIGHTS_MODEL;

    if (messages.length === 0) {
      return NextResponse.json({ error: "No messages provided" }, { status: 400 });
    }

    // Load latest report for context
    let reportContext: string | undefined;
    let inputData: unknown;
    try {
      const report = await loadLatestReport();
      if (report) {
        reportContext = report.report;
        inputData = report.inputData;
      }
    } catch {
      // No report available — chat still works, just without data context
    }

    const systemPrompt = await buildAskSystemPrompt(reportContext, inputData);
    const stream = await streamChat(model, systemPrompt, messages);

    return new Response(stream, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Transfer-Encoding": "chunked",
        "Cache-Control": "no-cache",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
