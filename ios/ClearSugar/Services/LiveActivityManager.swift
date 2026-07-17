import ActivityKit
import UIKit
import Foundation
import Security

// GlucoseActivityAttributes lives in Shared/GlucoseActivityAttributes.swift
// (compiled into both the app and the widget extension).

@MainActor
final class LiveActivityManager {
    static let shared = LiveActivityManager()

    private var currentActivity: Activity<GlucoseActivityAttributes>?

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
        // Build sparkline from history (every 5-min reading, oldest first for charting)
        let sparkline: [Int]
        if history.isEmpty {
            sparkline = [reading.sgv]
        } else {
            let historyReversed = Array(history.prefix(36).reversed())
            sparkline = historyReversed.map { $0.sgv }
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
                print("LiveActivity started with push token support")

                // Observe push token and send to server
                Task {
                    for await token in activity.pushTokenUpdates {
                        let tokenString = token.map { String(format: "%02x", $0) }.joined()
                        print("Live Activity push token: \(tokenString.prefix(16))…")
                        await self.registerPushToken(tokenString)
                    }
                }
            } catch {
                print("LiveActivity push token mode failed: \(error). Falling back to local-only.")
                do {
                    let activity = try Activity.request(
                        attributes: attributes,
                        content: content,
                        pushType: nil
                    )
                    currentActivity = activity
                    print("LiveActivity started in local-only mode")
                } catch {
                    print("LiveActivity start failed: \(error)")
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

    // TODO(iOS 18 broadcast channels): ActivityKit broadcast push channels
    // could replace per-device token registration when several followers watch
    // the same patient — needs server-side channel management first; deferred.

    /// Send the Live Activity push token to the ClearSugar server so it can
    /// drive updates via APNs. Skipped when no credential is stored.
    private func registerPushToken(_ token: String) async {
        guard let base = AppConfig.serverURL else { return }
        let url = base.appendingPathComponent("api/push/register")

        // Name the device after the signed-in user when known, else the device
        let deviceName = Self.loggedInUserName()

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["pushToken": token, "device": deviceName])
        request.timeoutInterval = 10

        // Apply auth: prefer Bearer JWT, fall back to API key
        if let jwt = Self.readKeychain(service: AppConfig.jwtKeychainService, account: "jwt"), !jwt.isEmpty {
            request.setValue("Bearer \(jwt)", forHTTPHeaderField: "Authorization")
        } else if let key = Self.readKeychain(service: AppConfig.apiKeyKeychainService, account: "apikey"), !key.isEmpty {
            request.setValue(key, forHTTPHeaderField: "X-API-Key")
        } else {
            print("Push token registration skipped: no stored credential")
            return
        }

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            if let httpResponse = response as? HTTPURLResponse {
                let bodyStr = String(data: data, encoding: .utf8) ?? ""
                print("Push token: \(httpResponse.statusCode) - \(bodyStr)")
            }
        } catch {
            print("Push token registration failed: \(error.localizedDescription)")
        }
    }

    /// Get the signed-in user's name from the stored JWT (or fall back to device name)
    private static func loggedInUserName() -> String {
        guard let jwt = readKeychain(service: AppConfig.jwtKeychainService, account: "jwt") else {
            // No JWT — fall back to device name
            return UIDevice.current.name
        }
        // Decode JWT payload to get the "name" or "sub" (username) claim
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
