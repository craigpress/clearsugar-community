import { SignJWT, importPKCS8 } from "jose";
import http2 from "node:http2";
import { buildLiveActivityPayload } from "./apns-payload";

// Trim all env vars to remove trailing newlines
const APNS_KEY_ID = (process.env.APNS_KEY_ID ?? "").trim();
const APNS_TEAM_ID = (process.env.APNS_TEAM_ID ?? "").trim();
const APNS_PRIVATE_KEY_B64 = (process.env.APNS_PRIVATE_KEY_B64 ?? "").trim();

// Use sandbox for development-signed iOS apps, production for App Store builds
const APNS_HOST = process.env.APNS_SANDBOX === "true"
  ? "api.sandbox.push.apple.com"
  : "api.push.apple.com";

let cachedToken: { jwt: string; expiresAt: number } | null = null;

async function getAPNsToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt > now) {
    return cachedToken.jwt;
  }

  // Decode base64-encoded private key
  const privateKeyPem = Buffer.from(APNS_PRIVATE_KEY_B64, "base64").toString("utf8");
  const key = await importPKCS8(privateKeyPem, "ES256");

  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: APNS_KEY_ID })
    .setIssuer(APNS_TEAM_ID)
    .setIssuedAt(now)
    .sign(key);

  cachedToken = { jwt, expiresAt: now + 50 * 60 };
  return jwt;
}

/**
 * Delivery tier → iOS interruption-level. "critical" is intentionally NOT
 * supported: it requires Apple's Critical Alerts entitlement. There is NO house
 * alarm / siren channel; the loudest
 * channel ClearSugar uses is the phone "time-sensitive" push.
 */
export type AlertInterruptionLevel = "passive" | "active" | "time-sensitive";

/**
 * Send a standard alert push notification via APNs (HTTP/2).
 * This produces a visible banner notification with sound.
 * Used for clinical alerts (site failures, CGM issues).
 *
 * `interruptionLevel` separates delivery loudness from clinical severity so a
 * low-priority nudge and an urgent advisory are distinguishable to a sleeping
 * responder (Phase 0 found the old payload set none). Defaults to "active"
 * (prior behavior). Passive also drops APNs priority to 5 (no immediate wake).
 */
export async function pushAlertNotification(
  pushToken: string,
  title: string,
  body: string,
  category?: string,
  interruptionLevel: AlertInterruptionLevel = "active",
  opts?: {
    /** apns-collapse-id: a repeat of the same alert replaces the previous banner
     *  instead of stacking a new one (2026-07-24 storm: 8 stacked "Glucose High"
     *  banners per phone). */
    collapseId?: string;
    /** Custom payload key so the iOS ACK handler knows which alert type it is
     *  acknowledging (needed for the per-device, per-type server ack). */
    alertType?: string;
    /** Extra custom keys merged beside `aps` (APNs allows any top-level key
     *  outside `aps`; iOS surfaces them as `userInfo`). Used by the meal prompt
     *  to carry `{ kind, episodeId, trigger, bolusAt, carbs, insulin }` so the
     *  reply action knows which episode it is answering. Spread FIRST so it can
     *  never clobber `aps` or the existing `alertType` key. */
    userInfo?: Record<string, unknown>;
  },
): Promise<{ success: boolean; status: number }> {
  const token = await getAPNsToken();
  const apnsPriority = interruptionLevel === "passive" ? "5" : "10";

  const payload = JSON.stringify({
    aps: {
      alert: { title, body },
      sound: "default",
      "interruption-level": interruptionLevel,
      ...(category && { category }),
    },
    ...(opts?.userInfo ?? {}),
    ...(opts?.alertType && { alertType: opts.alertType }),
  });

  return new Promise((resolve, reject) => {
    const client = http2.connect(`https://${APNS_HOST}`);

    client.on("error", (err) => {
      client.close();
      reject(new Error(`APNs connection error: ${err.message}`));
    });

    // Bound the whole exchange: without this an unresponsive APNs socket never
    // settles the promise, so an alert push can hang indefinitely (the caller's
    // Promise.allSettled would wait forever). 10s is generous for APNs HTTP/2.
    client.setTimeout(10_000, () => {
      client.close();
      reject(new Error("APNs timeout after 10s"));
    });

    const req = client.request({
      ":method": "POST",
      ":path": `/3/device/${pushToken}`,
      authorization: `bearer ${token}`,
      "apns-topic": (process.env.APNS_BUNDLE_ID ?? "").trim(),
      "apns-push-type": "alert",
      "apns-priority": apnsPriority,
      ...(opts?.collapseId && { "apns-collapse-id": opts.collapseId }),
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
    });

    let responseData = "";
    let statusCode = 0;

    req.on("response", (headers) => {
      statusCode = headers[":status"] as number;
    });

    req.on("data", (chunk: Buffer) => {
      responseData += chunk.toString();
    });

    req.on("end", () => {
      client.close();
      if (statusCode === 200) {
        resolve({ success: true, status: statusCode });
      } else {
        reject(new Error(`APNs alert push failed (${statusCode}): ${responseData}`));
      }
    });

    req.on("error", (err) => {
      client.close();
      reject(new Error(`APNs request error: ${err.message}`));
    });

    req.write(payload);
    req.end();
  });
}

