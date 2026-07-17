import Foundation
import UserNotifications
import UIKit

@MainActor
final class AlertManager: ObservableObject {
    static let shared = AlertManager()

    @Published var lastAlertedSgv: Int?
    @Published var isNotificationsAuthorized = false

    private var lastUrgentAlertDate: Date?
    private var lastWarningAlertDate: Date?
    private let urgentRepeatInterval: TimeInterval = 60
    private let warningCooldownInterval: TimeInterval = 30 * 60 // 30 minutes

    private init() {}

    // MARK: - Thresholds from UserDefaults

    private var thresholdUrgentLow: Int {
        let val = UserDefaults.standard.double(forKey: "thresholdUrgentLow")
        return val > 0 ? Int(val) : 55
    }

    private var thresholdLow: Int {
        let val = UserDefaults.standard.double(forKey: "thresholdLow")
        return val > 0 ? Int(val) : 70
    }

    private var thresholdHigh: Int {
        let val = UserDefaults.standard.double(forKey: "thresholdHigh")
        return val > 0 ? Int(val) : 180
    }

    private var thresholdUrgentHigh: Int {
        let val = UserDefaults.standard.double(forKey: "thresholdUrgentHigh")
        return val > 0 ? Int(val) : 250
    }

    // MARK: - Alert Toggles from UserDefaults

    private var alertsUrgentEnabled: Bool {
        // Default true if key not explicitly set
        if UserDefaults.standard.object(forKey: "alertsUrgentEnabled") == nil { return true }
        return UserDefaults.standard.bool(forKey: "alertsUrgentEnabled")
    }

    private var alertsLowEnabled: Bool {
        if UserDefaults.standard.object(forKey: "alertsLowEnabled") == nil { return true }
        return UserDefaults.standard.bool(forKey: "alertsLowEnabled")
    }

    private var alertsHighEnabled: Bool {
        if UserDefaults.standard.object(forKey: "alertsHighEnabled") == nil { return true }
        return UserDefaults.standard.bool(forKey: "alertsHighEnabled")
    }

    private var hapticFeedbackEnabled: Bool {
        if UserDefaults.standard.object(forKey: "hapticFeedbackEnabled") == nil { return true }
        return UserDefaults.standard.bool(forKey: "hapticFeedbackEnabled")
    }

    // MARK: - Tone Preferences

    private var urgentAlertTone: String {
        UserDefaults.standard.string(forKey: "urgentAlertTone") ?? "Critical (Default)"
    }

    private var warningAlertTone: String {
        UserDefaults.standard.string(forKey: "warningAlertTone") ?? "Default"
    }

    private var urgentNotificationSound: UNNotificationSound {
        switch urgentAlertTone {
        case "Alarm":
            return UNNotificationSound.defaultCriticalSound(withAudioVolume: 1.0)
        case "Chime":
            return UNNotificationSound.defaultCritical
        default: // "Critical (Default)"
            return UNNotificationSound.defaultCritical
        }
    }

    private var warningNotificationSound: UNNotificationSound? {
        switch warningAlertTone {
        case "Gentle":
            return UNNotificationSound.default
        case "None":
            return nil
        default: // "Default"
            return UNNotificationSound.default
        }
    }

    // MARK: - Setup

