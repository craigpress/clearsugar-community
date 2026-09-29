import Foundation

/// Local notifications back up server delivery only when pushes stop and no snooze applies.
enum LocalAlertGate {
    /// Default quiet window before the backstop takes over. The server pushes a
    /// silent background update roughly every 5 min, so three missed pushes
    /// means the pipeline is genuinely down, not jittery.
    static let defaultBackstopWindow: TimeInterval = 15 * 60

    static func mayFire(
        now: Date,
        lastServerPush: Date?,
        snoozedUntil: Date?,
        snoozedUntilRange: Bool,
        backstopWindow: TimeInterval = defaultBackstopWindow
    ) -> Bool {
        // Snooze wins over everything: silencing means silencing the backstop too.
        if snoozedUntilRange { return false }
        if let snoozedUntil, snoozedUntil > now { return false }

        // No push ever seen (fresh install, first run): fire â€” better a
        // duplicate on day one than silence during an outage.
        guard let lastServerPush else { return true }
        return now.timeIntervalSince(lastServerPush) >= backstopWindow
    }
}
