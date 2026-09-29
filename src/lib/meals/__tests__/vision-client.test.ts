import { describe, it, expect, vi } from "vitest";
import {
  VISION_SYSTEM_PROMPT,
  VISION_TIMEOUT_MS,
  VisionOutputError,
  VisionUnavailableError,
  estimateNutrition,
  extractFirstJsonObject,
  type PostJsonOptions,
} from "@/lib/insights/vision-client";

/**
 * The HTTP layer is injected, so nothing here opens a socket. `calls` captures
 * exactly what would have gone to the provider, which is the half of this module that
 * the route cannot test.
 */
const NOW = Date.parse("2026-09-04T18:00:00.000Z");

const GOOD_JSON = {
  carbs: { low: 45, mid: 60, high: 80 },
  protein: 24,
  fat: 18,
  fiber: 3,
  giClass: "high",
  confidence: 0.55,
  items: [{ name: "cheese pizza", portion: "2 slices", carbs: 58 }],
  notes: "thin crust, no visible drink",
};

function reply(content: string, model = "claude-vision-1") {
  return { model, choices: [{ message: { content } }] };
}

function harness(
  responder: (opts: PostJsonOptions) => unknown | Promise<unknown> = () =>
    reply(JSON.stringify(GOOD_JSON))
) {
  const calls: PostJsonOptions[] = [];
  let tick = 0;
  const post = vi.fn(async (opts: PostJsonOptions) => {
    calls.push(opts);
    return responder(opts);
  });
  // 1st call = start, 2nd = after the POST, 3rd = estimatedAt
  const now = () => NOW + tick++ * 100;
  return { calls, post, deps: { post, now } };
}

const REQ = {
  imageBase64: "QUJD",
  model: "meal-vision",
  baseUrl: "http://localhost:8080/v1",
  apiKey: "test-key",
};

// ── the request ─────────────────────────────────────────────────────────────

describe("estimateNutrition — the request", () => {
  it("revises with the original photo, description and prior estimate, preserving the answer", async () => {
    const { calls, deps } = harness();
    const first = (await estimateNutrition({ ...REQ, description: "Ribs" }, deps)).estimate;
    const followUp = "Did you account for the BBQ sauce?";
    const revised = (await estimateNutrition({ ...REQ, description: "Ribs", previousEstimate: first, followUp }, deps)).estimate;
    const body = calls[1].body as { messages: { role: string; content: unknown }[] };
    expect(body.messages).toHaveLength(4);
    expect(JSON.stringify(body.messages[1])).toContain("data:image/jpeg;base64,QUJD");
    expect(JSON.stringify(body.messages[1])).toContain("Ribs");
    expect(body.messages[2]).toEqual({ role: "assistant", content: JSON.stringify(first) });
    expect(JSON.stringify(body.messages[3])).toContain(followUp);
    expect(revised.followUp).toBe(followUp);
    expect(revised.notes).toBe(GOOD_JSON.notes);
  });
  it("POSTs to the OpenAI-compatible completions path with the Bearer header", async () => {
    const { calls, deps } = harness();
    await estimateNutrition(REQ, deps);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://localhost:8080/v1/chat/completions");
    expect(calls[0].headers["Authorization"]).toBe("Bearer test-key");
    expect(calls[0].timeoutMs).toBe(VISION_TIMEOUT_MS);
  });

  it("does not double the slash when the base URL has a trailing one", async () => {
    const { calls, deps } = harness();
    await estimateNutrition({ ...REQ, baseUrl: "http://localhost:8080/v1/" }, deps);
    expect(calls[0].url).toBe("http://localhost:8080/v1/chat/completions");
  });

  it("sends the system prompt and the requested model", async () => {
    const { calls, deps } = harness();
    await estimateNutrition(REQ, deps);
    const body = calls[0].body as Record<string, unknown>;
    expect(body.model).toBe("meal-vision");
    expect(body.stream).toBe(false);
    const messages = body.messages as Array<{ role: string; content: unknown }>;
    expect(messages[0]).toEqual({ role: "system", content: VISION_SYSTEM_PROMPT });
  });

  it("builds a multimodal content array with a data URI when there is an image", async () => {
    const { calls, deps } = harness();
    await estimateNutrition(REQ, deps);
    const messages = (calls[0].body as { messages: Array<{ content: unknown }> }).messages;
    const content = messages[1].content as Array<Record<string, unknown>>;
    expect(Array.isArray(content)).toBe(true);
    expect(content[0]).toMatchObject({ type: "text" });
    expect(content[1]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/jpeg;base64,QUJD" },
    });
  });

  it("sends plain text when there is no image", async () => {
    const { calls, deps } = harness();
    await estimateNutrition(
      { ...REQ, imageBase64: undefined, description: "two slices and a coke" },
      deps
    );
    const messages = (calls[0].body as { messages: Array<{ content: unknown }> }).messages;
    expect(typeof messages[1].content).toBe("string");
    expect(messages[1].content).toContain("two slices and a coke");
    expect(messages[1].content).toContain("no photo");
  });

  it("passes the patient's description alongside the image", async () => {
    const { calls, deps } = harness();
    await estimateNutrition({ ...REQ, description: "half a bagel" }, deps);
    const messages = (calls[0].body as { messages: Array<{ content: unknown }> }).messages;
    const content = messages[1].content as Array<{ text?: string }>;
    expect(content[0].text).toContain("half a bagel");
  });

  it("refuses a request with neither an image nor a description, without calling out", async () => {
    const { post, deps } = harness();
    await expect(
      estimateNutrition({ ...REQ, imageBase64: undefined }, deps)
    ).rejects.toBeInstanceOf(VisionOutputError);
    expect(post).not.toHaveBeenCalled();
  });

  it("treats an empty-string image or whitespace description as absent", async () => {
    const { post, deps } = harness();
    await expect(
      estimateNutrition({ ...REQ, imageBase64: "", description: "   " }, deps)
    ).rejects.toBeInstanceOf(VisionOutputError);
    expect(post).not.toHaveBeenCalled();
  });
});

