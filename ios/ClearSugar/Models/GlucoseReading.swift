import Foundation

// MARK: - Prediction Types (shared across all targets)

struct PredictionPoint: Codable, Sendable, Hashable {
    let offset: Int      // minutes from now
    let predicted: Double // predicted glucose
    let low: Double      // 10th percentile
    let high: Double     // 90th percentile
}

struct PredictionResult: Codable, Sendable {
    let points: [PredictionPoint]

    var predictedValueAt30Min: Int? {
        guard let point = points.first(where: { $0.offset >= 30 }) else { return nil }
        return Int(point.predicted)
    }

    func predictedValue(atMinutes minutes: Int) -> Int? {
        guard let point = points.first(where: { $0.offset >= minutes }) else { return nil }
        return Int(point.predicted)
    }
}

// MARK: - Glucose Reading

struct GlucoseReading: Codable, Sendable {
    let sgv: Int
    let direction: String
    let date: TimeInterval // epoch millis
    let dateString: String?
    let delta: Double?
    let pumpLastUpdate: String?
    let pumpStaleMinutes: Int?
    let pumpIsStale: Bool?

    // MARK: - Computed Properties

    var timestamp: Date {
        Date(timeIntervalSince1970: date / 1000)
    }

    var minutesAgo: Int {
        max(0, Int(Date().timeIntervalSince(timestamp) / 60))
    }

    var isStale: Bool {
        minutesAgo > 15
    }

    var trendArrow: String {
        switch direction {
        case "DoubleUp":        return "⇈"
        case "SingleUp":        return "↑"
        case "FortyFiveUp":     return "↗"
        case "Flat":            return "→"
        case "FortyFiveDown":   return "↘"
        case "SingleDown":      return "↓"
        case "DoubleDown":      return "⇊"
        default:                return "→" // Default to flat for unknown
        }
    }

    var trendDescription: String {
        switch direction {
        case "DoubleUp":        return "rising fast"
        case "SingleUp":        return "rising"
        case "FortyFiveUp":     return "rising slowly"
        case "Flat":            return "steady"
        case "FortyFiveDown":   return "falling slowly"
        case "SingleDown":      return "falling"
        case "DoubleDown":      return "falling fast"
        default:                return ""
        }
    }

    /// Whether `sgv` is a real measurement rather than a sensor-error sentinel.
    ///
    /// Dexcom/Nightscout emit 0 on sensor error, and the WatchConnectivity init
    /// below defaults a missing `sgv` to 0. Zero is numerically "below every
    /// low threshold", so every consumer that compares thresholds MUST gate on
    /// this first — otherwise a sensor fault reads as the most severe possible
    /// hypo. See AlertManager.evaluate and UrgentLowAlarmGate.evaluate.
    var isValid: Bool { sgv > 0 && sgv < 600 }

    var rangeCategory: RangeCategory {
        // Display-only fallback. Alert and alarm paths gate on `isValid` and
        // never reach this; do not add clinical decisions here.
        guard isValid else { return .urgentLow } // Sensor error
        switch sgv {
        case ..<55:     return .urgentLow
        case 55..<70:   return .low
        case 70...180:  return .inRange
        case 181...250: return .high
        default:        return .urgentHigh
        }
    }

    var deltaString: String {
        guard let delta else { return "" }
        if delta >= 0 {
            return "+\(Int(delta))"
        } else {
            return "\(Int(delta))"
        }
    }

    /// Natural language status for display
    var statusText: String {
        if isStale {
            return "Data is \(minutesAgo) minutes old"
        }

        let rangeText: String
        switch rangeCategory {
        case .urgentLow:    rangeText = "Urgent low"
        case .low:          rangeText = "Low"
        case .inRange:      rangeText = "In range"
        case .high:         rangeText = "High"
        case .urgentHigh:   rangeText = "Urgent high"
        }

        let trend = trendDescription
        if trend.isEmpty {
            return "\(rangeText)."
        }
        return "\(rangeText) and \(trend)."
    }

    /// Actionable guidance for urgent states
    var urgencyGuidance: String? {
        switch rangeCategory {
        case .urgentLow:
            return "Treat immediately with fast carbs"
        case .urgentHigh:
            return "Check insulin pump, consider correction"
        case .low where direction == "SingleDown" || direction == "DoubleDown":
            return "Glucose dropping — check now"
        default:
            return nil
        }
    }

    // MARK: - Watch Payload

    var watchPayload: [String: Any] {
        var payload: [String: Any] = [
            "sgv": sgv,
            "direction": direction,
            "date": date
        ]
        if let delta {
            payload["delta"] = delta
        }
        if let pumpStaleMinutes {
            payload["pumpStaleMinutes"] = pumpStaleMinutes
        }
        if let pumpIsStale {
            payload["pumpIsStale"] = pumpIsStale
        }
        return payload
    }

    /// Initialize from WatchConnectivity payload
    init(fromWatchPayload payload: [String: Any]) {
        self.sgv = payload["sgv"] as? Int ?? 0
        self.direction = payload["direction"] as? String ?? "NOT COMPUTABLE"
        self.date = payload["date"] as? TimeInterval ?? 0
        self.dateString = nil
        self.delta = payload["delta"] as? Double
        self.pumpLastUpdate = nil
        self.pumpStaleMinutes = payload["pumpStaleMinutes"] as? Int
        self.pumpIsStale = payload["pumpIsStale"] as? Bool
    }

    // MARK: - Accessibility

    var accessibilityDescription: String {
        var parts = ["\(sgv) milligrams per deciliter"]
        let trend = trendDescription
        if !trend.isEmpty {
            parts.append("and \(trend)")
        }
        if let delta {
            parts.append("change of \(Int(delta))")
        }
        parts.append("updated \(minutesAgo) minutes ago")
        return parts.joined(separator: ", ")
    }
}

// MARK: - Range Category

enum RangeCategory: String, Codable, Sendable {
    case urgentLow, low, inRange, high, urgentHigh
}

extension RangeCategory {
    var isUrgent: Bool {
        self == .urgentLow || self == .urgentHigh
    }

    var isOutOfRange: Bool {
        self != .inRange
    }
}
