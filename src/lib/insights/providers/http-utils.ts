import http from "node:http";
import https from "node:https";

/**
 * Insight reports can take several minutes to generate. Some backends (local
 * CLI-backed shims, Ollama, slow completions in general) don't send a
 * response until generation finishes, which can exceed global fetch's
 * (undici's) default ~300s headers/body timeouts and abort with "fetch
 * failed" well before a multi-minute LLM call completes. node:http/https have
 * no such client-side timeout, so non-streaming provider calls go through
 * postJsonLongTimeout() below; a single explicit timeoutMs bounds the whole
 * request instead.
 */
export const LLM_LONG_TIMEOUT_MS = 600_000;

/** POST a JSON body over node:http(s) and parse the JSON response. */
export function postJsonLongTimeout(
  urlStr: string,
  bodyObj: unknown,
  headers: Record<string, string> = {},
  timeoutMs: number = LLM_LONG_TIMEOUT_MS
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const data = JSON.stringify(bodyObj);
    const transport = u.protocol === "https:" ? https : http;
    const req = transport.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
          ...headers,
        },
      },
      (res) => {
        let chunks = "";
        res.setEncoding("utf8");
        res.on("data", (d) => (chunks += d));
        res.on("end", () => {
          const status = res.statusCode || 0;
          if (status >= 400) {
            reject(new Error(`HTTP ${status}: ${chunks.slice(0, 800)}`));
            return;
          }
          try {
            resolve(JSON.parse(chunks));
          } catch {
            reject(new Error(`invalid JSON response: ${chunks.slice(0, 200)}`));
          }
        });
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`request timed out after ${timeoutMs}ms`)));
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}