    func requestPermissions() {
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .sound, .badge, .criticalAlert]) { granted, error in
            Task { @MainActor in
                self.isNotificationsAuthorized = granted
                if let error {
                    print("Notification permission error: \(error)")
                }
            }
        }

        let ack = UNNotificationAction(identifier: "ACK", title: "Acknowledge", options: [])
        let snooze30 = UNNotificationAction(identifier: "SNOOZE_30", title: "Snooze 30 min", options: [])
        let snooze60 = UNNotificationAction(identifier: "SNOOZE_60", title: "Snooze 1 hour", options: [])
        let snoozeRange = UNNotificationAction(identifier: "SNOOZE_RANGE", title: "Snooze until in range", options: [])

        let urgentCategory = UNNotificationCategory(
            identifier: "URGENT_GLUCOSE",
            actions: [ack, snooze30, snooze60, snoozeRange],
            intentIdentifiers: [],
            options: .customDismissAction
        )
        let warningCategory = UNNotificationCategory(
            identifier: "GLUCOSE_WARNING",
            actions: [ack, snooze60, snoozeRange],
            intentIdentifiers: [],
            options: []
        )
        center.setNotificationCategories([urgentCategory, warningCategory])
    }

    // MARK: - Evaluate Reading

    func evaluate(_ reading: GlucoseReading) {
        let sgv = reading.sgv

        // Determine range category using customizable thresholds
        let isUrgentLow = sgv < thresholdUrgentLow
        let isLow = sgv >= thresholdUrgentLow && sgv < thresholdLow
        let isHigh = sgv > thresholdHigh && sgv <= thresholdUrgentHigh
        let isUrgentHigh = sgv > thresholdUrgentHigh
        let isInRange = sgv >= thresholdLow && sgv <= thresholdHigh

        if isUrgentLow || isUrgentHigh {
            if hapticFeedbackEnabled {
                triggerHaptic(.heavy)
            }
            if alertsUrgentEnabled {
                sendUrgentAlert(reading, isLow: isUrgentLow)
            }
        } else if isLow {
            if hapticFeedbackEnabled {
                triggerHaptic(.medium)
            }
            if alertsLowEnabled {
                sendWarningAlert(reading, type: "Low")
            }
        } else if isHigh {
            if hapticFeedbackEnabled {
                triggerHaptic(.medium)
            }
            if alertsHighEnabled {
                sendWarningAlert(reading, type: "High")
            }
        } else if isInRange {
            lastUrgentAlertDate = nil
            lastWarningAlertDate = nil
            UNUserNotificationCenter.current().removeDeliveredNotifications(
                withIdentifiers: ["urgent-glucose", "warning-glucose"]
            )
        }

        // Check for stale data
        if reading.minutesAgo > 15 {
            sendStaleDataAlert(minutesAgo: reading.minutesAgo)
        }

        // Check for stale pump
        if let pumpStale = reading.pumpIsStale, pumpStale,
           let pumpMins = reading.pumpStaleMinutes, pumpMins > 30 {
            sendPumpStaleAlert(minutesStale: pumpMins)
        }

        lastAlertedSgv = reading.sgv
    }

    // MARK: - Urgent Alert

    private func sendUrgentAlert(_ reading: GlucoseReading, isLow: Bool) {
        if let lastAlert = lastUrgentAlertDate,
           Date().timeIntervalSince(lastAlert) < urgentRepeatInterval {
            return
        }
        lastUrgentAlertDate = Date()

        let content = UNMutableNotificationContent()
        content.title = isLow ? "URGENT LOW" : "URGENT HIGH"
        content.body = "\(reading.sgv) mg/dL \(reading.trendArrow) \u{2014} \(isLow ? "Treat immediately with fast carbs" : "Check insulin pump, consider correction")"
        content.sound = urgentNotificationSound
        content.interruptionLevel = .critical
        content.categoryIdentifier = "URGENT_GLUCOSE"
        content.badge = NSNumber(value: reading.sgv)

        let request = UNNotificationRequest(
            identifier: "urgent-glucose",
            content: content,
            trigger: nil
        )
        UNUserNotificationCenter.current().add(request)

        // Schedule a repeat alert in 1 minute if still urgent
        let repeatContent = UNMutableNotificationContent()
        repeatContent.title = isLow ? "STILL URGENT LOW" : "STILL URGENT HIGH"
        repeatContent.body = "\(reading.sgv) mg/dL \u{2014} Check glucose NOW"
        repeatContent.sound = urgentNotificationSound
        repeatContent.interruptionLevel = .critical
        repeatContent.categoryIdentifier = "URGENT_GLUCOSE"

        let repeatTrigger = UNTimeIntervalNotificationTrigger(timeInterval: 60, repeats: false)
        let repeatRequest = UNNotificationRequest(
            identifier: "urgent-glucose-repeat",
            content: repeatContent,
            trigger: repeatTrigger
        )
        UNUserNotificationCenter.current().add(repeatRequest)
    }

    // MARK: - Warning Alert

    private func sendWarningAlert(_ reading: GlucoseReading, type: String) {
        if let lastWarning = lastWarningAlertDate,
           Date().timeIntervalSince(lastWarning) < warningCooldownInterval {
            return
        }
        lastWarningAlertDate = Date()

        let content = UNMutableNotificationContent()
        content.title = "Glucose \(type)"
        content.body = "\(reading.sgv) mg/dL \(reading.trendArrow)"

        if let sound = warningNotificationSound {
            content.sound = sound
        }
        content.interruptionLevel = .timeSensitive
        content.categoryIdentifier = "GLUCOSE_WARNING"

        let request = UNNotificationRequest(
            identifier: "warning-glucose",
            content: content,
            trigger: nil
        )
        UNUserNotificationCenter.current().add(request)
    }

    // MARK: - Stale Data Alert

    private func sendStaleDataAlert(minutesAgo: Int) {
        let content = UNMutableNotificationContent()
        content.title = "Glucose Data Stale"
        content.body = "Last reading was \(minutesAgo) minutes ago. Check CGM connection."
        content.sound = .default
        content.interruptionLevel = .active
        content.categoryIdentifier = "GLUCOSE_WARNING"

        let request = UNNotificationRequest(
            identifier: "stale-data",
            content: content,
            trigger: nil
        )
        UNUserNotificationCenter.current().add(request)
    }

    // MARK: - Pump Stale Alert

    private func sendPumpStaleAlert(minutesStale: Int) {
        let content = UNMutableNotificationContent()
        content.title = "Pump Connection Lost"
        content.body = "No pump data for \(minutesStale) minutes. The pump algorithm may not be adjusting insulin."
        content.sound = .default
        content.interruptionLevel = .timeSensitive
        content.categoryIdentifier = "GLUCOSE_WARNING"

        let request = UNNotificationRequest(
            identifier: "pump-stale",
            content: content,
            trigger: nil
        )
        UNUserNotificationCenter.current().add(request)
    }

    // MARK: - Dead-Man Watchdog

    /// Minutes of silence before the watchdog notification fires.
    static let watchdogIntervalMinutes = 25
    private static let watchdogIdentifier = "data-watchdog"

    /// Schedule a local notification that fires if no glucose data arrives for
    /// 25 minutes. Call on EVERY successful data update (foreground fetch,
    /// background refresh, silent push) — each call replaces the previous
    /// pending notification, so it only fires when the whole update pipeline
    /// goes quiet. This works even while the app is suspended and the
    /// server-side push pipeline is down.
    func rearmDataWatchdog() {
        let center = UNUserNotificationCenter.current()
        center.removePendingNotificationRequests(withIdentifiers: [Self.watchdogIdentifier])

        let content = UNMutableNotificationContent()
        content.title = "No Glucose Data"
        content.body = "No glucose data for \(Self.watchdogIntervalMinutes) minutes — open ClearSugar."
        content.sound = .default
        content.interruptionLevel = .timeSensitive
        content.categoryIdentifier = "GLUCOSE_WARNING"

        let trigger = UNTimeIntervalNotificationTrigger(
            timeInterval: TimeInterval(Self.watchdogIntervalMinutes * 60),
            repeats: false
        )
        let request = UNNotificationRequest(
            identifier: Self.watchdogIdentifier,
            content: content,
            trigger: trigger
        )
        center.add(request)
    }

    // MARK: - Haptics

    private func triggerHaptic(_ style: UIImpactFeedbackGenerator.FeedbackStyle) {
        let generator = UIImpactFeedbackGenerator(style: style)
        generator.prepare()
        generator.impactOccurred()
    }
}
