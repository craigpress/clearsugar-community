import SwiftUI
import WidgetKit
import Security

// MARK: - Widget Entry

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
    /// False when the cached reading has no timestamp — age is unknown,
    /// so views render "—" instead of a fake "0m ago".
    let hasTimestamp: Bool

    /// Age label: "3m ago" normally, "—" when the reading age is unknown.
    var ageText: String {
        hasTimestamp ? "\(minutesAgo)m ago" : "\u{2014}"
    }

    /// Short age label for compact widgets.
    var ageTextShort: String {
        hasTimestamp ? "\(minutesAgo)m" : "\u{2014}"
    }

    static var placeholder: GlucoseWidgetEntry {
        GlucoseWidgetEntry(
            date: Date(),
            sgv: 120,
            trendArrow: "\u{2192}",
            deltaString: "+2",
            rangeCategory: .inRange,
            minutesAgo: 2,
            sparklineValues: [110, 115, 118, 120, 122, 120, 118, 120, 125, 122, 120],
            predictionValues: [120, 125, 130, 135, 138, 140],
            iob: "4.2 u",
            cob: "25 g",
            isStale: false,
            hasTimestamp: true
        )
    }
}

// MARK: - Keychain Helper (mirrors AuthManager.loadFromKeychain)

private func loadFromKeychain(service: String) -> String? {
    let account: String
    if service.hasSuffix(".jwt") { account = "jwt" }
    else if service.hasSuffix(".apikey") { account = "apikey" }
    else { account = "default" }

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

// MARK: - Timeline Provider

struct GlucoseTimelineProvider: TimelineProvider {
    private let defaults = AppConfig.sharedDefaults

    func placeholder(in context: Context) -> GlucoseWidgetEntry {
        .placeholder
    }

    func getSnapshot(in context: Context, completion: @escaping (GlucoseWidgetEntry) -> Void) {
        completion(context.isPreview ? .placeholder : buildEntry())
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<GlucoseWidgetEntry>) -> Void) {
        Task {
            await fetchAndCacheLatest()
            let entry = buildEntry()
            let nextUpdate = Date().addingTimeInterval(300) // 5 minutes
            let timeline = Timeline(entries: [entry], policy: .after(nextUpdate))
            completion(timeline)
        }
    }

    // MARK: - Network Fetch

    /// Lightweight fetch for widget — single attempt, 5s timeout, fail silently
    private func fetchAndCacheLatest() async {
        // Server must be configured (baked into Info.plist or entered in SetupView)
        guard let baseURL = AppConfig.serverURL else { return }

        // Read auth from shared Keychain
        let jwt = loadFromKeychain(service: AppConfig.jwtKeychainService)
        let apiKey = loadFromKeychain(service: AppConfig.apiKeyKeychainService)
        guard jwt != nil || apiKey != nil else { return }

        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 5
        config.timeoutIntervalForResource = 5
        let session = URLSession(configuration: config)

        // Fetch latest glucose
        do {
            let url = baseURL.appendingPathComponent("api/glucose/latest")
            var request = URLRequest(url: url)
            if let jwt, !jwt.isEmpty {
                request.setValue("Bearer \(jwt)", forHTTPHeaderField: "Authorization")
            } else if let apiKey, !apiKey.isEmpty {
                request.setValue(apiKey, forHTTPHeaderField: "X-API-Key")
            }
            request.setValue("application/json", forHTTPHeaderField: "Accept")

            if let (data, response) = try? await session.data(for: request),
               let http = response as? HTTPURLResponse, http.statusCode == 200,
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let sgv = json["sgv"] as? Int, sgv > 0, sgv < 600 {
                defaults.set(sgv, forKey: "cached_sgv")
                if let direction = json["direction"] as? String {
                    defaults.set(direction, forKey: "cached_direction")
                }
                if let date = json["date"] as? Double, date > 0 {
                    defaults.set(date, forKey: "cached_date")
                }
                if let delta = json["delta"] as? Double {
                    defaults.set(delta, forKey: "cached_delta")
                }
                defaults.set(Date().timeIntervalSince1970, forKey: "cached_fetchTime")
            }
        }

        // Fetch IOB/COB
        do {
            let url = baseURL.appendingPathComponent("api/pump/iob")
            var request = URLRequest(url: url)
            if let jwt, !jwt.isEmpty {
                request.setValue("Bearer \(jwt)", forHTTPHeaderField: "Authorization")
            } else if let apiKey, !apiKey.isEmpty {
                request.setValue(apiKey, forHTTPHeaderField: "X-API-Key")
            }
            request.setValue("application/json", forHTTPHeaderField: "Accept")

            if let (data, response) = try? await session.data(for: request),
               let http = response as? HTTPURLResponse, http.statusCode == 200,
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                if let iobDisplay = json["iobDisplay"] as? String {
                    defaults.set(iobDisplay, forKey: "cached_iob")
                }
                if let cobDisplay = json["cobDisplay"] as? String {
                    defaults.set(cobDisplay, forKey: "cached_cob")
                }
            }
        }
    }

    private func buildEntry() -> GlucoseWidgetEntry {
        let sgv = defaults.integer(forKey: "cached_sgv")
        let direction = defaults.string(forKey: "cached_direction") ?? "Flat"
        let dateEpoch = defaults.double(forKey: "cached_date") // epoch millis
        let delta = defaults.double(forKey: "cached_delta")

        // Read sparkline history
        var sparkline: [Int] = []
        if let data = defaults.data(forKey: "cached_sparkline"),
           let decoded = try? JSONDecoder().decode([Int].self, from: data) {
            sparkline = decoded
        }

        // Read prediction values
        var prediction: [Int] = []
        if let data = defaults.data(forKey: "cached_prediction"),
           let decoded = try? JSONDecoder().decode([Int].self, from: data) {
            prediction = decoded
        }

        // Read IOB/COB
        let iob = defaults.string(forKey: "cached_iob")
        let cob = defaults.string(forKey: "cached_cob")

        // Compute trend arrow from direction string
        let trendArrow: String = {
            switch direction {
            case "DoubleUp":      return "\u{21C8}"
            case "SingleUp":     return "\u{2191}"
            case "FortyFiveUp":  return "\u{2197}"
            case "Flat":         return "\u{2192}"
            case "FortyFiveDown": return "\u{2198}"
            case "SingleDown":   return "\u{2193}"
            case "DoubleDown":   return "\u{21CA}"
            default:             return "\u{2192}"
            }
        }()

        // Compute range category
        let rangeCategory: RangeCategory = {
            guard sgv > 0 && sgv < 600 else { return .urgentLow }
            switch sgv {
            case ..<55:     return .urgentLow
            case 55..<70:   return .low
            case 70...180:  return .inRange
            case 181...250: return .high
            default:        return .urgentHigh
            }
        }()

        // Compute delta string
        let deltaString: String = {
            if delta >= 0 {
                return "+\(Int(delta))"
            } else {
                return "\(Int(delta))"
            }
        }()

        // Compute minutes ago from the REAL reading date. If the cached
        // reading has no timestamp we must not pretend it's fresh — mark the
        // age unknown and render the entry as stale.
        let hasTimestamp = dateEpoch > 0
        let minutesAgo: Int
        if hasTimestamp {
            let readingDate = Date(timeIntervalSince1970: dateEpoch / 1000)
            minutesAgo = max(0, Int(Date().timeIntervalSince(readingDate) / 60))
        } else {
            minutesAgo = 0
        }
        let isStale = !hasTimestamp || minutesAgo > 15

        // Guard against no data at all
        guard sgv > 0 else {
            return .placeholder
        }

        return GlucoseWidgetEntry(
            date: Date(),
            sgv: sgv,
            trendArrow: trendArrow,
            deltaString: deltaString,
            rangeCategory: rangeCategory,
            minutesAgo: minutesAgo,
            sparklineValues: sparkline,
            predictionValues: prediction,
            iob: iob,
            cob: cob,
            isStale: isStale,
            hasTimestamp: hasTimestamp
        )
    }
}

