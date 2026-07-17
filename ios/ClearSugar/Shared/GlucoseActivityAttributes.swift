import ActivityKit
import Foundation

/// Live Activity attributes shared between the iOS app (which starts/updates
/// the activity) and the widget extension (which renders it).
struct GlucoseActivityAttributes: ActivityAttributes {
    /// Static data that doesn't change during the activity
    struct ContentState: Codable, Hashable {
        let sgv: Int
        let trendArrow: String
        let delta: String
        let timestamp: TimeInterval  // Unix epoch seconds (avoids Date decoding issues with APNs)
        let rangeCategory: RangeCategory
        let sparklineValues: [Int]       // Last 3h of sgv values (every 5 min, ~36 points)
        let predictionValues: [Int]?     // Next N-min predicted values (every 5 min)
        let predictedSgv: Int?           // Predicted value at horizon
        let predictionMinutes: Int?      // Prediction horizon (e.g. 30)
        let iob: String?                 // Insulin on board display, e.g. "8.5u"
        let cob: String?                 // Carbs on board display, e.g. "85g"
    }
}
