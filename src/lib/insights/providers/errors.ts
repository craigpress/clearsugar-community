/**
 * Thrown by every provider method when the required environment
 * configuration for the active (or missing) LLM_PROVIDER is absent or
 * invalid. The message is written to be shown directly to the user/operator
 * (consumers already catch and surface LLM errors as-is).
 */
export class LLMNotConfiguredError extends Error {
  constructor(message = "AI insights are not configured. Set LLM_PROVIDER in your .env.") {
    super(message);
    this.name = "LLMNotConfiguredError";
  }
}
