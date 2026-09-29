import SwiftUI
import UserNotifications
import WidgetKit

@main
struct ClearSugarApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @Environment(\.scenePhase) private var scenePhase
    @State private var authManager = AuthManager.shared

    private let accentPurple = Color(red: 0.486, green: 0.302, blue: 1.0) // #7c4dff

    var body: some Scene {
        WindowGroup {
            Group {
                if authManager.isAuthenticated {
                    TabView {
                        ContentView()
                            .tabItem {
                                Label("Glucose", systemImage: "house.fill")
                            }

                        SettingsView()
                            .tabItem {
                                Label("Settings", systemImage: "gearshape.fill")
                            }
                    }
                    .tint(accentPurple)
                } else {
                    SetupView {
                        // Auth completed — AuthManager state drives the switch
                    }
                }
            }
            .preferredColorScheme(.dark)
            .onChange(of: scenePhase) { _, newPhase in
                switch newPhase {
                case .active:
                    Task { @MainActor in
                        // Proactive JWT refresh (re-login banner if it fails)
                        await AuthManager.shared.refreshTokenIfNeeded()
                        // End Live Activities whose content is over an hour old
                        LiveActivityManager.shared.endIfAbandoned()
                        LiveActivityManager.shared.resyncUpdateTokens()
                        LiveActivityManager.shared.collapseDuplicates()
                        await SnoozeManager.refreshFromServer()
                    }
                case .background:
                    BackgroundRefreshManager.shared.scheduleNextRefresh()
                default:
                    break
                }
            }
        }
    }
}

class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        // Initialize WatchConnectivity
        _ = WatchSessionManager.shared

        // Register background refresh
        BackgroundRefreshManager.shared.register()

        // Install Live Activity observers once (push-to-start token + activity
        // updates → update-token registration + duplicate collapse).
        Task { @MainActor in LiveActivityManager.shared.installObserversIfNeeded() }

        // Set notification delegate for snooze/acknowledge actions
        UNUserNotificationCenter.current().delegate = self

        // Request notification permissions (including criticalAlert) and register for remote push
        Task { @MainActor in
            AlertManager.shared.requestPermissions()
            UIApplication.shared.registerForRemoteNotifications()
        }

        // Sync alert thresholds to server (per-device)
        Task { await ThresholdSyncer.sync() }

        return true
    }

    // Handle notification actions (snooze, acknowledge)
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        switch response.actionIdentifier {
        case "ACK":
            // Acknowledge — clear pending repeats AND tell the server. Before
            // build 13 the server never heard about acks, so it kept alerting
            // this phone on its own schedule. Per-device semantics: only THIS
            // phone goes quiet for the acked type's cooldown; other phones and
            // escalation to a more urgent type are unaffected.
            center.removePendingNotificationRequests(withIdentifiers: ["urgent-glucose-repeat"])
            let alertType = response.notification.request.content.userInfo["alertType"] as? String
            await AckManager.postAck(alertType: alertType)
        case "SNOOZE_30":
            await SnoozeManager.postSnooze(durationMinutes: 30)
        case "SNOOZE_60":
            await SnoozeManager.postSnooze(durationMinutes: 60)
        case "SNOOZE_RANGE":
            await SnoozeManager.postSnooze(untilRange: true)

        default:
            break
        }
    }

    // Show notifications even when app is in foreground
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        // A server push arriving proves the push pipeline is alive → keeps the
        // local backstop alerter quiet (local requests carry no trigger... but
        // remote ones have a distinct trigger class).
        if notification.request.trigger is UNPushNotificationTrigger {
            Task { @MainActor in AlertManager.recordServerPush() }
        }
        completionHandler([.banner, .sound, .badge])
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        BackgroundRefreshManager.shared.scheduleNextRefresh()
    }

    // Called by iOS when APNs assigns a regular device token (not a Live Activity token)
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let tokenString = deviceToken.map { String(format: "%02x", $0) }.joined()

        // Persist token so ThresholdSyncer can include it in preferences POST
        UserDefaults.standard.set(tokenString, forKey: "apnsAlertToken")
        Task {
            await AlertTokenRegistrar.register(token: tokenString)
            // Re-sync thresholds now that we have the token
            await ThresholdSyncer.sync()
        }
    }

    // Silent background push — wakes app to refresh widgets and Watch
    func application(
        _ application: UIApplication,
        didReceiveRemoteNotification userInfo: [AnyHashable: Any],
        fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
    ) {
        // The ~5-min silent push is the backstop's liveness signal (see
        // LocalAlertGate): while these arrive, local glucose alerts stay quiet.
        Task { @MainActor in AlertManager.recordServerPush() }
        Task {
            do {
                async let latestTask = APIClient.shared.fetchLatestGlucose()
                async let historyTask = APIClient.shared.fetchGlucoseHistory(hours: 24)
                async let iobTask = APIClient.shared.fetchIOBCOB()
                async let predTask = APIClient.shared.fetchAutoPrediction(horizon: 30)

                let reading = try await latestTask
                let history = (try? await historyTask) ?? []
                let iobcob = try? await iobTask
                let prediction = try? await predTask

                let iobText = iobcob?.iobDisplay
                let cobText = iobcob?.cobDisplay

                await MainActor.run {
                    // Update app badge with current glucose
                    UIApplication.shared.applicationIconBadgeNumber = reading.isValid ? reading.sgv : 0

                    // iOS 26+ urgent-low AlarmKit alarm (this path skips
                    // AlertManager.evaluate, so hook the alarm gate directly)
                    AlertManager.shared.recordGlucoseUpdate(latest: reading)

                    // Update Live Activity
                    LiveActivityManager.shared.startOrUpdate(
                        with: reading,
                        history: history,
                        prediction: prediction,
                        iob: iobText,
                        cob: cobText
                    )

                    // Save to offline cache + reload widgets
                    GlucoseStore.shared.save(reading)
                    let sparkline = Array(history.prefix(36).reversed()).map { $0.sgv }
                    GlucoseStore.shared.saveSparklineForWidgets(sparkline)
                    GlucoseStore.shared.saveIOBCOBForWidgets(iob: iobText, cob: cobText)
                    if let pred = prediction {
                        GlucoseStore.shared.savePredictionForWidgets(pred.points.map { Int($0.predicted) })
                    }
                    WidgetCenter.shared.reloadAllTimelines()

                }

                // Push to Watch
                let watchSparkline = Array(history.prefix(288).reversed()).map { $0.sgv }
                let watchPrediction: [Int]? = prediction?.points.map { Int($0.predicted) }
                WatchSessionManager.shared.pushToWatch(reading, iob: iobText, cob: cobText, sparkline: watchSparkline, prediction: watchPrediction)

                completionHandler(.newData)
            } catch {
                completionHandler(.failed)
            }
        }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        debugLog("APNs device token registration failed: \(error.localizedDescription)")
    }
}

