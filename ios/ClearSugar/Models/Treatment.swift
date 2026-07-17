import Foundation

// MARK: - Treatment Model

struct Treatment: Codable, Sendable, Identifiable {
    let _id: String
    let eventType: String?    // "Bolus", "Meal Bolus", "Carb Correction", "Temp Basal", "Site Change"
    let insulin: Double?      // bolus units
    let carbs: Double?        // grams
    let rate: Double?         // temp basal rate U/hr
    let duration: Double?     // temp basal duration minutes
    let created_at: String    // ISO date string

    var id: String { _id }

    // MARK: - Computed Properties

    var timestamp: Date {
        // Try ISO 8601 with fractional seconds first, then without
        let formatters: [ISO8601DateFormatter] = {
            let full = ISO8601DateFormatter()
            full.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            let basic = ISO8601DateFormatter()
            basic.formatOptions = [.withInternetDateTime]
            return [full, basic]
        }()
        for formatter in formatters {
            if let date = formatter.date(from: created_at) {
                return date
            }
        }
        // Fallback: try DateFormatter with common Nightscout format
        let fallback = DateFormatter()
        fallback.dateFormat = "yyyy-MM-dd'T'HH:mm:ss.SSSZ"
        fallback.locale = Locale(identifier: "en_US_POSIX")
        if let date = fallback.date(from: created_at) {
            return date
        }
        return Date.distantPast
    }

    var isBolus: Bool {
        insulin != nil && (insulin ?? 0) > 0
    }

    var isCarb: Bool {
        carbs != nil && (carbs ?? 0) > 0
    }

    var isTempBasal: Bool {
        eventType == "Temp Basal"
    }

    // MARK: - Display Helpers

    var bolusLabel: String {
        guard let units = insulin, units > 0 else { return "" }
        if units == units.rounded() {
            return "\(Int(units))u"
        }
        return String(format: "%.1fu", units)
    }

    var carbLabel: String {
        guard let grams = carbs, grams > 0 else { return "" }
        return "\(Int(grams))g"
    }

    var basalRateLabel: String {
        guard let r = rate else { return "" }
        return String(format: "%.2f U/hr", r)
    }
}
