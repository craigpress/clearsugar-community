import ActivityKit
import UIKit
import Foundation
import os

// GlucoseActivityAttributes lives in Shared/GlucoseActivityAttributes.swift
// (compiled into both the app and the widget extension).

@MainActor
final class LiveActivityManager {
    static let shared = LiveActivityManager()

    /// Dedicated log channel for the push-to-start token investigation
    /// (clearsugar-ios#2, START = 400 BadDeviceToken while UPDATE = 200).
    /// Filter in Console.app with:
    private static let tokenLog = Logger(
        subsystem: AppConfig.bundlePrefix, category: "pushtoken"
    )

    private var currentActivity: Activity<GlucoseActivityAttributes>?

    /// Last push-to-start token hex we saw, to prove/disprove the "stale
    /// persisted sandbox token" hypothesis: if this is byte-identical across a
    /// force-quit+reopen, the token is persisted by ActivityKit rather than
    /// freshly minted for this (production) install.
    private var lastStartTokenHex: String?

    /// Last update token the ClearSugar API accepted. Set only on a 2xx, so a
    /// failed registration is retried by the next foreground re-sync rather than
    /// being silently treated as delivered.
    private var lastRegisteredUpdateTokenHex: String?

    private var observersInstalled = false
    private var observerTasks: [Task<Void, Never>] = []

    /// Stale date aligned with CGM cadence (6 minutes between readings)
    private let staleDuration: TimeInterval = 360

    /// End the activity outright once its content is this old (app-wake cleanup)
    private let abandonedAfter: TimeInterval = 60 * 60

    private init() {}

    func startOrUpdate(
        with reading: GlucoseReading,
        history: [GlucoseReading] = [],
        prediction: PredictionResult? = nil,
        iob: String? = nil,
        cob: String? = nil
    ) {
        guard reading.isValid else { return }
        // Build sparkline from history (every 5-min reading, oldest first for charting)
        let sparkline: [Int]
        if history.isEmpty {
            sparkline = [reading.sgv]
        } else {
            let historyReversed = Array(history.prefix(36).reversed())
            sparkline = historyReversed.filter { $0.isValid }.map { $0.sgv }
        }

        // Build prediction values
        let predictionValues: [Int]?
        let predictedSgv: Int?
        let predictionMinutes: Int?

        if let prediction, !prediction.points.isEmpty {
            predictionValues = Array(prediction.points.prefix(6)).map { Int($0.predicted) }
            let horizonMinutes = UserDefaults.standard.object(forKey: "predictionHorizon") as? Int ?? 30
            if let horizonPoint = prediction.points.first(where: { $0.offset >= horizonMinutes }) {
                predictedSgv = Int(horizonPoint.predicted)
            } else if let last = prediction.points.last {
                predictedSgv = Int(last.predicted)
            } else {
                predictedSgv = nil
            }
            predictionMinutes = horizonMinutes
        } else {
            predictionValues = nil
            predictedSgv = nil
            predictionMinutes = nil
        }

        let state = GlucoseActivityAttributes.ContentState(
            sgv: reading.sgv,
            trendArrow: reading.trendArrow,
            delta: reading.deltaString,
            timestamp: reading.timestamp.timeIntervalSince1970,
            rangeCategory: reading.rangeCategory,
            sparklineValues: sparkline,
            predictionValues: predictionValues,
            predictedSgv: predictedSgv,
            predictionMinutes: predictionMinutes,
            iob: iob,
            cob: cob
        )

        let staleDate = Date().addingTimeInterval(staleDuration)

        if let activity = currentActivity, activity.activityState == .active {
            Task {
                await activity.update(
                    ActivityContent(state: state, staleDate: staleDate)
                )
            }
        } else {
            // End all stale/old Live Activities before starting a new one
            // This prevents duplicate entries stacking on the lock screen
            for activity in Activity<GlucoseActivityAttributes>.activities {
                Task {
                    await activity.end(nil, dismissalPolicy: .immediate)
                }
            }

            // Try with push token first (for server-driven updates),
            // fall back to nil if push notifications aren't provisioned yet
            let attributes = GlucoseActivityAttributes()
            let content = ActivityContent(state: state, staleDate: staleDate)

            do {
                let activity = try Activity.request(
                    attributes: attributes,
                    content: content,
                    pushType: .token
                )
                currentActivity = activity
                debugLog("LiveActivity started with push token support")
                // The activityUpdates observer (installObserversIfNeeded) registers
                // this activity's update token — single registration path.
            } catch {
                debugLog("LiveActivity push token mode failed: \(error). Falling back to local-only.")
                do {
                    let activity = try Activity.request(
                        attributes: attributes,
                        content: content,
                        pushType: nil
                    )
                    currentActivity = activity
                    debugLog("LiveActivity started in local-only mode")
                } catch {
                    debugLog("LiveActivity start failed: \(error)")
                }
            }
        }
    }

