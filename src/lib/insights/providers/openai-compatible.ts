import { LLM_LONG_TIMEOUT_MS, postJsonLongTimeout } from "./http-utils";
import { LLMNotConfiguredError } from "./errors";
import type { LLMProvider } from "./types";

// Covers LM Studio, llama.cpp, vLLM, LiteLLM, OpenRouter, and anything else
// speaking the OpenAI /v1/chat/completions wire format.

function resolveConfig(): { baseUrl: string; model: string; apiKey?: string } {
  const baseUrl = process.env.OPENAI_COMPAT_URL;
  if (!baseUrl) {
    throw new LLMNotConfiguredError(
      "LLM_PROVIDER=openai-compatible requires OPENAI_COMPAT_URL to be set in your .env."
    );
  }
  const model = process.env.OPENAI_COMPAT_MODEL;
  if (!model) {
    throw new LLMNotConfiguredError(
      "LLM_PROVIDER=openai-compatible requires OPENAI_COMPAT_MODEL to be set in your .env."
    );
  }
  return { baseUrl, model, apiKey: process.env.OPENAI_COMPAT_API_KEY };
}

function authHeaders(apiKey?: string): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

interface OpenAICompatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  model?: string;
  usage?: { total_tokens?: number };
}

export const openAICompatibleProvider: LLMProvider = {
  name: "openai-compatible",

  async generate(systemPrompt, userMessage) {
    const { baseUrl, model, apiKey } = resolveConfig();
    const start = Date.now();
    const body = {
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      stream: false,
    };

    let json: OpenAICompatResponse;
    try {
      json = (await postJsonLongTimeout(
        `${baseUrl}/v1/chat/completions`,
        body,
        authHeaders(apiKey)
      )) as OpenAICompatResponse;
    } catch (e) {
      throw new Error(`openai-compatible error: ${e instanceof Error ? e.message : String(e)}`);
    }

    return {
      content: json.choices?.[0]?.message?.content || "",
      model: json.model || model,
      provider: "openai-compatible",
      tokensUsed: json.usage?.total_tokens,
      durationMs: Date.now() - start,
    };
  },

  async streamChat(systemPrompt, messages) {
    const { baseUrl, model, apiKey } = resolveConfig();
    const body = {
      model,
      messages: [{ role: "system", content: systemPrompt }, ...messages],
      stream: true,
    };

    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(apiKey) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(LLM_LONG_TIMEOUT_MS),
    });

    if (!res.ok || !res.body) {
      throw new Error(`openai-compatible stream error (${res.status})`);
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
          if (data === "[DONE]") {
            controller.close();
            return;
          }
          try {
            const evt = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
            const text = evt.choices?.[0]?.delta?.content;
            if (text) controller.enqueue(new TextEncoder().encode(text));
          } catch {
            // skip malformed SSE chunk
          }
        }
      },
    });
  },
};
