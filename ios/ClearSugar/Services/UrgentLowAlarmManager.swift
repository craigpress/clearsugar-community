import AlarmKit
import AppIntents
import Foundation
import SwiftUI

/// Thin gate so iOS 17 code paths can reach the iOS-26-only alarm manager
/// without sprinkling availability checks at every call site.
enum UrgentLowAlarmGate {
    /// Preference key shared with SettingsView (same store as the other alert toggles).
    static let enabledKey = "urgentLowAlarmEnabled"

    @MainActor
    static func evaluate(_ reading: GlucoseReading, urgentLowThreshold: Int) {
        // Defence in depth: AlertManager already gates on this, but the alarm
        // sounds at full volume through Silent and Focus, so no future caller
        // should be able to arm it from a sensor-error sentinel (sgv = 0).
        guard reading.isValid else { return }
        if #available(iOS 26.0, *) {
            UrgentLowAlarmManager.shared.evaluate(reading, urgentLowThreshold: urgentLowThreshold)
        }
    }

    /// Request AlarmKit authorization. Returns true when authorized
    /// (always false before iOS 26).
    @MainActor
    static func requestAuthorization() async -> Bool {
        if #available(iOS 26.0, *) {
            return await UrgentLowAlarmManager.shared.requestAuthorization()
        }
        return false
    }
}

/// Opt-in AlarmKit alarm for urgent lows (iOS 26+). Unlike the critical
/// notification in AlertManager, an AlarmKit alarm sounds at full volume
/// through Silent and Focus with a full-screen Stop / Open presentation.
@available(iOS 26.0, *)
@MainActor
final class UrgentLowAlarmManager {
    static let shared = UrgentLowAlarmManager()

    /// Never schedule more than one alarm per 20 minutes.
    private let debounceInterval: TimeInterval = 20 * 60
    /// Cancel once a reading is this far (mg/dL) above the urgent-low threshold.
    private let clearMargin = 10

    private static let alarmIDKey = "urgentLowAlarmID"
    private static let lastFiredKey = "urgentLowAlarmLastFired"

    private init() {}

    private var isEnabled: Bool {
        UserDefaults.standard.bool(forKey: UrgentLowAlarmGate.enabledKey)
    }

    /// Fixed alarm UUID persisted in app-group defaults so cancel/re-schedule
    /// is idempotent across launches.
    private var alarmID: UUID {
        let defaults = AppConfig.sharedDefaults
        if let stored = defaults.string(forKey: Self.alarmIDKey),
           let id = UUID(uuidString: stored) {
            return id
        }
        let id = UUID()
        defaults.set(id.uuidString, forKey: Self.alarmIDKey)
        return id
    }

    // MARK: - Evaluate Reading

    /// Called with every fresh reading from the same hook that re-arms the
    /// dead-man watchdog (foreground fetch, BG refresh, silent push).
    func evaluate(_ reading: GlucoseReading, urgentLowThreshold: Int) {
        guard isEnabled else { return }

        if reading.sgv <= urgentLowThreshold {
            Task { await self.scheduleIfNeeded() }
        } else if reading.sgv > urgentLowThreshold + clearMargin {
            cancelPending()
        }
        // Between threshold and threshold + margin: hysteresis band, no change.
    }

    // MARK: - Scheduling

    private func scheduleIfNeeded() async {
        let manager = AlarmManager.shared

        switch manager.authorizationState {
        case .authorized:
            break
        case .notDetermined:
            guard await requestAuthorization() else { return }
        case .denied:
            return
        @unknown default:
            return
        }

        // Debounce: at most one alarm per 20 minutes.
        let defaults = AppConfig.sharedDefaults
        let lastFired = defaults.double(forKey: Self.lastFiredKey)
        if lastFired > 0, Date().timeIntervalSince1970 - lastFired < debounceInterval {
            return
        }

        let id = alarmID
        // Idempotent re-schedule: drop any previous alarm with our fixed ID.
        try? manager.cancel(id: id)

        let alert = AlarmPresentation.Alert(
            title: "URGENT LOW \u{2014} check glucose now",
            stopButton: AlarmButton(
                text: "Stop",
                textColor: .white,
                systemImageName: "stop.fill"
            ),
            secondaryButton: AlarmButton(
                text: "Open app",
                textColor: .white,
                systemImageName: "arrow.up.forward.app.fill"
            ),
            secondaryButtonBehavior: .custom // "Open" action, runs OpenClearSugarIntent
        )

        let attributes = AlarmAttributes(
            presentation: AlarmPresentation(alert: alert),
            metadata: UrgentLowAlarmMetadata(),
            tintColor: Color(red: 0.94, green: 0.33, blue: 0.31) // urgentRed
        )

        // Fixed schedule a few seconds out = fires essentially immediately.
        // `sound:` is omitted to use the API's default alert sound (Apple's
        // sample code omits it too; add `sound: .default` if Xcode disagrees).
        let configuration = AlarmManager.AlarmConfiguration(
            countdownDuration: nil,
            schedule: .fixed(Date().addingTimeInterval(3)),
            attributes: attributes,
            stopIntent: nil,
            secondaryIntent: OpenClearSugarIntent()
        )

        do {
            _ = try await manager.schedule(id: id, configuration: configuration)
            defaults.set(Date().timeIntervalSince1970, forKey: Self.lastFiredKey)
        } catch {
            print("UrgentLowAlarm schedule failed: \(error)")
        }
    }

    /// Cancel any pending or firing alarm once glucose has recovered above
    /// urgent-low + margin.
    private func cancelPending() {
        let manager = AlarmManager.shared
        let id = alarmID
        try? manager.stop(id: id)   // stops it if currently alerting
        try? manager.cancel(id: id) // removes it if still scheduled
    }

    // MARK: - Authorization

    /// Returns true when AlarmKit authorization is (or becomes) granted.
    func requestAuthorization() async -> Bool {
        let manager = AlarmManager.shared
        switch manager.authorizationState {
        case .authorized:
            return true
        case .denied:
            return false
        default:
            break
        }
        do {
            return try await manager.requestAuthorization() == .authorized
        } catch {
            print("UrgentLowAlarm authorization failed: \(error)")
            return false
        }
    }
}

// MARK: - Alarm Metadata + Open-App Intent

@available(iOS 26.0, *)
struct UrgentLowAlarmMetadata: AlarmMetadata {}

/// Backs the alarm's secondary "Open app" button (.custom behavior):
/// openAppWhenRun brings ClearSugar to the foreground when tapped.
@available(iOS 26.0, *)
struct OpenClearSugarIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Open ClearSugar"
    static var isDiscoverable: Bool = false
    static var openAppWhenRun: Bool = true

    func perform() async throws -> some IntentResult {
        .result()
    }
}