    func stop() {
        Task {
            await currentActivity?.end(nil, dismissalPolicy: .immediate)
            currentActivity = nil
        }
    }

    /// End any Live Activity whose content is over an hour old. Called when
    /// the app wakes so a dead update pipeline doesn't leave a frozen glucose
    /// number on the lock screen indefinitely (staleDate only dims it).
    func endIfAbandoned() {
        for activity in Activity<GlucoseActivityAttributes>.activities {
            let contentDate = Date(timeIntervalSince1970: activity.content.state.timestamp)
            if Date().timeIntervalSince(contentDate) > abandonedAfter {
                Task {
                    await activity.end(nil, dismissalPolicy: .immediate)
                }
                if activity.id == currentActivity?.id {
                    currentActivity = nil
                }
            }
        }
    }

    // MARK: - Server-driven push-to-start (iOS 17.2+) + observers

    /// Install push-to-start + activity-update observers exactly once. Call from
    /// app launch. Safe to call again (no-ops after the first).
    func installObserversIfNeeded() {
        guard !observersInstalled else { return }
        observersInstalled = true

        if #available(iOS 17.2, *) {
            // Push-to-start token → register so the server can (re)start activities.
            observerTasks.append(Task { [weak self] in
                for await tokenData in Activity<GlucoseActivityAttributes>.pushToStartTokenUpdates {
                    let token = tokenData.map { String(format: "%02x", $0) }.joined()
                    await self?.logStartToken(token)
                    await self?.registerStartToken(token)
                }
            })
        }

        // Any activity already running at launch (e.g. push-started while the app
        // was killed) is NOT replayed by activityUpdates, so adopt those too —
        // otherwise their end is never reported and the server keeps guessing.
        for activity in Activity<GlucoseActivityAttributes>.activities {
            observerTasks.append(Task { [weak self] in await self?.observeActivityState(of: activity) })
            // Build 10 adopted these for lifecycle only, never for their push
            // token, so a card push-started while the app was killed kept the
            // server pushing the PREVIOUS (dead) token — which APNs 200s forever
            // — and the card froze on stale glucose. Observe the token too.
            observerTasks.append(Task { [weak self] in await self?.observeUpdateToken(of: activity) })
        }

        // pushTokenUpdates may not replay a token that already arrived while the
        // app was not running, so read the current one directly as well.
        resyncUpdateTokens()

