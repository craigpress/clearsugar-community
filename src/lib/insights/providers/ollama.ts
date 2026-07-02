import { LLM_LONG_TIMEOUT_MS, postJsonLongTimeout } from "./http-utils";
import { LLMNotConfiguredError } from "./errors";
import type { LLMProvider } from "./types";

const DEFAULT_URL = "http://localhost:11434";

function resolveConfig(): { baseUrl: string; model: string } {
  const model = process.env.OLLAMA_MODEL;
  if (!model) {
    throw new LLMNotConfiguredError("LLM_PROVIDER=ollama requires OLLAMA_MODEL to be set in your .env.");
  }
  return { baseUrl: process.env.OLLAMA_URL || DEFAULT_URL, model };
}

interface OllamaChatResponse {
  message?: { content?: string };
  model?: string;
  eval_count?: number;
}

export const ollamaProvider: LLMProvider = {
  name: "ollama",

  async generate(systemPrompt, userMessage) {
    const { baseUrl, model } = resolveConfig();
    const start = Date.now();
    const body = {
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      stream: false,
    };

    let json: OllamaChatResponse;
    try {
      json = (await postJsonLongTimeout(`${baseUrl}/api/chat`, body)) as OllamaChatResponse;
    } catch (e) {
      throw new Error(`ollama error: ${e instanceof Error ? e.message : String(e)}`);
    }

    return {
      content: json.message?.content || "",
      model: json.model || model,
      provider: "ollama",
      tokensUsed: json.eval_count,
      durationMs: Date.now() - start,
    };
  },

  async streamChat(systemPrompt, messages) {
    const { baseUrl, model } = resolveConfig();
    const body = {
      model,
      messages: [{ role: "system", content: systemPrompt }, ...messages],
      stream: true,
    };

    const res = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(LLM_LONG_TIMEOUT_MS),
    });

    if (!res.ok || !res.body) {
      throw new Error(`ollama stream error (${res.status})`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const evt = JSON.parse(trimmed) as { message?: { content?: string }; done?: boolean };
            const text = evt.message?.content;
            if (text) controller.enqueue(new TextEncoder().encode(text));
            if (evt.done) {
              controller.close();
              return;
            }
          } catch {
            // skip malformed JSONL line
          }
        }
      },
    });
  },
};