// MARK: - Brand Colors

private let glucoseColors: [RangeCategory: Color] = [
    .urgentLow:  Color(red: 0.94, green: 0.33, blue: 0.31),
    .low:        Color(red: 1.0, green: 0.72, blue: 0.30),
    .inRange:    Color(red: 0.40, green: 0.73, blue: 0.42),
    .high:       Color(red: 1.0, green: 0.65, blue: 0.15),
    .urgentHigh: Color(red: 0.94, green: 0.33, blue: 0.31),
]

private let insulinBlue = Color(red: 0.259, green: 0.647, blue: 0.961)
private let carbAmber = Color(red: 1.0, green: 0.655, blue: 0.149)

private func glucoseColor(for category: RangeCategory) -> Color {
    glucoseColors[category] ?? .white
}

/// Stale readings render grey so an old number can't be mistaken for a
/// current one (the range color only applies to fresh data).
private func valueColor(for entry: GlucoseWidgetEntry) -> Color {
    entry.isStale ? Color.secondary : glucoseColor(for: entry.rangeCategory)
}

// MARK: - Small Widget

struct GlucoseSmallWidget: Widget {
    let kind = "GlucoseSmallWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: GlucoseTimelineProvider()) { entry in
            GlucoseSmallView(entry: entry)
                .containerBackground(.black, for: .widget)
        }
        .configurationDisplayName("Glucose")
        .description("Current glucose with sparkline trend.")
        .supportedFamilies([.systemSmall])
    }
}