/// Applies the strongest available credential to a background request.
///
/// Prefers the Bearer JWT, because it carries a `sub` claim the server
/// can attribute to a person. Push recipients key on that identity, so an APNs
/// token rotated by a TestFlight upgrade re-links to the right owner instead of
/// silently dropping out of the recipient list — the 2026-07-18 failure mode.
///
/// Falls back to the paired Keychain API key, which is what a phone holds before
/// its first sign-in and after a JWT expires. The fallback is deliberate: a
/// registration path that can fail closed would leave a phone unable to receive
/// any alert at all.
///
/// Credentials are read from the paired installation's Keychain.
enum ServerAuth {
    static func apply(to request: inout URLRequest) {
        if let jwt = AuthManager.loadFromKeychain(service: AppConfig.jwtKeychainService),
           !jwt.isEmpty {
            request.setValue("Bearer \(jwt)", forHTTPHeaderField: "Authorization")
        } else if let key = AuthManager.loadFromKeychain(service: AppConfig.apiKeyKeychainService),
                  !key.isEmpty {
            request.setValue(key, forHTTPHeaderField: "X-API-Key")
        }
    }
}

/// Posts a regular APNs device token to the ClearSugar server for clinical alert delivery.
enum AlertTokenRegistrar {
    static func register(token: String) async {
        guard let url = URL(string: "\(AppConfig.serverURLString)/api/push/register-alert") else { return }

        let deviceName = UIDevice.current.name
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        ServerAuth.apply(to: &request)
        request.httpBody = try? JSONSerialization.data(withJSONObject: [
            "token": token,
            "device": deviceName,
            // Keys the token to this install server-side: a re-register with a
            // new token REPLACES this install's old one (registration, prefs,
            // high-alert recipient slot) instead of accumulating — 8 tokens had
            // piled up for 3 phones by 2026-07-24.
            "installId": InstallIdentity.current(),
        ])
        request.timeoutInterval = 10

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse {
                debugLog("Alert token registered: \(http.statusCode) - \(String(data: data, encoding: .utf8) ?? "")")
            }
        } catch {
            debugLog("Alert token registration failed: \(error.localizedDescription)")
        }
    }
}