/**
 * Send a silent background push to wake the app for widget/Watch refresh.
 * Uses content-available: 1 with no visible alert.
 */
export async function pushSilentBackground(
  pushToken: string,
  badge?: number,
): Promise<{ success: boolean; status: number }> {
  const token = await getAPNsToken();

  const payload = JSON.stringify({
    aps: {
      "content-available": 1,
      ...(badge != null && { badge }),
    },
  });

  return new Promise((resolve, reject) => {
    const client = http2.connect(`https://${APNS_HOST}`);

    client.on("error", (err) => {
      client.close();
      reject(new Error(`APNs connection error: ${err.message}`));
    });

    // Bound the whole exchange: without this an unresponsive APNs socket never
    // settles the promise, so an alert push can hang indefinitely (the caller's
    // Promise.allSettled would wait forever). 10s is generous for APNs HTTP/2.
    client.setTimeout(10_000, () => {
      client.close();
      reject(new Error("APNs timeout after 10s"));
    });

    const req = client.request({
      ":method": "POST",
      ":path": `/3/device/${pushToken}`,
      authorization: `bearer ${token}`,
      "apns-topic": (process.env.APNS_BUNDLE_ID ?? "").trim(),
      "apns-push-type": "background",
      "apns-priority": "5",
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
    });

    let responseData = "";
    let statusCode = 0;

    req.on("response", (headers) => {
      statusCode = headers[":status"] as number;
    });

    req.on("data", (chunk: Buffer) => {
      responseData += chunk.toString();
    });

    req.on("end", () => {
      client.close();
      if (statusCode === 200) {
        resolve({ success: true, status: statusCode });
      } else {
        reject(new Error(`APNs silent push failed (${statusCode}): ${responseData}`));
      }
    });

    req.on("error", (err) => {
      client.close();
      reject(new Error(`APNs request error: ${err.message}`));
    });

    req.write(payload);
    req.end();
  });
}

/**
 * Send a Live Activity update via APNs push notification using HTTP/2.
 * This silently updates the Dynamic Island — no visible notification.
 */
export async function pushLiveActivityUpdate(
  pushToken: string,
  contentState: Record<string, unknown>,
  staleDate?: number,
  dismissalDate?: number
): Promise<{ success: boolean; status: number }> {
  return sendLiveActivityRaw(
    pushToken,
    buildLiveActivityPayload({ event: "update", contentState, staleDate, dismissalDate }),
  );
}

/**
 * Start (or restart) a Live Activity via APNs push-to-start (iOS 17.2+). Sent to
 * a pushToStart token so the Lock-Screen activity can be (re)created without the
 * app running.
 */
export async function pushLiveActivityStart(
  pushToStartToken: string,
  contentState: Record<string, unknown>,
  staleDate?: number,
  attributesType = "GlucoseActivityAttributes",
): Promise<{ success: boolean; status: number }> {
  return sendLiveActivityRaw(
    pushToStartToken,
    buildLiveActivityPayload({ event: "start", contentState, staleDate, attributesType, attributes: {} }),
  );
}

/**
 * Shared HTTP/2 exchange for a Live Activity push (start or update). Same
 * apns-topic / push-type / priority and 10s timeout for both events.
 */
async function sendLiveActivityRaw(
  pushToken: string,
  payload: string,
): Promise<{ success: boolean; status: number }> {
  const token = await getAPNsToken();

  return new Promise((resolve, reject) => {
    const client = http2.connect(`https://${APNS_HOST}`);

    client.on("error", (err) => {
      client.close();
      reject(new Error(`APNs connection error: ${err.message}`));
    });

    // Bound the whole exchange: without this an unresponsive APNs socket never
    // settles the promise, so an alert push can hang indefinitely (the caller's
    // Promise.allSettled would wait forever). 10s is generous for APNs HTTP/2.
    client.setTimeout(10_000, () => {
      client.close();
      reject(new Error("APNs timeout after 10s"));
    });

    const req = client.request({
      ":method": "POST",
      ":path": `/3/device/${pushToken}`,
      authorization: `bearer ${token}`,
      "apns-topic": `${(process.env.APNS_BUNDLE_ID ?? "").trim()}.push-type.liveactivity`,
      "apns-push-type": "liveactivity",
      "apns-priority": "10",
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
    });

    let responseData = "";
    let statusCode = 0;

    req.on("response", (headers) => {
      statusCode = headers[":status"] as number;
    });

    req.on("data", (chunk: Buffer) => {
      responseData += chunk.toString();
    });

    req.on("end", () => {
      client.close();
      if (statusCode === 200) {
        resolve({ success: true, status: statusCode });
      } else {
        reject(
          new Error(`APNs push failed (${statusCode}): ${responseData}`)
        );
      }
    });

    req.on("error", (err) => {
      client.close();
      reject(new Error(`APNs request error: ${err.message}`));
    });

    req.write(payload);
    req.end();
  });
}
