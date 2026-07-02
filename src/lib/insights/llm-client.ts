/**
 * ClearSugar — LLM client abstraction
 *
 * Routes every insights/chat call through a single pluggable provider chosen
 * via the LLM_PROVIDER env var (see AGENTS.md and ./providers/):
 *
 *   - anthropic          Anthropic Messages API (api.anthropic.com)
 *   - claude-cli         Local Claude Code CLI (`claude -p`)
 *   - codex-cli          Local Codex CLI (`codex exec`)
 *   - ollama             Native Ollama /api/chat
 *   - openai-compatible  Any OpenAI-compatible /v1/chat/completions server
 *                        (LM Studio, llama.cpp, vLLM, LiteLLM, OpenRouter, ...)
 *   - none (default)     Every call throws LLMNotConfiguredError
 *
 * `modelName` on generateInsights/streamChat is a holdover from the old
 * per-request preset selector (see ./models.ts) — the active provider and its
 * model are fully determined by environment configuration, so the parameter
 * is currently unused for routing. It's kept as a parameter for source
 * compatibility with existing callers (insights/refresh and insights/chat
 * routes).
 */

import { getProvider } from "./providers";
import type { ChatMessage } from "./providers/types";
import { MODEL_OPTIONS } from "./models";

export { LLMNotConfiguredError } from "./providers/errors";

/** @deprecated Retained for source compatibility; the provider layer resolves config from env vars, not per-model objects like this. */
export interface LLMConfig {
  provider: string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  maxTokens?: number;
  temperature?: number;
  effort?: "none" | "low" | "medium" | "high" | "max";
}

export interface LLMResponse {
  content: string;
  model: string;
  provider: string;
  tokensUsed?: number;
  durationMs: number;
}

/**
 * Generate insights using the configured LLM provider (LLM_PROVIDER env var).
 * `modelName` is accepted for source compatibility with the old preset
 * selector but no longer affects routing.
 */
export async function generateInsights(
  modelName: string,
  systemPrompt: string,
  userMessage: string
): Promise<LLMResponse> {
  void modelName;
  const provider = getProvider();
  return provider.generate(systemPrompt, userMessage);
}

/**
 * Stream a chat response from the configured LLM provider (for Ask ClearSugar).
 */
export async function streamChat(
  modelName: string,
  systemPrompt: string,
  messages: Array<{ role: "user" | "assistant"; content: string }>
): Promise<ReadableStream<Uint8Array>> {
  void modelName;
  const provider = getProvider();
  return provider.streamChat(systemPrompt, messages as ChatMessage[]);
}

/** List available model presets (single source of truth: models.ts) */
export function getAvailableModels(): Array<{ id: string; label: string; provider: string }> {
  return MODEL_OPTIONS;
}
