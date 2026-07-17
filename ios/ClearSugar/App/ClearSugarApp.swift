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

        // Set notification delegate for snooze/acknowledge actions
        UNUserNotificationCenter.current().delegate = self

        // Request notification permissions (including criticalAlert) and register for remote push.
        // Push is optional — everything degrades gracefully if registration fails.
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
            // Acknowledge — clear pending repeats
            center.removePendingNotificationRequests(withIdentifiers: ["urgent-glucose-repeat"])
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
        completionHandler([.banner, .sound, .badge])
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        BackgroundRefreshManager.shared.scheduleNextRefresh()
    }

    // Called by iOS when APNs assigns a regular device token (not a Live Activity token)
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let tokenString = deviceToken.map { String(format: "%02x", $0) }.joined()
        print("APNs device token: \(tokenString.prefix(16))…")
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
                    UIApplication.shared.applicationIconBadgeNumber = reading.sgv

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

                    // Dead-man watchdog: fires if no data arrives for 25 min
                    AlertManager.shared.rearmDataWatchdog()
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
        // Expected on free developer accounts and simulators — push is optional
        print("APNs device token registration failed: \(error.localizedDescription)")
    }
}

/// Applies the stored credential (Bearer JWT preferred, then API key) to a request.
/// Returns false when nothing is stored — callers should skip the request.
enum StoredCredential {
    static func apply(to request: inout URLRequest) -> Bool {
        if let jwt = AuthManager.loadFromKeychain(service: AppConfig.jwtKeychainService), !jwt.isEmpty {
            request.setValue("Bearer \(jwt)", forHTTPHeaderField: "Authorization")
            return true
        }
        if let key = AuthManager.loadFromKeychain(service: AppConfig.apiKeyKeychainService), !key.isEmpty {
            request.setValue(key, forHTTPHeaderField: "X-API-Key")
            return true
        }
        return false
    }
}

/// Posts a regular APNs device token to the ClearSugar server for clinical alert delivery.
enum AlertTokenRegistrar {
    static func register(token: String) async {
        guard let base = AppConfig.serverURL else { return }
        let url = base.appendingPathComponent("api/push/register-alert")

        let deviceName = UIDevice.current.name
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        guard StoredCredential.apply(to: &request) else {
            print("Alert token registration skipped: no stored credential")
            return
        }
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["token": token, "device": deviceName])
        request.timeoutInterval = 10

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse {
                print("Alert token registered: \(http.statusCode) - \(String(data: data, encoding: .utf8) ?? "")")
            }
        } catch {
            print("Alert token registration failed: \(error.localizedDescription)")
        }
    }
}

/// Posts snooze requests to the ClearSugar server to silence glucose alerts.
enum SnoozeManager {
    static func postSnooze(durationMinutes: Int = 60, untilRange: Bool = false) async {
        defer {
            // Always clear pending local repeat notifications
            UNUserNotificationCenter.current().removePendingNotificationRequests(
                withIdentifiers: ["urgent-glucose-repeat"]
            )
        }

        guard let base = AppConfig.serverURL else { return }
        let url = base.appendingPathComponent("api/alerts/snooze")

        let deviceName = UIDevice.current.name
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        guard StoredCredential.apply(to: &request) else {
            print("Snooze skipped: no stored credential")
            return
        }

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
                print("Snooze posted: \(http.statusCode) - \(String(data: data, encoding: .utf8) ?? "")")
            }
        } catch {
            print("Snooze post failed: \(error.localizedDescription)")
        }
    }
}

/// Syncs per-device glucose alert thresholds to the ClearSugar server
/// (POST /api/alerts/preferences). Called on app launch and whenever
/// thresholds change in Settings.
enum ThresholdSyncer {
    static func sync() async {
        guard let base = AppConfig.serverURL else { return }
        let url = base.appendingPathComponent("api/alerts/preferences")

        let defaults = UserDefaults.standard

        // APNs token is the stable unique key on the server; skip if not yet registered
        guard let apnsToken = defaults.string(forKey: "apnsAlertToken"), !apnsToken.isEmpty else {
            print("Threshold sync skipped: APNs token not yet available")
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
        guard StoredCredential.apply(to: &request) else {
            print("Threshold sync skipped: no stored credential")
            return
        }
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        request.timeoutInterval = 10

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse {
                print("Thresholds synced: \(http.statusCode) - \(String(data: data, encoding: .utf8) ?? "")")
            }
        } catch {
            print("Threshold sync failed: \(error.localizedDescription)")
        }
    }
}
