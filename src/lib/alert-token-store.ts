/**
 * Pure operations over the three token-keyed alert stores:
 *   tokens      push/alert-tokens.json          token → device name
 *   prefs       push/alert-preferences.json     token → DeviceAlertPrefs
 *   recipients  push/high-alert-recipients.json [token]
 *
 * Why (2026-07-24): nothing ever pruned an install's previous token when it
 * re-registered, so 8 tokens accumulated for ~3 phones — every alert went to 8
 * endpoints, phones with two live tokens got duplicates, and both high-alert
 * recipients pointed at long-dead tokens. `replaceAlertToken` keeps a device to
 * exactly one token as it rotates; `removeAlertToken` handles APNs telling us a
 * token is dead (BadDeviceToken/Unregistered), which was previously ignored.
 */

export interface AlertStores {
  tokens: Record<string, string>;
  prefs: Record<string, unknown>;
  recipients: string[];
}

/**
 * Re-key a device's registration from oldToken to newToken: registration map,
 * per-device prefs (thresholds/role/owner survive the rotation), and its
 * high-alert recipient slot. Prefs already present on the new token win —
 * they are newer information.
 */
export function replaceAlertToken(
  stores: AlertStores,
  oldToken: string,
  newToken: string,
  device: string,
): void {
  if (oldToken === newToken) {
    stores.tokens[newToken] = device;
    return;
  }
  stores.tokens[newToken] = device;
  delete stores.tokens[oldToken];

  if (oldToken in stores.prefs) {
    if (!(newToken in stores.prefs)) stores.prefs[newToken] = stores.prefs[oldToken];
    delete stores.prefs[oldToken];
  }

  if (stores.recipients.includes(oldToken)) {
    stores.recipients = [
      ...new Set(stores.recipients.map((t) => (t === oldToken ? newToken : t))),
    ];
  }
}

/**
 * Remove a dead token (APNs 400 BadDeviceToken / 410 Unregistered) from the
 * registration map and recipients. Prefs are deliberately retained so a later
 * re-register from the same install can still migrate them.
 * Returns true when anything changed.
 */
export function removeAlertToken(stores: AlertStores, token: string): boolean {
  let changed = false;
  if (token in stores.tokens) {
    delete stores.tokens[token];
    changed = true;
  }
  const idx = stores.recipients.indexOf(token);
  if (idx !== -1) {
    stores.recipients.splice(idx, 1);
    changed = true;
  }
  return changed;
}
