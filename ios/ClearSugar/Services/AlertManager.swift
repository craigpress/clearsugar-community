import Foundation
import UserNotifications
import UIKit

@MainActor
final class AlertManager: ObservableObject {
    static let shared = AlertManager()

    @Published var lastAlertedSgv: Int?
    @Published var isNotificationsAuthorized = false

    // Cooldown stamps are persisted: as instance vars they reset on every app
    // relaunch, which re-armed all local alerts each time iOS cycled the
    // process (one of the 2026-07-24 storm ingredients).
    private var lastUrgentAlertDate: Date? {
        get { Self.persistedDate("lastUrgentAlertDate") }
        set { Self.setPersistedDate("lastUrgentAlertDate", newValue) }
    }
    private var lastWarningAlertDate: Date? {
        get { Self.persistedDate("lastWarningAlertDate") }
        set { Self.setPersistedDate("lastWarningAlertDate", newValue) }
    }
    private var lastPumpStaleAlertDate: Date? {
        get { Self.persistedDate("lastPumpStaleAlertDate") }
        set { Self.setPersistedDate("lastPumpStaleAlertDate", newValue) }
    }

    private static func persistedDate(_ key: String) -> Date? {
        let t = UserDefaults.standard.double(forKey: key)
        return t > 0 ? Date(timeIntervalSince1970: t) : nil
    }
    private static func setPersistedDate(_ key: String, _ date: Date?) {
        if let date {
            UserDefaults.standard.set(date.timeIntervalSince1970, forKey: key)
        } else {
            UserDefaults.standard.removeObject(forKey: key)
        }
    }

    // MARK: - Backstop gating state (see LocalAlertGate)