private struct GlucoseSmallView: View {
    let entry: GlucoseWidgetEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Top row: glucose + arrow + IOB/COB
            HStack(alignment: .firstTextBaseline, spacing: 2) {
                Text("\(entry.sgv)")
                    .font(.system(size: 40, weight: .bold, design: .rounded))
                    .foregroundStyle(valueColor(for: entry))
                    .minimumScaleFactor(0.7)
                    .lineLimit(1)
                Text(entry.trendArrow)
                    .font(.system(size: 20))
                    .foregroundStyle(valueColor(for: entry))

                Spacer(minLength: 2)

                // IOB/COB stacked on the right
                VStack(alignment: .trailing, spacing: 1) {
                    if let iob = entry.iob {
                        Text(iob)
                            .font(.system(size: 12, weight: .semibold, design: .rounded))
                            .foregroundStyle(insulinBlue)
                    }
                    if let cob = entry.cob {
                        Text(cob)
                            .font(.system(size: 12, weight: .semibold, design: .rounded))
                            .foregroundStyle(carbAmber)
                    }
                }
            }

            Spacer(minLength: 2)

            // Sparkline with Y-axis labels
            if !entry.sparklineValues.isEmpty {
                WidgetSparkline(
                    historyValues: entry.sparklineValues,
                    predictionValues: entry.predictionValues.isEmpty ? nil : entry.predictionValues,
                    showYAxis: true,
                    compact: true,
                    showXAxis: true
                )
                .frame(maxWidth: .infinity)
                .frame(height: 50)
            }

            Spacer(minLength: 2)

            // Bottom: time ago ("—" when the reading age is unknown)
            HStack {
                Spacer()
                Text(entry.ageText)
                    .font(.system(size: 10, weight: entry.isStale ? .bold : .regular, design: .rounded))
                    .foregroundStyle(entry.isStale ? .red : .secondary)
            }
        }
        .opacity(entry.isStale ? 0.6 : 1.0)
    }
}

// MARK: - Medium Widget