/// Posts a per-device acknowledge: quiets THIS phone for the acked alert
/// type's cooldown, server-side. Other phones keep alerting, and a more urgent
/// category still fires here — an ack can never mask a worsening low.
enum AckManager {
    static func postAck(alertType: String?) async {
        guard let alertType, !alertType.isEmpty,
              let token = UserDefaults.standard.string(forKey: "apnsAlertToken"),
              let url = URL(string: "\(AppConfig.serverURLString)/api/alerts/ack") else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        ServerAuth.apply(to: &request)
        request.httpBody = try? JSONSerialization.data(withJSONObject: [
            "token": token,
            "alertType": alertType,
            "device": UIDevice.current.name,
        ])
        request.timeoutInterval = 10

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse {
                debugLog("Ack posted (\(alertType)): \(http.statusCode) - \(String(data: data, encoding: .utf8) ?? "")")
            }
        } catch {
            debugLog("Ack post failed: \(error.localizedDescription)")
        }
    }
}

/// Posts snooze requests to the ClearSugar server to silence glucose alerts.
enum SnoozeManager {

    static func postSnooze(durationMinutes: Int = 60, untilRange: Bool = false) async {
        // Mirror locally FIRST so the on-device backstop honors the snooze even
        // if the POST fails — offline is exactly when the backstop alerter runs.
        await MainActor.run {
            AlertManager.recordLocalSnooze(
                until: untilRange ? nil : Date().addingTimeInterval(TimeInterval(durationMinutes) * 60),
                untilRange: untilRange
            )
        }
        guard let url = URL(string: "\(AppConfig.serverURLString)/api/alerts/snooze") else { return }

        let deviceName = UIDevice.current.name
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        ServerAuth.apply(to: &request)

        var body: [String: Any] = [
            "device": deviceName,
            "categories": ["all"],
        ]
        if untilRange {
            body["untilRange"] = true
        } else {
            body["duration"] = durationMinutes
        }
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        request.timeoutInterval = 10

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse {
                debugLog("Snooze posted: \(http.statusCode) - \(String(data: data, encoding: .utf8) ?? "")")
            }
        } catch {
            debugLog("Snooze post failed: \(error.localizedDescription)")
        }

        // Also clear pending local repeat notifications
        UNUserNotificationCenter.current().removePendingNotificationRequests(
            withIdentifiers: ["urgent-glucose-repeat"]
        )
    }

    /// Pull the shared snooze state so a snooze set from ANOTHER phone (or the
    /// website) also quiets this phone's local backstop. Called on foreground.
    static func refreshFromServer() async {
        guard let url = URL(string: "\(AppConfig.serverURLString)/api/alerts/snooze") else { return }
        var request = URLRequest(url: url)
        ServerAuth.apply(to: &request)
        request.timeoutInterval = 10

        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }

        let active = obj["active"] as? Bool ?? false
        let untilMs = obj["snoozedUntil"] as? Double ?? 0
        let untilRange = obj["untilRange"] as? Bool ?? false
        await MainActor.run {
            AlertManager.recordLocalSnooze(
                until: active && untilMs > 0 ? Date(timeIntervalSince1970: untilMs / 1000) : nil,
                untilRange: active && untilRange
            )
        }
    }
}

/// Syncs per-device glucose alert thresholds to the ClearSugar server.
/// Called on app launch and whenever thresholds change in Settings.
enum ThresholdSyncer {

    static func sync() async {
        guard let url = URL(string: "\(AppConfig.serverURLString)/api/alerts/preferences") else { return }

        let defaults = UserDefaults.standard

        // APNs token is the stable unique key on the server; skip if not yet registered
        guard let apnsToken = defaults.string(forKey: "apnsAlertToken"), !apnsToken.isEmpty else {
            debugLog("Threshold sync skipped: APNs token not yet available")
            return
        }

        let deviceName = UIDevice.current.name

        // Read thresholds from UserDefaults (same keys as @AppStorage in SettingsView)
        let urgentLow = defaults.double(forKey: "thresholdUrgentLow")
        let low = defaults.double(forKey: "thresholdLow")
        let high = defaults.double(forKey: "thresholdHigh")
        let urgentHigh = defaults.double(forKey: "thresholdUrgentHigh")

        let body: [String: Any] = [
            "token": apnsToken,
            "device": deviceName,
            "thresholdUrgentLow": urgentLow > 0 ? urgentLow : 55,
            "thresholdLow": low > 0 ? low : 70,
            "thresholdHigh": high > 0 ? high : 180,
            "thresholdUrgentHigh": urgentHigh > 0 ? urgentHigh : 250,
        ]

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        ServerAuth.apply(to: &request)
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        request.timeoutInterval = 10

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse {
                debugLog("Thresholds synced: \(http.statusCode) - \(String(data: data, encoding: .utf8) ?? "")")
            }
        } catch {
            debugLog("Threshold sync failed: \(error.localizedDescription)")
        }
    }
}
