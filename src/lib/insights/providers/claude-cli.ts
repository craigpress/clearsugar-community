import { runCli } from "./cli-utils";
import type { LLMProvider } from "./types";

export const claudeCliProvider: LLMProvider = {
  name: "claude-cli",

  async generate(systemPrompt, userMessage) {
    const start = Date.now();
    const cliPath = process.env.CLAUDE_CLI_PATH || "claude";
    const prompt = `${systemPrompt}\n\n${userMessage}`;
    const stdout = await runCli(cliPath, ["-p", "--output-format", "text"], prompt);
    return {
      content: stdout.trim(),
      model: "claude-cli",
      provider: "claude-cli",
      durationMs: Date.now() - start,
    };
  },

  // The Claude Code CLI is non-streaming (a single `-p` invocation runs to
  // completion); emit the full result as one chunk so the chat route's
  // ReadableStream contract still works.
  async streamChat(systemPrompt, messages) {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const userMessage = lastUser?.content ?? "";
    const result = await claudeCliProvider.generate(systemPrompt, userMessage);
    return new ReadableStream<Uint8Array>({
      start(controller) {
        if (result.content) controller.enqueue(new TextEncoder().encode(result.content));
        controller.close();
      },
    });
  },
};
