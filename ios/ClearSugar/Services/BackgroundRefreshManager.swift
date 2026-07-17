import BackgroundTasks
import UIKit
import WidgetKit
import Foundation

final class BackgroundRefreshManager: Sendable {
    static let shared = BackgroundRefreshManager()

    /// Base refresh interval; consecutive failures back off to 10 then 15 min.
    private static let baseIntervalMinutes = 5
    private static let maxIntervalMinutes = 15
    private static let failureCountKey = "bgRefreshFailureCount"

    private init() {}

    func register() {
        BGTaskScheduler.shared.register(
            forTaskWithIdentifier: AppConfig.backgroundRefreshTaskID,
            using: nil
        ) { task in
            guard let refreshTask = task as? BGAppRefreshTask else { return }
            self.handleRefresh(refreshTask)
        }
    }

    func scheduleNextRefresh() {
        // Back off on consecutive failures: 5 → 10 → 15 min (reset on success)
        let failures = UserDefaults.standard.integer(forKey: Self.failureCountKey)
        let minutes = min(Self.maxIntervalMinutes, Self.baseIntervalMinutes * (failures + 1))

        let request = BGAppRefreshTaskRequest(identifier: AppConfig.backgroundRefreshTaskID)
        // iOS throttles based on app usage patterns;
        // push notifications handle real-time updates via Dynamic Island
        request.earliestBeginDate = Date(timeIntervalSinceNow: Double(minutes) * 60)
        do {
            try BGTaskScheduler.shared.submit(request)
        } catch {
            print("Failed to schedule background refresh: \(error)")
        }
    }

    private func recordOutcome(success: Bool) {
        let defaults = UserDefaults.standard
        if success {
            defaults.set(0, forKey: Self.failureCountKey)
        } else {
            defaults.set(defaults.integer(forKey: Self.failureCountKey) + 1, forKey: Self.failureCountKey)
        }
        // Re-submit with the updated backoff (same identifier replaces the
        // request scheduled at the start of handleRefresh).
        scheduleNextRefresh()
    }

    private func handleRefresh(_ task: BGAppRefreshTask) {
        // Schedule the next refresh immediately (safety net if we expire);
        // recordOutcome() re-submits with the correct backoff afterwards.
        scheduleNextRefresh()

        let refreshTask = Task {
            do {
                // Fetch glucose, history, IOB/COB, and prediction concurrently
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

                // Update Live Activity (Dynamic Island)
                await MainActor.run {
                    LiveActivityManager.shared.startOrUpdate(
                        with: reading,
                        history: history,
                        prediction: prediction,
                        iob: iobText,
                        cob: cobText
                    )
                }

                // Save to offline cache + widgets
                await MainActor.run {
                    GlucoseStore.shared.save(reading)
                    let sparkline = Array(history.prefix(36).reversed()).map { $0.sgv }
                    GlucoseStore.shared.saveSparklineForWidgets(sparkline)
                    GlucoseStore.shared.saveIOBCOBForWidgets(iob: iobText, cob: cobText)
                    if let pred = prediction {
                        GlucoseStore.shared.savePredictionForWidgets(pred.points.map { Int($0.predicted) })
                    }
                    WidgetCenter.shared.reloadAllTimelines()
                }

                // Push to Watch (history already has 24h)
                let watchSparkline = Array(history.prefix(288).reversed()).map { $0.sgv }
                let watchPrediction: [Int]? = prediction?.points.map { Int($0.predicted) }
                WatchSessionManager.shared.pushToWatch(reading, iob: iobText, cob: cobText, sparkline: watchSparkline, prediction: watchPrediction)

                // Update app badge with current glucose
                await MainActor.run {
                    UIApplication.shared.applicationIconBadgeNumber = reading.sgv
                }

                // Evaluate alerts + re-arm the dead-man watchdog
                await MainActor.run {
                    AlertManager.shared.evaluate(reading)
                    AlertManager.shared.rearmDataWatchdog(latest: reading)
                }

                recordOutcome(success: true)
                task.setTaskCompleted(success: true)
            } catch {
                recordOutcome(success: false)
                task.setTaskCompleted(success: false)
            }
        }

        task.expirationHandler = {
            refreshTask.cancel()
        }
    }
}