struct GlucoseMediumWidget: Widget {
    let kind = "GlucoseMediumWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: GlucoseTimelineProvider()) { entry in
            GlucoseMediumView(entry: entry)
                .containerBackground(.black, for: .widget)
        }
        .configurationDisplayName("Glucose Trend")
        .description("Glucose with sparkline chart and details.")
        .supportedFamilies(Self.families)
    }

    private static var families: [WidgetFamily] {
        var families: [WidgetFamily] = [.systemMedium]
        #if compiler(>=6.4) // Requires iOS 27 SDK (Xcode 27, Swift 6.4); compiled out on older toolchains.
        if #available(iOS 27.0, *) {
            // 4x6 iPad/Mac dashboard widget, new on iOS 27.
            families.append(.systemExtraLargePortrait)
        }
        #endif
        return families
    }
}

private struct GlucoseMediumView: View {
    @Environment(\.widgetFamily) private var family
    let entry: GlucoseWidgetEntry

    var body: some View {
        #if compiler(>=6.4) // Requires iOS 27 SDK (Xcode 27, Swift 6.4); compiled out on older toolchains.
        if #available(iOS 27.0, *) {
            if family == .systemExtraLargePortrait {
                GlucoseExtraLargePortraitView(entry: entry)
            } else {
                mediumBody
            }
        } else {
            mediumBody
        }
        #else
        mediumBody
        #endif
    }

    private var mediumBody: some View {
        HStack(spacing: 8) {
            // Left column: glucose + arrow + IOB/COB
            VStack(alignment: .leading, spacing: 4) {
                // Glucose + arrow
                HStack(alignment: .firstTextBaseline, spacing: 3) {
                    Text("\(entry.sgv)")
                        .font(.system(size: 44, weight: .bold, design: .rounded))
                        .foregroundStyle(valueColor(for: entry))
                        .minimumScaleFactor(0.7)
                        .lineLimit(1)
                    Text(entry.trendArrow)
                        .font(.system(size: 22))
                        .foregroundStyle(valueColor(for: entry))
                }

                Spacer(minLength: 0)

                // IOB + COB
                VStack(alignment: .leading, spacing: 2) {
                    if let iob = entry.iob {
                        Text(iob)
                            .font(.system(size: 14, weight: .semibold, design: .rounded))
                            .foregroundStyle(insulinBlue)
                    }
                    if let cob = entry.cob {
                        Text(cob)
                            .font(.system(size: 14, weight: .semibold, design: .rounded))
                            .foregroundStyle(carbAmber)
                    }
                }

                Text(entry.ageText)
                    .font(.system(size: 11, weight: entry.isStale ? .bold : .regular, design: .rounded))
                    .foregroundStyle(entry.isStale ? .red : .secondary)
            }
            .fixedSize(horizontal: true, vertical: false)

            // Right column: sparkline with Y-axis labels
            if !entry.sparklineValues.isEmpty {
                WidgetSparkline(
                    historyValues: entry.sparklineValues,
                    predictionValues: entry.predictionValues.isEmpty ? nil : entry.predictionValues,
                    showYAxis: true,
                    compact: false,
                    showXAxis: true
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                Spacer()
            }
        }
        .opacity(entry.isStale ? 0.6 : 1.0)
    }
}

// MARK: - Extra-Large Portrait View (iOS 27, iPad/Mac dashboard)

#if compiler(>=6.4)
// Requires iOS 27 SDK (Xcode 27, Swift 6.4); compiled out on older toolchains.
@available(iOS 27.0, *)
private struct GlucoseExtraLargePortraitView: View {
    let entry: GlucoseWidgetEntry

