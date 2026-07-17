import WatchConnectivity
import Foundation

final class WatchSessionManager: NSObject, WCSessionDelegate, ObservableObject, Sendable {
    static let shared = WatchSessionManager()

    override init() {
        super.init()
        if WCSession.isSupported() {
            WCSession.default.delegate = self
            WCSession.default.activate()
        }
    }

    /// Push glucose reading to Watch for complication update
    func pushToWatch(_ reading: GlucoseReading, iob: String? = nil, cob: String? = nil, sparkline: [Int]? = nil, prediction: [Int]? = nil) {
        guard WCSession.default.activationState == .activated else { return }

        var payload = reading.watchPayload
        if let iob { payload["iob"] = iob }
        if let cob { payload["cob"] = cob }
        if let sparkline { payload["sparkline"] = sparkline }
        if let prediction { payload["prediction"] = prediction }

        // Use transferCurrentComplicationUserInfo for guaranteed delivery
        // Budget: ~50/day, highest priority for complication updates
        if WCSession.default.isComplicationEnabled {
            WCSession.default.transferCurrentComplicationUserInfo(payload)
        }

        // Also update application context for Watch app foreground use
        try? WCSession.default.updateApplicationContext(payload)
    }

    // MARK: - WCSessionDelegate (iOS)

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        if let error {
            print("WCSession activation failed: \(error)")
        }
    }

    func sessionDidBecomeInactive(_ session: WCSession) {}
    func sessionDidDeactivate(_ session: WCSession) {
        // Re-activate for device switching
        WCSession.default.activate()
    }
}