    /// Stamp that a server push (silent background or alert) just arrived —
    /// proof the push pipeline is alive, which keeps the local backstop quiet.
    static func recordServerPush() {
        UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: "lastServerPushAt")
    }

    /// Local mirror of the server snooze so the backstop honors silencing even
    /// when the server can't be reached (which is exactly when it runs).
    static func recordLocalSnooze(until: Date?, untilRange: Bool) {
        if let until {
            UserDefaults.standard.set(until.timeIntervalSince1970, forKey: "localSnoozeUntil")
        } else {
            UserDefaults.standard.removeObject(forKey: "localSnoozeUntil")
        }
        UserDefaults.standard.set(untilRange, forKey: "localSnoozeUntilRange")
    }

    private var backstopMayFire: Bool {
        LocalAlertGate.mayFire(
            now: Date(),
            lastServerPush: Self.persistedDate("lastServerPushAt"),
            snoozedUntil: Self.persistedDate("localSnoozeUntil"),
            snoozedUntilRange: UserDefaults.standard.bool(forKey: "localSnoozeUntilRange")
        )
    }
    /// Avoid frequent repeats during a prolonged pump-sync outage.
    private let pumpStaleCooldownInterval: TimeInterval = 3 * 60 * 60
    private let urgentRepeatInterval: TimeInterval = 60
    private let warningCooldownInterval: TimeInterval = 30 * 60 // 30 minutes

    private init() {
        Self.retireLegacyDataWatchdog()
    }

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
                    debugLog("Notification permission error: \(error)")
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

        let mealText = UNTextInputNotificationAction(
            identifier: "MEAL_TEXT",
            title: "What did you eat?",
            options: [],
            textInputButtonTitle: "Send",
            textInputPlaceholder: "Type or dictate"
        )
        let mealWithBolus = UNNotificationAction(
            identifier: "MEAL_WITH_BOLUS",
            title: "Ate with bolus",
            options: []
        )
        let meal15Later = UNNotificationAction(
            identifier: "MEAL_15_LATER",
            title: "Ate 15+ min later",
            options: []
        )
        // .foreground because the photo flow needs the camera and the meal sheet.
        let mealPhoto = UNNotificationAction(
            identifier: "MEAL_PHOTO",
            title: "Add photo",
            options: [.foreground]
        )
        // .customDismissAction so a swipe-away is reported and recorded as a
        // "dismiss" reply — an ignored prompt and a declined one are different
        // labels for Phase 4.
        let mealPromptCategory = UNNotificationCategory(
            identifier: "MEAL_PROMPT",
            actions: [mealText, mealWithBolus, meal15Later, mealPhoto],
            intentIdentifiers: [],
            options: .customDismissAction
        )

        center.setNotificationCategories([urgentCategory, warningCategory, mealPromptCategory])
    }

    // MARK: - Evaluate Reading

    func evaluate(_ reading: GlucoseReading) {
        // A sensor error is not a glucose value. sgv = 0 (Dexcom/Nightscout
        // sentinel, and the watch payload's `?? 0` default) is below every low
        // threshold, so without this gate a sensor fault fired "URGENT LOW —
        // 0 mg/dL — Treat immediately with fast carbs", repeated it after 60 s,
        // and armed the AlarmKit alarm that sounds through Silent and Focus.
        // Telling someone to treat a low that isn't happening is the one
        // failure this path must never produce.
        //
        // The separate pump-age check below still runs for invalid CGM data.
        if reading.isValid {
            // iOS 26+ urgent-low AlarmKit alarm (no-op below iOS 26 or when disabled)
            UrgentLowAlarmGate.evaluate(reading, urgentLowThreshold: thresholdUrgentLow)

            let sgv = reading.sgv

            // Determine range category using customizable thresholds
            let isUrgentLow = sgv < thresholdUrgentLow
            let isLow = sgv >= thresholdUrgentLow && sgv < thresholdLow
            let isHigh = sgv > thresholdHigh && sgv <= thresholdUrgentHigh
            let isUrgentHigh = sgv > thresholdUrgentHigh
            let isInRange = sgv >= thresholdLow && sgv <= thresholdHigh

            // Backstop gate: while server pushes are arriving, the server owns
            // glucose alerting and a local notification is a duplicate banner
            // for the same reading (2026-07-24 duplicate source #1). Haptics and
            // the AlarmKit urgent-low alarm above stay independent; only the
            // local NOTIFICATIONS defer. See LocalAlertGate.
            let localMayFire = backstopMayFire

            if isUrgentLow || isUrgentHigh {
                if hapticFeedbackEnabled {
                    triggerHaptic(.heavy)
                }
                if alertsUrgentEnabled && localMayFire {
                    sendUrgentAlert(reading, isLow: isUrgentLow)
                }
            } else if isLow {
                if hapticFeedbackEnabled {
                    triggerHaptic(.medium)
                }
                if alertsLowEnabled && localMayFire {
                    sendWarningAlert(reading, type: "Low")
                }
            } else if isHigh {
                if hapticFeedbackEnabled {
                    triggerHaptic(.medium)
                }
                if alertsHighEnabled && localMayFire {
                    sendWarningAlert(reading, type: "High")
                }
            } else if isInRange {
                lastUrgentAlertDate = nil
                lastWarningAlertDate = nil
                UNUserNotificationCenter.current().removeDeliveredNotifications(
                    withIdentifiers: ["urgent-glucose", "warning-glucose"]
                )
            }
        }

        // Sensor-outage notifications use the server reading age, not app wakeups.

        // Pump staleness: 180 min, not 30. tconnectsync pulls from Tandem's
        // cloud, which the pump only uploads to in ~50-min batches, so >30 min
        // is the NORMAL state and the old threshold alerted on healthy
        // operation. Three hours means the sync chain is genuinely broken.
        if let pumpStale = reading.pumpIsStale, pumpStale,
           let pumpMins = reading.pumpStaleMinutes, pumpMins > 180 {
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
        content.title = (isLow ? "Urgent low · " : "Urgent high · ") + "\(reading.sgv) mg/dL \(reading.trendArrow)"
        content.body = isLow ? "Treat now with fast carbs." : "Check the pump; consider a correction."
        content.sound = urgentNotificationSound
        content.interruptionLevel = .critical
        content.categoryIdentifier = "URGENT_GLUCOSE"
        // Same key the server puts in its pushes, so the ACK handler can tell
        // the server which alert type is being acknowledged.
        content.userInfo = ["alertType": isLow ? "urgentLow" : "urgentHigh"]
        content.badge = NSNumber(value: reading.sgv)

        let request = UNNotificationRequest(
            identifier: "urgent-glucose",
            content: content,
            trigger: nil
        )
        UNUserNotificationCenter.current().add(request)

        // Schedule a repeat alert in 1 minute if still urgent
        let repeatContent = UNMutableNotificationContent()
        repeatContent.title = (isLow ? "Still urgent low · " : "Still urgent high · ") + "\(reading.sgv) mg/dL"
        repeatContent.body = "Check glucose now."
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
        content.title = "\(type) · \(reading.sgv) mg/dL \(reading.trendArrow)"
        content.body = type == "Low" ? "Watch for a further drop." : "Watch for a further rise."

        if let sound = warningNotificationSound {
            content.sound = sound
        }
        content.interruptionLevel = .timeSensitive
        content.categoryIdentifier = "GLUCOSE_WARNING"
        content.userInfo = ["alertType": type == "Low" ? "low" : "high"]

        let request = UNNotificationRequest(
            identifier: "warning-glucose",
            content: content,
            trigger: nil
        )
        UNUserNotificationCenter.current().add(request)
    }

    // MARK: - Pump Stale Alert

    private func sendPumpStaleAlert(minutesStale: Int) {
        // Cooldown, which this path never had. Adding a request with an
        // existing identifier replaces the banner but still re-delivers with
        // sound, so an uncooled alert re-fires on every evaluate() for the
        // whole duration of the outage.
        if let last = lastPumpStaleAlertDate,
           Date().timeIntervalSince(last) < pumpStaleCooldownInterval {
            return
        }
        lastPumpStaleAlertDate = Date()

        let content = UNMutableNotificationContent()
        content.title = "Pump data stale"
        content.body = "Nothing for \(minutesStale / 60)h. Control-IQ may not be adjusting insulin."
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

    // MARK: - Fresh readings and legacy notification cleanup

    /// Preserve the urgent-low alarm on foreground, background-refresh and silent-push updates.
    func recordGlucoseUpdate(latest reading: GlucoseReading) {
        UrgentLowAlarmGate.evaluate(reading, urgentLowThreshold: thresholdUrgentLow)
    }

    /// iOS suspension is not evidence of a server or sensor outage. Cancel old
    /// app-silence timers on launch, including ones scheduled by earlier builds.
    static func retireLegacyDataWatchdog(
        removePending: ([String]) -> Void = UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers:),
        removeDelivered: ([String]) -> Void = UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers:)
    ) {
        removePending(["data-watchdog"])
        removeDelivered(["data-watchdog"])
    }

    // MARK: - Haptics

    private func triggerHaptic(_ style: UIImpactFeedbackGenerator.FeedbackStyle) {
        let generator = UIImpactFeedbackGenerator(style: style)
        generator.prepare()
        generator.impactOccurred()
    }
}
