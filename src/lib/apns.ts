import { SignJWT, importPKCS8 } from "jose";
import http2 from "node:http2";

// Trim all env vars to remove trailing newlines
const APNS_KEY_ID = (process.env.APNS_KEY_ID ?? "").trim();
const APNS_TEAM_ID = (process.env.APNS_TEAM_ID ?? "").trim();
const APNS_PRIVATE_KEY_B64 = (process.env.APNS_PRIVATE_KEY_B64 ?? "").trim();
// No default — every deployment must set its own bundle ID. Push functions
// no-op (with a clear log) rather than send to someone else's app.
const APNS_BUNDLE_ID = (process.env.APNS_BUNDLE_ID ?? "").trim();

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
 * alarm / siren channel; the loudest channel ClearSugar uses is the phone
 * "time-sensitive" push.
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
): Promise<{ success: boolean; status: number }> {
  if (!APNS_BUNDLE_ID) {
    console.error("[apns] APNS_BUNDLE_ID not set — skipping alert push");
    return { success: false, status: 0 };
  }
  const token = await getAPNsToken();
  const apnsPriority = interruptionLevel === "passive" ? "5" : "10";

  const payload = JSON.stringify({
    aps: {
      alert: { title, body },
      sound: "default",
      "interruption-level": interruptionLevel,
      ...(category && { category }),
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
      "apns-topic": APNS_BUNDLE_ID,
      "apns-push-type": "alert",
      "apns-priority": apnsPriority,
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
  if (!APNS_BUNDLE_ID) {
    console.error("[apns] APNS_BUNDLE_ID not set — skipping silent push");
    return { success: false, status: 0 };
  }
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
      "apns-topic": APNS_BUNDLE_ID,
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
  if (!APNS_BUNDLE_ID) {
    console.error("[apns] APNS_BUNDLE_ID not set — skipping Live Activity push");
    return { success: false, status: 0 };
  }
  const token = await getAPNsToken();

  const payload = JSON.stringify({
    aps: {
      timestamp: Math.floor(Date.now() / 1000),
      event: "update",
      "content-state": contentState,
      ...(staleDate && { "stale-date": staleDate }),
      ...(dismissalDate && { "dismissal-date": dismissalDate }),
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
      "apns-topic": `${APNS_BUNDLE_ID}.push-type.liveactivity`,
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