    var body: some View {
        VStack(spacing: 16) {
            // Chart on top
            if !entry.sparklineValues.isEmpty {
                WidgetSparkline(
                    historyValues: entry.sparklineValues,
                    predictionValues: entry.predictionValues.isEmpty ? nil : entry.predictionValues,
                    showYAxis: true,
                    compact: false,
                    showXAxis: true
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                Spacer()
            }

            // Stat row below: glucose + arrow + delta left, IOB/COB/age right
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("\(entry.sgv)")
                    .font(.system(size: 72, weight: .bold, design: .rounded))
                    .foregroundStyle(valueColor(for: entry))
                    .minimumScaleFactor(0.7)
                    .lineLimit(1)
                Text(entry.trendArrow)
                    .font(.system(size: 36))
                    .foregroundStyle(valueColor(for: entry))
                Text(entry.deltaString)
                    .font(.system(size: 26, weight: .semibold, design: .rounded))
                    .foregroundStyle(.secondary)

                Spacer()

                VStack(alignment: .trailing, spacing: 4) {
                    if let iob = entry.iob {
                        Text(iob)
                            .font(.system(size: 20, weight: .semibold, design: .rounded))
                            .foregroundStyle(insulinBlue)
                    }
                    if let cob = entry.cob {
                        Text(cob)
                            .font(.system(size: 20, weight: .semibold, design: .rounded))
                            .foregroundStyle(carbAmber)
                    }
                    Text(entry.ageText)
                        .font(.system(size: 14, weight: entry.isStale ? .bold : .regular, design: .rounded))
                        .foregroundStyle(entry.isStale ? .red : .secondary)
                }
            }
        }
        .opacity(entry.isStale ? 0.6 : 1.0)
    }
}
#endif

// MARK: - Accessory Circular Widget (Lock Screen)

struct GlucoseAccessoryCircularWidget: Widget {
    let kind = "GlucoseAccessoryCircularWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: GlucoseTimelineProvider()) { entry in
            GlucoseAccessoryCircularView(entry: entry)
                .containerBackground(.clear, for: .widget)
        }
        .configurationDisplayName("Glucose Circle")
        .description("Glucose number for Lock Screen.")
        .supportedFamilies([.accessoryCircular])
    }
}

private struct GlucoseAccessoryCircularView: View {
    let entry: GlucoseWidgetEntry

    var body: some View {
        VStack(spacing: 1) {
            Text("\(entry.sgv)")
                .font(.system(size: 22, weight: .bold, design: .rounded))
                .minimumScaleFactor(0.6)
                .lineLimit(1)
            Text(entry.trendArrow)
                .font(.system(size: 14))
        }
        .widgetAccentable()
        .opacity(entry.isStale ? 0.5 : 1.0)
    }
}

// MARK: - Accessory Rectangular Widget (Lock Screen)

struct GlucoseAccessoryRectangularWidget: Widget {
    let kind = "GlucoseAccessoryRectangularWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: GlucoseTimelineProvider()) { entry in
            GlucoseAccessoryRectangularView(entry: entry)
                .containerBackground(.clear, for: .widget)
        }
        .configurationDisplayName("Glucose Trend")
        .description("Glucose with sparkline for Lock Screen.")
        .supportedFamilies([.accessoryRectangular])
    }
}

private struct GlucoseAccessoryRectangularView: View {
    let entry: GlucoseWidgetEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 4) {
                // Left: glucose + arrow
                HStack(alignment: .firstTextBaseline, spacing: 2) {
                    Text("\(entry.sgv)")
                        .font(.system(size: 24, weight: .bold, design: .rounded))
                        .minimumScaleFactor(0.7)
                        .lineLimit(1)
                    Text(entry.trendArrow)
                        .font(.system(size: 14))
                }

                // Right: mini sparkline
                if !entry.sparklineValues.isEmpty {
                    WidgetSparkline(
                        historyValues: entry.sparklineValues,
                        predictionValues: entry.predictionValues.isEmpty ? nil : entry.predictionValues,
                        showYAxis: false,
                        compact: true
                    )
                    .frame(maxWidth: .infinity)
                    .frame(height: 20)
                }
            }

            // Bottom: IOB + COB
            HStack(spacing: 6) {
                if let iob = entry.iob {
                    Text(iob)
                        .font(.system(size: 10, weight: .medium, design: .rounded))
                }
                if let cob = entry.cob {
                    Text(cob)
                        .font(.system(size: 10, weight: .medium, design: .rounded))
                }
                Spacer()
                Text(entry.ageTextShort)
                    .font(.system(size: 10, design: .rounded))
                    .foregroundStyle(.secondary)
            }
        }
        .widgetAccentable()
        .opacity(entry.isStale ? 0.5 : 1.0)
    }
}

