import SwiftUI
import WidgetKit

struct GlucoseComplicationEntry: TimelineEntry {
    let date: Date
    let sgv: Int
    let trendArrow: String
    let delta: Double
    let readingDate: Date
    let rangeCategory: RangeCategory
    let sparklineValues: [Int]

    var minutesAgo: Int {
        max(0, Int(Date().timeIntervalSince(readingDate) / 60))
    }

    var deltaString: String {
        if delta > 0 { return "+\(Int(delta))" }
        if delta < 0 { return "\(Int(delta))" }
        return "+0"
    }

    /// Smart Stack / complication relevance, scaled by urgency so urgent
    /// readings float the complication to the top. TimelineEntryRelevance is
    /// the per-entry relevance mechanism for accessory-family widgets on
    /// watchOS 9+; the newer RelevanceKit donation API (watchOS 11+) is a
    /// separate mechanism and doesn't replace per-entry scores.
    var relevance: TimelineEntryRelevance? {
        let score: Float
        if minutesAgo > 15 {
            score = 0 // stale — don't promote old data
        } else {
            switch rangeCategory {
            case .urgentLow, .urgentHigh: score = 100
            case .low, .high: score = 70
            case .inRange: score = 20
            }
        }
        return TimelineEntryRelevance(score: score)
    }

    static let placeholder = GlucoseComplicationEntry(
        date: .now,
        sgv: 120,
        trendArrow: "->",
        delta: 0,
        readingDate: .now,
        rangeCategory: .inRange,
        sparklineValues: [110, 115, 118, 120, 122, 120]
    )
}

struct GlucoseTimelineProvider: TimelineProvider {
    private let suiteName = AppConfig.appGroup

    func placeholder(in context: Context) -> GlucoseComplicationEntry {
        .placeholder
    }

    func getSnapshot(in context: Context, completion: @escaping (GlucoseComplicationEntry) -> Void) {
        completion(currentEntry() ?? .placeholder)
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<GlucoseComplicationEntry>) -> Void) {
        let entry = currentEntry() ?? .placeholder

        // Adaptive refresh based on range category
        let refreshMinutes: Int
        switch entry.rangeCategory {
        case .urgentLow, .urgentHigh:
            refreshMinutes = 1
        case .low, .high:
            refreshMinutes = 3
        case .inRange:
            refreshMinutes = 5
        }

        let reloadDate = Calendar.current.date(byAdding: .minute, value: refreshMinutes, to: .now)!
        let timeline = Timeline(entries: [entry], policy: .after(reloadDate))
        completion(timeline)
    }

    private func currentEntry() -> GlucoseComplicationEntry? {
        guard let defaults = UserDefaults(suiteName: suiteName) else { return nil }
        guard let sgv = defaults.object(forKey: "latestSgv") as? Int else { return nil }

        let direction = defaults.string(forKey: "latestDirection") ?? "NOT COMPUTABLE"
        let date = defaults.double(forKey: "latestDate")
        let delta = defaults.double(forKey: "latestDelta")

        // Validate we have a real timestamp
        guard date > 0 else { return nil }

        let reading = GlucoseReading(fromWatchPayload: [
            "sgv": sgv,
            "direction": direction,
            "date": date,
            "delta": delta
        ])

        // Read sparkline for rectangular complication
        var sparkline: [Int] = []
        if let data = defaults.data(forKey: "watchSparkline"),
           let decoded = try? JSONDecoder().decode([Int].self, from: data) {
            sparkline = decoded
        }

        return GlucoseComplicationEntry(
            date: .now,
            sgv: reading.sgv,
            trendArrow: reading.trendArrow,
            delta: reading.delta ?? 0,
            readingDate: reading.timestamp,
            rangeCategory: reading.rangeCategory,
            sparklineValues: sparkline
        )
    }
}

struct GlucoseComplication: Widget {
    let kind = "GlucoseComplication"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: GlucoseTimelineProvider()) { entry in
            ComplicationViews(entry: entry)
                .containerBackground(.clear, for: .widget)
        }
        .configurationDisplayName("Glucose")
        .description("Current glucose and trend")
        .supportedFamilies([
            .accessoryCircular,
            .accessoryRectangular,
            .accessoryInline
        ])
    }
}