// ── the system prompt (risk 4: a confident narrow range is the failure mode) ──

describe("VISION_SYSTEM_PROMPT", () => {
  it("estimates food composition without prescribing insulin", () => {
    expect(VISION_SYSTEM_PROMPT).toMatch(/most likely/i);
    expect(VISION_SYSTEM_PROMPT).toMatch(/do not recommend an insulin dose/i);
  });

  it("demands JSON only, and names every key the validator reads", () => {
    for (const key of ["carbs", "protein", "fat", "fiber", "notes", "confidence", "items"]) {
      expect(VISION_SYSTEM_PROMPT).toContain(`"${key}"`);
    }
    expect(VISION_SYSTEM_PROMPT).toMatch(/ONLY a JSON object/);
  });

  it("asks for grams and for an honest, widened range", () => {
    expect(VISION_SYSTEM_PROMPT).toMatch(/grams/i);
    expect(VISION_SYSTEM_PROMPT).toMatch(/Widen them/);
    expect(VISION_SYSTEM_PROMPT).toMatch(/sauces/i);
    expect(VISION_SYSTEM_PROMPT).toMatch(/portion\/recipe uncertainty/i);
  });
});

// ── the reply ───────────────────────────────────────────────────────────────

describe("estimateNutrition — the reply", () => {
  it("returns a validated estimate with provenance and latency", async () => {
    const { deps } = harness();
    const { estimate, latencyMs } = await estimateNutrition(REQ, deps);

    expect(estimate).toEqual({
      carbs: { low: 45, mid: 60, high: 80 },
      protein: 24,
      fat: 18,
      fiber: 3,
      giClass: "high",
      confidence: 0.55,
      items: [{ name: "cheese pizza", portion: "2 slices", carbs: 58 }],
      model: "meal-vision", // the configured id, never the backend's echoed file path
      provider: "openai-compatible",
      estimatedAt: NOW + 200,
      promptVersion: "meal-nutrition-2026-09-07-v2",
      rawResponse: JSON.stringify(GOOD_JSON),
      notes: GOOD_JSON.notes,
    });
    expect(latencyMs).toBe(100);
  });

  it("preserves the model explanation alongside the raw response", async () => {
    const { deps } = harness();
    const { estimate } = await estimateNutrition(REQ, deps);
    expect(estimate.notes).toBe(GOOD_JSON.notes);
    // ...but the prose survives in rawResponse for a human to read.
    expect(estimate.rawResponse).toContain("thin crust");
  });

  it("reports the requested model id even when the reply names none", async () => {
    const { deps } = harness(() => ({ choices: [{ message: { content: JSON.stringify(GOOD_JSON) } }] }));
    const { estimate } = await estimateNutrition(REQ, deps);
    expect(estimate.model).toBe("meal-vision");
  });

  it("stamps the provider as openai-compatible, whatever the model was", async () => {
    const { deps } = harness();
    expect((await estimateNutrition(REQ, deps)).estimate.provider).toBe("openai-compatible");
  });

  it("parses JSON out of a ```json code fence", async () => {
    const fenced = "```json\n" + JSON.stringify(GOOD_JSON) + "\n```";
    const { deps } = harness(() => reply(fenced));
    expect((await estimateNutrition(REQ, deps)).estimate.carbs.mid).toBe(60);
  });

  it("parses JSON out of surrounding prose", async () => {
    const chatty =
      "Sure! Looking at the plate I'd say:\n" +
      JSON.stringify(GOOD_JSON) +
      "\nHope that helps — check with your care team.";
    const { deps } = harness(() => reply(chatty));
    expect((await estimateNutrition(REQ, deps)).estimate.carbs.high).toBe(80);
  });

  it("clamps an implausible estimate rather than failing", async () => {
    const { deps } = harness(() =>
      reply(JSON.stringify({ carbs: { low: -10, mid: 90, high: 5000 }, confidence: 42 }))
    );
    const { estimate } = await estimateNutrition(REQ, deps);
    expect(estimate.carbs).toEqual({ low: 0, mid: 90, high: 300 });
    expect(estimate.confidence).toBe(1);
  });
});