// MARK: - Accessory Inline Widget (Lock Screen, above clock)

struct GlucoseAccessoryInlineWidget: Widget {
    let kind = "GlucoseAccessoryInlineWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: GlucoseTimelineProvider()) { entry in
            GlucoseAccessoryInlineView(entry: entry)
                .containerBackground(.clear, for: .widget)
        }
        .configurationDisplayName("Glucose Inline")
        .description("Glucose above the Lock Screen clock.")
        .supportedFamilies([.accessoryInline])
    }
}

private struct GlucoseAccessoryInlineView: View {
    let entry: GlucoseWidgetEntry

    var body: some View {
        Text("\(entry.sgv) \(entry.trendArrow) \(entry.deltaString)")
    }
}

// MARK: - Widget Sparkline (fixed Y-axis range)

private struct WidgetSparkline: View {
    let historyValues: [Int]
    let predictionValues: [Int]?
    let showYAxis: Bool
    let compact: Bool
    /// Show an X-axis time row (-3h … now/+30m) under the chart. Off by default
    /// so the tiny accessory widgets keep their bare mini-sparkline.
    var showXAxis: Bool = false

    // Brand colors
    private let inRangeColor = Color(red: 0x66 / 255, green: 0xBB / 255, blue: 0x6A / 255)
    private let lowColor = Color(red: 0xFF / 255, green: 0xB7 / 255, blue: 0x4D / 255)
    private let urgentLowColor = Color(red: 0xEF / 255, green: 0x53 / 255, blue: 0x50 / 255)
    private let highColor = Color(red: 0xFF / 255, green: 0xA7 / 255, blue: 0x26 / 255)
    private let urgentHighColor = Color(red: 0xEF / 255, green: 0x53 / 255, blue: 0x50 / 255)

    // Fixed Y-axis range to ensure consistent clinical context
    private let fixedMin: Double = 40
    private let fixedMax: Double = 300
    private let rangeLow: Double = 70
    private let rangeHigh: Double = 180

