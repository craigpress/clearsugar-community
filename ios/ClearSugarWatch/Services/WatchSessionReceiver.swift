import WatchConnectivity
import WidgetKit
import Foundation

final class WatchSessionReceiver: NSObject, WCSessionDelegate, ObservableObject {
    static let shared = WatchSessionReceiver()

    @Published var latestReading: GlucoseReading?
    @Published var latestIOB: String?
    @Published var latestCOB: String?
    @Published var sparklineValues: [Int] = []
    @Published var predictionValues: [Int] = []

    override init() {
        super.init()
        if WCSession.isSupported() {
            WCSession.default.delegate = self
            WCSession.default.activate()
        }
    }

    // MARK: - WCSessionDelegate (watchOS)

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        if let error {
            print("WCSession activation failed: \(error)")
        }
        // Check for any existing application context
        if !session.receivedApplicationContext.isEmpty {
            processPayload(session.receivedApplicationContext)
        }
    }

    /// Receives complication user info transfers (highest priority)
    func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
        processPayload(userInfo)
        // Trigger WidgetKit complication refresh
        WidgetCenter.shared.reloadAllTimelines()
    }

    /// Receives application context updates
    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        processPayload(applicationContext)
    }

    private func processPayload(_ payload: [String: Any]) {
        let reading = GlucoseReading(fromWatchPayload: payload)
        let iob = payload["iob"] as? String
        let cob = payload["cob"] as? String
        let sparkline = payload["sparkline"] as? [Int] ?? []
        let prediction = payload["prediction"] as? [Int] ?? []
        DispatchQueue.main.async {
            self.latestReading = reading
            self.latestIOB = iob
            self.latestCOB = cob
            self.sparklineValues = sparkline
            self.predictionValues = prediction
        }
        // Save to shared UserDefaults for complication access
        saveToSharedStorage(reading)
    }

    private func saveToSharedStorage(_ reading: GlucoseReading) {
        let defaults = AppConfig.sharedDefaults
        defaults.set(reading.sgv, forKey: "latestSgv")
        defaults.set(reading.direction, forKey: "latestDirection")
        defaults.set(reading.date, forKey: "latestDate")
        defaults.set(reading.delta, forKey: "latestDelta")
        // Save sparkline for complications
        if !sparklineValues.isEmpty, let data = try? JSONEncoder().encode(sparklineValues) {
            defaults.set(data, forKey: "watchSparkline")
        }
    }
}
