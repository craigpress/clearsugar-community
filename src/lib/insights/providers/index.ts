import { anthropicProvider } from "./anthropic";
import { claudeCliProvider } from "./claude-cli";
import { codexCliProvider } from "./codex-cli";
import { ollamaProvider } from "./ollama";
import { openAICompatibleProvider } from "./openai-compatible";
import { noneProvider } from "./none";
import { LLMNotConfiguredError } from "./errors";
import type { LLMProvider } from "./types";

export type { ChatMessage, GenerateResult, LLMProvider } from "./types";
export { LLMNotConfiguredError } from "./errors";

const KNOWN_PROVIDERS = ["anthropic", "claude-cli", "codex-cli", "ollama", "openai-compatible", "none"] as const;

/** Select the active LLM provider based on process.env.LLM_PROVIDER. */
export function getProvider(): LLMProvider {
  const raw = process.env.LLM_PROVIDER;
  const name = raw && raw.trim() ? raw.trim() : "none";

  switch (name) {
    case "anthropic":
      return anthropicProvider;
    case "claude-cli":
      return claudeCliProvider;
    case "codex-cli":
      return codexCliProvider;
    case "ollama":
      return ollamaProvider;
    case "openai-compatible":
      return openAICompatibleProvider;
    case "none":
      return noneProvider;
    default:
      throw new LLMNotConfiguredError(
        `Unknown LLM_PROVIDER "${name}". Set LLM_PROVIDER to one of: ${KNOWN_PROVIDERS.join(", ")}.`
      );
  }
}
