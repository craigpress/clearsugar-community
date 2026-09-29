import WidgetKit

struct GlucoseWidgetEntry: TimelineEntry {
    let date: Date
    let sgv: Int
    let trendArrow: String
    let deltaString: String
    let rangeCategory: RangeCategory
    let minutesAgo: Int
    let sparklineValues: [Int]
    let predictionValues: [Int]
    let iob: String?
    let cob: String?
    let isStale: Bool
    let hasTimestamp: Bool

    var ageText: String { hasTimestamp ? "\(minutesAgo)m ago" : "\u{2014}" }
    var ageTextShort: String { hasTimestamp ? "\(minutesAgo)m" : "\u{2014}" }
    var glucoseText: String { hasTimestamp && sgv > 12 && sgv < 600 ? "\(sgv)" : "\u{2014}" }

    static var noData: GlucoseWidgetEntry {
        GlucoseWidgetEntry(date: Date(), sgv: 0, trendArrow: "", deltaString: "",
            rangeCategory: .inRange, minutesAgo: 0, sparklineValues: [], predictionValues: [],
            iob: nil, cob: nil, isStale: true, hasTimestamp: false)
    }

    static var placeholder: GlucoseWidgetEntry {
        GlucoseWidgetEntry(date: Date(), sgv: 120, trendArrow: "\u{2192}", deltaString: "+2",
            rangeCategory: .inRange, minutesAgo: 2,
            sparklineValues: [110, 115, 118, 120, 122, 120, 118, 120, 125, 122, 120],
            predictionValues: [120, 125, 130, 135, 138, 140], iob: "4.2 u", cob: "25 g",
            isStale: false, hasTimestamp: true)
    }
}