        // New activities (incl. push-started) → register update tokens + collapse dups.
        observerTasks.append(Task { [weak self] in
            for await activity in Activity<GlucoseActivityAttributes>.activityUpdates {
                self?.currentActivity = activity
                self?.collapseDuplicates()
                // Observe this activity's update token without blocking the loop.
                Task { [weak self] in await self?.observeUpdateToken(of: activity) }
                // …and its lifecycle, so the server learns when the card dies.
                Task { [weak self] in await self?.observeActivityState(of: activity) }
            }
        })
    }

    /// Report the activity's death to the server.
    ///
    /// The server cannot infer this: APNs keeps returning 200 on a dead activity's
    /// update token, so on 2026-07-21 an expired card was never resurrected across
    /// 91 overnight cycles. This ack is the only positive signal that the card is
    /// gone, letting the server send a push-to-start deterministically.
    private func observeActivityState(of activity: Activity<GlucoseActivityAttributes>) async {
        for await state in activity.activityStateUpdates {
            switch state {
            case .ended, .dismissed:
                Self.tokenLog.notice(
                    "activity \(activity.id.prefix(8), privacy: .public) ended (state: \(String(describing: state), privacy: .public)) — acking server"
                )
                await reportActivityEnded()
                return // terminal — this activity will not come back
            case .active, .stale:
                continue
            @unknown default:
                continue
            }
        }
    }

    private func reportActivityEnded() async {
        let bearerJWT = Self.readKeychain(service: AppConfig.jwtKeychainService, account: "jwt")
        await postToken(
            to: "\(AppConfig.serverURLString)/api/push/activity-ended",
            body: ["installId": InstallIdentity.current()],
            bearerToken: bearerJWT,
            apiKey: Self.pairedAPIKey,
            label: "ClearSugar-ended"
        )
    }

    private func observeUpdateToken(of activity: Activity<GlucoseActivityAttributes>) async {
        for await tokenData in activity.pushTokenUpdates {
            let token = tokenData.map { String(format: "%02x", $0) }.joined()
            Self.tokenLog.notice(
                "UPDATE token (works, APNs=200) len=\(token.count, privacy: .public)"
            )
            await registerPushToken(token)
        }
    }

    /// Re-register the live card's update token if the server does not have it.
    ///
    /// Call on launch and on every foreground. `pushTokenUpdates` only yields to a
    /// running process, so a card push-started while the app was killed — or one
    /// whose token rotated while the app was suspended — leaves the server holding
    /// a dead token that APNs still answers 200 to. That is invisible server-side
    /// and freezes the card on stale glucose (2026-07-22). Reading the token
    /// directly from `Activity.activities` is the only way to close that window.
    ///
    /// Cheap to call repeatedly: `tokenToRegister` returns nil unless the newest
    /// card's token differs from the last one we successfully registered.
    func resyncUpdateTokens() {
        let live = Activity<GlucoseActivityAttributes>.activities.map { activity in
            (
                id: activity.id,
                contentTimestamp: activity.content.state.timestamp,
                pushTokenHex: activity.pushToken.map { data in
                    data.map { String(format: "%02x", $0) }.joined()
                }
            )
        }
        guard let token = LiveActivityTokenSync.tokenToRegister(
            activities: live,
            lastRegistered: lastRegisteredUpdateTokenHex
        ) else { return }

        Self.tokenLog.notice(
            "UPDATE token re-sync (adopted, not from stream)"
        )
        Task { await registerPushToken(token) }
    }

    /// Diagnostic for clearsugar-ios#2: emit the push-to-start token so it can be
    /// compared byte-for-byte against the working update token, and flag whether
    /// it is stable across relaunches (a stable value ⇒ ActivityKit is replaying a
    /// persisted token, which after a dev→TestFlight upgrade would still be a
    /// *sandbox* token and get rejected only on START as BadDeviceToken).
    private func logStartToken(_ token: String) {
        let changed = (lastStartTokenHex != nil) && (lastStartTokenHex != token)
        let stability = lastStartTokenHex == nil
            ? "first-seen"
            : (changed ? "CHANGED-since-last" : "UNCHANGED-since-last (persisted?)")
        Self.tokenLog.notice(
            "START token (START=400 BadDeviceToken) len=\(token.count, privacy: .public) \(stability, privacy: .public)"
        )
        lastStartTokenHex = token
    }

    private func registerStartToken(_ token: String) async {
        let installId = InstallIdentity.current()
        let bearerJWT = Self.readKeychain(service: AppConfig.jwtKeychainService, account: "jwt")
        await postToken(
            to: "\(AppConfig.serverURLString)/api/push/register",
            body: ["installId": installId, "pushToStartToken": token, "device": Self.loggedInUserName()],
            bearerToken: bearerJWT,
            apiKey: Self.pairedAPIKey,
            label: "ClearSugar-start"
        )
    }

    /// End all but the newest live activity (uses the pure selection). Primary
    /// anti-stack guarantee when the app is running.
    func collapseDuplicates() {
        let all = Activity<GlucoseActivityAttributes>.activities
        let ids = LiveActivityCollapse.idsToEnd(all.map { ($0.id, $0.content.state.timestamp) })
        guard !ids.isEmpty else { return }
        for activity in all where ids.contains(activity.id) {
            Task { await activity.end(nil, dismissalPolicy: .immediate) }
        }
    }

    /// The paired API key from the Keychain — the fallback when no JWT is held.
    /// Replaces a hardcoded constant that shipped in the binary on every phone
    /// and could not be rotated without a new build.
    private static var pairedAPIKey: String? {
        AuthManager.loadFromKeychain(service: AppConfig.apiKeyKeychainService)
    }

    // TODO(iOS 18 broadcast channels): ActivityKit broadcast push channels
    // could replace per-device token registration when several followers watch
    // the same patient — needs server-side channel management first; deferred.

    /// Send the push token to the persistent ClearSugar API store.
    private func registerPushToken(_ token: String) async {
        // Name the device after the logged-in user (from JWT or fallback)
        let deviceName = Self.loggedInUserName()

        // Read Bearer JWT from Keychain for API auth
        let bearerJWT = Self.readKeychain(service: AppConfig.jwtKeychainService, account: "jwt")

        // Register with ClearSugar API (keyed on install for start↔update pairing)
        let accepted = await postToken(
            to: "\(AppConfig.serverURLString)/api/push/register",
            body: ["installId": InstallIdentity.current(), "pushToken": token, "device": deviceName],
            bearerToken: bearerJWT,
            apiKey: Self.pairedAPIKey,
            label: "ClearSugar"
        )
        // Gate the re-sync dedupe on the ClearSugar API — it is the store the
        // push pipeline reads.
        if accepted { lastRegisteredUpdateTokenHex = token }
    }

    /// Returns true when the endpoint accepted the token (2xx), so callers can tell
    /// a real registration from a swallowed failure.
    @discardableResult
    private func postToken(to urlString: String, body: [String: String], bearerToken: String?, apiKey: String?, label: String) async -> Bool {
        guard AppConfig.isServerConfigured, let url = URL(string: urlString) else { return false }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        request.timeoutInterval = 10

        // Apply auth: prefer Bearer JWT, fall back to API key
        if let jwt = bearerToken, !jwt.isEmpty {
            request.setValue("Bearer \(jwt)", forHTTPHeaderField: "Authorization")
        } else if let key = apiKey, !key.isEmpty {
            request.setValue(key, forHTTPHeaderField: "X-API-Key")
        }

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            if let httpResponse = response as? HTTPURLResponse {
                let bodyStr = String(data: data, encoding: .utf8) ?? ""
                debugLog("Push token (\(label)): \(httpResponse.statusCode) - \(bodyStr)")
                return (200...299).contains(httpResponse.statusCode)
            }
            return false
        } catch {
            debugLog("Push token (\(label)) failed: \(error.localizedDescription)")
            return false
        }
    }

    /// Get the logged-in user's name from the JWT (or fallback to device name)
    private static func loggedInUserName() -> String {
        guard let jwt = readKeychain(service: AppConfig.jwtKeychainService, account: "jwt") else {
            // No JWT — fall back to device name
            return UIDevice.current.name
        }
        // Decode JWT payload to get the "name" or "sub" (email) claim
        let parts = jwt.split(separator: ".")
        guard parts.count == 3 else { return UIDevice.current.name }
        var base64 = String(parts[1])
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        while base64.count % 4 != 0 { base64.append("=") }
        guard let data = Data(base64Encoded: base64),
              let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return UIDevice.current.name
        }
        // Prefer "name", fall back to "sub" (email)
        if let name = payload["name"] as? String, !name.isEmpty {
            return name
        }
        if let sub = payload["sub"] as? String, !sub.isEmpty {
            return sub
        }
        return UIDevice.current.name
    }

    /// Read a value from Keychain directly (uses app group for cross-target access)
    private static func readKeychain(service: String, account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessGroup as String: AppConfig.keychainAccessGroup,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }
}
