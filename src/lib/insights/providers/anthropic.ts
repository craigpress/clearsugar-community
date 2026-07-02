import { LLM_LONG_TIMEOUT_MS, postJsonLongTimeout } from "./http-utils";
import { LLMNotConfiguredError } from "./errors";
import type { ChatMessage, LLMProvider } from "./types";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MODEL = "claude-sonnet-5";
const MAX_TOKENS = 8000;

function resolveConfig(): { apiKey: string; model: string } {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new LLMNotConfiguredError(
      "LLM_PROVIDER=anthropic requires ANTHROPIC_API_KEY to be set in your .env."
    );
  }
  return { apiKey, model: process.env.ANTHROPIC_MODEL || DEFAULT_MODEL };
}

function authHeaders(apiKey: string): Record<string, string> {
  return { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION };
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
}

interface AnthropicMessageResponse {
  content?: AnthropicContentBlock[];
  model?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export const anthropicProvider: LLMProvider = {
  name: "anthropic",

  async generate(systemPrompt, userMessage) {
    const { apiKey, model } = resolveConfig();
    const start = Date.now();
    const body = {
      model,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    };

    let json: AnthropicMessageResponse;
    try {
      json = (await postJsonLongTimeout(ANTHROPIC_API_URL, body, authHeaders(apiKey))) as AnthropicMessageResponse;
    } catch (e) {
      throw new Error(`anthropic error: ${e instanceof Error ? e.message : String(e)}`);
    }

    const content = (json.content || [])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("");

    const usage = json.usage;
    return {
      content,
      model: json.model || model,
      provider: "anthropic",
      tokensUsed: usage ? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) : undefined,
      durationMs: Date.now() - start,
    };
  },

  async streamChat(systemPrompt, messages: ChatMessage[]) {
    const { apiKey, model } = resolveConfig();
    const body = {
      model,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
    };

    const res = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(apiKey) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(LLM_LONG_TIMEOUT_MS),
    });

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw new Error(`anthropic stream error (${res.status}): ${text.slice(0, 500)}`);
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
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6);
          if (data === "[DONE]") continue;
          try {
            const evt = JSON.parse(data) as {
              type?: string;
              delta?: { type?: string; text?: string };
            };
            if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta" && evt.delta.text) {
              controller.enqueue(new TextEncoder().encode(evt.delta.text));
            }
          } catch {
            // skip malformed SSE line
          }
        }
      },
    });
  },
};