    var body: some View {
        VStack(spacing: 1) {
        HStack(spacing: 2) {
            // Y-axis labels
            if showYAxis {
                VStack {
                    Text(compact ? "300" : "300")
                        .font(.system(size: compact ? 7 : 8, design: .rounded))
                        .foregroundStyle(.secondary)
                    Spacer()
                    Text(compact ? "180" : "180")
                        .font(.system(size: compact ? 7 : 8, design: .rounded))
                        .foregroundStyle(inRangeColor.opacity(0.7))
                    Spacer()
                    Text(compact ? "70" : "70")
                        .font(.system(size: compact ? 7 : 8, design: .rounded))
                        .foregroundStyle(lowColor.opacity(0.7))
                    Spacer()
                    Text(compact ? "40" : "40")
                        .font(.system(size: compact ? 7 : 8, design: .rounded))
                        .foregroundStyle(.secondary)
                }
                .frame(width: compact ? 16 : 20)
            }

            // Chart area
            GeometryReader { geo in
                let allValues = combinedValues
                if allValues.count >= 2 {
                    let valueRange = fixedMax - fixedMin
                    let w = geo.size.width
                    let h = geo.size.height

                    ZStack {
                        // Green zone band (70-180)
                        let bandTop = yPos(rangeHigh, h)
                        let bandBottom = yPos(rangeLow, h)
                        Rectangle()
                            .fill(inRangeColor.opacity(0.25))
                            .frame(height: max(0, bandBottom - bandTop))
                            .offset(y: bandTop + (bandBottom - bandTop) / 2 - h / 2)

                        // Dashed threshold lines at 70 and 180
                        Path { path in
                            let y70 = yPos(rangeLow, h)
                            path.move(to: CGPoint(x: 0, y: y70))
                            path.addLine(to: CGPoint(x: w, y: y70))
                        }
                        .stroke(lowColor.opacity(0.5), style: StrokeStyle(lineWidth: 0.5, dash: [2, 2]))

                        Path { path in
                            let y180 = yPos(rangeHigh, h)
                            path.move(to: CGPoint(x: 0, y: y180))
                            path.addLine(to: CGPoint(x: w, y: y180))
                        }
                        .stroke(highColor.opacity(0.5), style: StrokeStyle(lineWidth: 0.5, dash: [2, 2]))

                        // History line (colored by range)
                        let totalPoints = allValues.count
                        let step = totalPoints > 1 ? w / CGFloat(totalPoints - 1) : w
                        ForEach(0..<max(0, historyValues.count - 1), id: \.self) { i in
                            let x0 = CGFloat(i) * step
                            let y0 = yPos(Double(historyValues[i]), h)
                            let x1 = CGFloat(i + 1) * step
                            let y1 = yPos(Double(historyValues[i + 1]), h)
                            let midSgv = (historyValues[i] + historyValues[i + 1]) / 2

                            Path { path in
                                path.move(to: CGPoint(x: x0, y: y0))
                                path.addLine(to: CGPoint(x: x1, y: y1))
                            }
                            .stroke(colorForSgv(midSgv), lineWidth: 2)
                        }

                        // Prediction dashed line
                        if let predVals = predictionValues, !predVals.isEmpty {
                            let startIndex = historyValues.count - 1

                            Path { path in
                                for (j, val) in predVals.enumerated() {
                                    let idx = startIndex + j + 1
                                    let x = CGFloat(idx) * step
                                    let y = yPos(Double(val), h)
                                    if j == 0 {
                                        let lastHistVal = historyValues.last ?? val
                                        let px = CGFloat(startIndex) * step
                                        let py = yPos(Double(lastHistVal), h)
                                        path.move(to: CGPoint(x: px, y: py))
                                        path.addLine(to: CGPoint(x: x, y: y))
                                    } else {
                                        path.addLine(to: CGPoint(x: x, y: y))
                                    }
                                }
                            }
                            .stroke(
                                colorForSgv(predVals.last ?? 100),
                                style: StrokeStyle(lineWidth: 2, dash: [4, 3])
                            )
                        }
                    }
                }
            }
        }
        if showXAxis {
            HStack {
                Text("-3h")
                    .font(.system(size: compact ? 6 : 7, design: .rounded))
                    .foregroundStyle(.secondary)
                Spacer()
                Text((predictionValues?.isEmpty == false) ? "+30m" : "now")
                    .font(.system(size: compact ? 6 : 7, design: .rounded))
                    .foregroundStyle(.secondary)
            }
            .padding(.leading, showYAxis ? (compact ? 18 : 22) : 0)
        }
        }
    }

    private var combinedValues: [Int] {
        var vals = historyValues
        if let pred = predictionValues {
            vals.append(contentsOf: pred)
        }
        return vals
    }

    private func yPos(_ value: Double, _ height: CGFloat) -> CGFloat {
        let range = fixedMax - fixedMin
        guard range > 0 else { return height / 2 }
        let clamped = min(fixedMax, max(fixedMin, value))
        return height - CGFloat((clamped - fixedMin) / range) * height
    }

    private func colorForSgv(_ sgv: Int) -> Color {
        switch sgv {
        case ..<55:     return urgentLowColor
        case 55..<70:   return lowColor
        case 70...180:  return inRangeColor
        case 181...250: return highColor
        default:        return urgentHighColor
        }
    }
}
