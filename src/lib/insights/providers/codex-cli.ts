import { runCli } from "./cli-utils";
import type { LLMProvider } from "./types";

// `codex exec` mainly prints the final answer to stdout, but some builds
// prefix a few structured log/status lines first. Strip a contiguous run of
// clearly log-shaped leading lines (timestamps, [LEVEL] tags); if nothing
// matches, return stdout unchanged rather than risk eating real content.
const LOG_LINE = /^\s*(\[\d{4}-\d{2}-\d{2}[^\]]*\]|\d{4}-\d{2}-\d{2}T\S*|\[(INFO|DEBUG|WARN|WARNING|ERROR|TRACE)\]|(INFO|DEBUG|WARN|WARNING|ERROR|TRACE):)/i;

function stripLeadingLogLines(output: string): string {
  const lines = output.split("\n");
  let i = 0;
  while (i < lines.length && LOG_LINE.test(lines[i])) i++;
  if (i === 0 || i >= lines.length) return output;
  return lines.slice(i).join("\n").trim();
}

export const codexCliProvider: LLMProvider = {
  name: "codex-cli",

  async generate(systemPrompt, userMessage) {
    const start = Date.now();
    const cliPath = process.env.CODEX_CLI_PATH || "codex";
    const prompt = `${systemPrompt}\n\n${userMessage}`;
    const stdout = await runCli(cliPath, ["exec"], prompt);
    return {
      content: stripLeadingLogLines(stdout.trim()),
      model: "codex-cli",
      provider: "codex-cli",
      durationMs: Date.now() - start,
    };
  },

  // `codex exec` is non-streaming; emit the full result as one chunk.
  async streamChat(systemPrompt, messages) {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const userMessage = lastUser?.content ?? "";
    const result = await codexCliProvider.generate(systemPrompt, userMessage);
    return new ReadableStream<Uint8Array>({
      start(controller) {
        if (result.content) controller.enqueue(new TextEncoder().encode(result.content));
        controller.close();
      },
    });
  },
};
