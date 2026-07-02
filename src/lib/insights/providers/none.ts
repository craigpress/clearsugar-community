import { LLMNotConfiguredError } from "./errors";
import type { LLMProvider } from "./types";

/** Default provider when LLM_PROVIDER is unset — every call fails clearly. */
export const noneProvider: LLMProvider = {
  name: "none",

  async generate(): Promise<never> {
    throw new LLMNotConfiguredError();
  },

  async streamChat(): Promise<never> {
    throw new LLMNotConfiguredError();
  },
};
