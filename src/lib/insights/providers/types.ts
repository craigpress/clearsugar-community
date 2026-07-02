// Shared types for the pluggable LLM provider layer (see providers/index.ts).

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface GenerateResult {
  content: string;
  model: string;
  provider: string;
  tokensUsed?: number;
  durationMs: number;
}

export interface LLMProvider {
  readonly name: string;
  /** Single-shot completion for the weekly/periodic insights report. */
  generate(systemPrompt: string, userMessage: string): Promise<GenerateResult>;
  /** Streamed completion for the Ask ClearSugar chat UI. */
  streamChat(systemPrompt: string, messages: ChatMessage[]): Promise<ReadableStream<Uint8Array>>;
}