// ── failure modes ───────────────────────────────────────────────────────────

describe("estimateNutrition — VisionUnavailableError", () => {
  it("wraps a transport failure", async () => {
    const { deps } = harness(() => {
      throw new Error("ECONNREFUSED 127.0.0.1:8080");
    });
    await expect(estimateNutrition(REQ, deps)).rejects.toBeInstanceOf(VisionUnavailableError);
  });

  it("wraps an upstream error status and keeps the detail in the message", async () => {
    const { deps } = harness(() => {
      throw new Error("(502): upstream provider timed out");
    });
    await expect(estimateNutrition(REQ, deps)).rejects.toThrow(/502/);
  });

  it("wraps a timeout", async () => {
    const { deps } = harness(() => {
      throw new Error("request timed out after 120000ms");
    });
    const err = await estimateNutrition(REQ, deps).catch((e) => e);
    expect(err).toBeInstanceOf(VisionUnavailableError);
    expect(err.cause).toBeInstanceOf(Error);
  });
});

describe("estimateNutrition — VisionOutputError", () => {
  async function outputError(responder: () => unknown) {
    const { deps } = harness(responder);
    const err = await estimateNutrition(REQ, deps).catch((e) => e);
    expect(err).toBeInstanceOf(VisionOutputError);
    return err as VisionOutputError;
  }

  it("carries the raw text so a human can see what the model said", async () => {
    const err = await outputError(() => reply("I cannot tell what this is, sorry."));
    expect(err.raw).toBe("I cannot tell what this is, sorry.");
    expect(err.message).toMatch(/no JSON object/);
  });

  it("fails on an empty or missing content", async () => {
    await outputError(() => reply(""));
    await outputError(() => ({ choices: [{ message: {} }] }));
    await outputError(() => ({ choices: [] }));
    await outputError(() => ({}));
  });

  it("fails on a malformed JSON object", async () => {
    const err = await outputError(() => reply('{ "carbs": { "low": 40, } '));
    expect(err.message).toMatch(/no JSON object|malformed/);
  });

  it("fails validation when carbs are missing, and says so", async () => {
    const err = await outputError(() => reply(JSON.stringify({ confidence: 0.8 })));
    expect(err.message).toMatch(/failed validation/);
    expect(err.message).toMatch(/carbs/);
    expect(err.raw).toContain("confidence");
  });

  it("fails validation when confidence is missing — the range display needs it", async () => {
    const err = await outputError(() => reply(JSON.stringify({ carbs: { mid: 40 } })));
    expect(err.message).toMatch(/confidence/);
  });

  it("bounds the raw text it carries", async () => {
    const err = await outputError(() => reply("x".repeat(50_000)));
    expect(err.raw.length).toBeLessThanOrEqual(8000);
  });
});

// ── extractFirstJsonObject ──────────────────────────────────────────────────

describe("extractFirstJsonObject", () => {
  it("returns the object from a bare JSON reply", () => {
    expect(extractFirstJsonObject('{"a":1}')).toBe('{"a":1}');
  });

  it("ignores a code fence and trailing prose", () => {
    expect(extractFirstJsonObject('```json\n{"a":1}\n```\nthanks!')).toBe('{"a":1}');
  });

  it("handles nested objects", () => {
    const s = '{"carbs":{"low":1,"mid":2},"items":[{"name":"x"}]}';
    expect(extractFirstJsonObject(`prefix ${s} suffix`)).toBe(s);
  });

  it("does not stop at a brace inside a string", () => {
    const s = '{"notes":"a } that is not the end","carbs":1}';
    expect(extractFirstJsonObject(s)).toBe(s);
  });

  it("respects escaped quotes", () => {
    const s = '{"notes":"he said \\"} \\" and stopped","c":1}';
    expect(extractFirstJsonObject(s)).toBe(s);
  });

  it("returns null when there is no object or it never closes", () => {
    expect(extractFirstJsonObject("no json here")).toBeNull();
    expect(extractFirstJsonObject('{"a":1')).toBeNull();
    expect(extractFirstJsonObject("")).toBeNull();
  });

  it("takes the FIRST complete object when a model emits two", () => {
    expect(extractFirstJsonObject('{"a":1} then {"b":2}')).toBe('{"a":1}');
  });
});
