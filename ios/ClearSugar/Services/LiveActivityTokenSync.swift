import Foundation

/// Pure selection: given every live activity's (id, content-timestamp, update
/// token) and the last token we successfully registered, decide which token —
/// if any — the server still needs. Keeps the re-sync rule testable without
/// ActivityKit, mirroring `LiveActivityCollapse`.
///
/// Why this exists: `Activity.pushTokenUpdates` only yields while the app process
/// is alive. A card created by push-to-start while the app was killed therefore
/// never registered its token, so the server kept pushing the previous one —
/// which APNs answers 200 to indefinitely — and the new card silently froze on
/// stale glucose. Re-syncing from `Activity.activities` on launch and foreground
/// closes that gap; this decides when a POST is actually warranted.
enum LiveActivityTokenSync {
    /// The update token to register now, or nil when nothing needs sending.
    ///
    /// Picks the newest activity that has a token — matching `LiveActivityCollapse`,
    /// where the newest card is the one that survives — and suppresses the POST when
    /// that token is already the one we registered, so a foreground re-sync on every
    /// activation is free.
    static func tokenToRegister(
        activities: [(id: String, contentTimestamp: TimeInterval, pushTokenHex: String?)],
        lastRegistered: String?
    ) -> String? {
        let withTokens = activities.filter { $0.pushTokenHex != nil }
        guard let newest = withTokens.max(by: { $0.contentTimestamp < $1.contentTimestamp }),
              let token = newest.pushTokenHex else { return nil }
        return token == lastRegistered ? nil : token
    }
}
