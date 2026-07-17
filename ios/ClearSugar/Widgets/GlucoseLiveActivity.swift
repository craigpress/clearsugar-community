import ActivityKit
import SwiftUI
import WidgetKit

struct GlucoseLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: GlucoseActivityAttributes.self) { context in
            lockScreenView(context.state)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.center) {
                    expandedView(context.state)
                }
            } compactLeading: {
                HStack(spacing: 1) {
                    Text("\(context.state.sgv)")
                        .font(.system(.headline, design: .rounded))
                        .fontWeight(.bold)
                    Text(context.state.trendArrow)
                        .font(.system(.subheadline))
                }
                .foregroundStyle(glucoseColor(context.state.rangeCategory))
            } compactTrailing: {
                compactTrailingView(context.state)
            } minimal: {
                minimalView(context.state)
            }
        }
    }

    // MARK: - Lock Screen Banner

    private let insulinBlue = Color(red: 0x42 / 255, green: 0xA5 / 255, blue: 0xF5 / 255)
    private let carbAmber = Color(red: 0xFF / 255, green: 0xA7 / 255, blue: 0x26 / 255)

    @ViewBuilder
    private func lockScreenView(_ state: GlucoseActivityAttributes.ContentState) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            // Top row: large glucose + trend arrow
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text("\(state.sgv)")
                    .font(.system(size: 36, weight: .bold, design: .rounded))
                    .minimumScaleFactor(0.7)
                    .lineLimit(1)
                    .foregroundStyle(glucoseColor(state.rangeCategory))
                Text(state.trendArrow)
                    .font(.system(size: 22))
                    .foregroundStyle(glucoseColor(state.rangeCategory))

                Spacer()
            }

            // Bottom row: IOB | COB | prediction | time ago
            HStack(spacing: 8) {
                if let iob = state.iob {
                    Text(iob)
                        .font(.system(size: 13, weight: .semibold, design: .rounded))
                        .foregroundStyle(insulinBlue)
                }
                if let cob = state.cob {
                    Text(cob)
                        .font(.system(size: 13, weight: .semibold, design: .rounded))
                        .foregroundStyle(carbAmber)
                }

                if let predicted = state.predictedSgv,
                   let mins = state.predictionMinutes {
                    Text("\u{2192} \(predicted) in \(mins)m")
                        .font(.system(size: 12, weight: .medium, design: .rounded))
                        .foregroundStyle(glucoseColorForValue(predicted))
                }

                Spacer()

                Text(Date(timeIntervalSince1970: state.timestamp), style: .relative)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }

            // Urgency text if needed
            if state.rangeCategory.isUrgent {
                Text(urgencyText(state.rangeCategory))
                    .font(.system(size: 12, weight: .bold, design: .rounded))
                    .foregroundStyle(glucoseColor(state.rangeCategory))
            }
        }
        .padding()
    }

    // MARK: - Dynamic Island Expanded

    @ViewBuilder
    private func expandedView(_ state: GlucoseActivityAttributes.ContentState) -> some View {
        VStack(spacing: 6) {
            HStack(spacing: 12) {
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    Text("\(state.sgv)")
                        .font(.system(size: 36, weight: .bold, design: .rounded))
                        .minimumScaleFactor(0.7)
                        .lineLimit(1)
                        .foregroundStyle(glucoseColor(state.rangeCategory))
                    Text(state.trendArrow)
                        .font(.title2)
                        .foregroundStyle(glucoseColor(state.rangeCategory))
                }
                Text(state.delta)
                    .font(.body)
                    .foregroundStyle(.secondary)

                Spacer()

                VStack(alignment: .trailing, spacing: 2) {
                    Text(Date(timeIntervalSince1970: state.timestamp), style: .relative)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    if let predicted = state.predictedSgv,
                       let mins = state.predictionMinutes {
                        Text("\u{2192} \(predicted) in \(mins)m")
                            .font(.system(.caption2, design: .rounded))
                            .fontWeight(.medium)
                            .foregroundStyle(glucoseColorForValue(predicted))
                    }
                    // IOB/COB in expanded island
                    if let iob = state.iob, let cob = state.cob {
                        Text("\(iob) \u{00B7} \(cob)")
                            .font(.system(.caption2, design: .rounded))
                            .fontWeight(.medium)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            // Sparkline in expanded Dynamic Island
            SparklineView(
                historyValues: state.sparklineValues,
                predictionValues: state.predictionValues
            )
            .frame(height: 30)
        }
    }

    // MARK: - Compact / Minimal Island Slots

    @ViewBuilder
    private func compactTrailingView(_ state: GlucoseActivityAttributes.ContentState) -> some View {
        #if compiler(>=6.4) // Requires iOS 27 SDK (Xcode 27, Swift 6.4); compiled out on older toolchains.
        if #available(iOS 27.0, *) {
            WidthAwareCompactTrailing(state: state)
        } else {
            compactTrailingContent(state)
        }
        #else
        compactTrailingContent(state)
        #endif
    }

    @ViewBuilder
    private func minimalView(_ state: GlucoseActivityAttributes.ContentState) -> some View {
        #if compiler(>=6.4) // Requires iOS 27 SDK (Xcode 27, Swift 6.4); compiled out on older toolchains.
        if #available(iOS 27.0, *) {
            WidthAwareMinimal(state: state)
        } else {
            minimalContent(state)
        }
        #else
        minimalContent(state)
        #endif
    }

    private func urgencyText(_ category: RangeCategory) -> String {
        switch category {
        case .urgentLow:  return "URGENT LOW -- Treat with fast carbs"
        case .urgentHigh: return "URGENT HIGH -- Check insulin pump"
        default:          return ""
        }
    }
}

// MARK: - Brand Colors

private func glucoseColor(_ category: RangeCategory) -> Color {
    switch category {
    case .urgentLow:  return Color(red: 0xEF / 255, green: 0x53 / 255, blue: 0x50 / 255)
    case .low:        return Color(red: 0xFF / 255, green: 0xB7 / 255, blue: 0x4D / 255)
    case .inRange:    return Color(red: 0x66 / 255, green: 0xBB / 255, blue: 0x6A / 255)
    case .high:       return Color(red: 0xFF / 255, green: 0xA7 / 255, blue: 0x26 / 255)
    case .urgentHigh: return Color(red: 0xEF / 255, green: 0x53 / 255, blue: 0x50 / 255)
    }
}

private func glucoseColorForValue(_ sgv: Int) -> Color {
    switch sgv {
    case ..<55:     return Color(red: 0xEF / 255, green: 0x53 / 255, blue: 0x50 / 255)
    case 55..<70:   return Color(red: 0xFF / 255, green: 0xB7 / 255, blue: 0x4D / 255)
    case 70...180:  return Color(red: 0x66 / 255, green: 0xBB / 255, blue: 0x6A / 255)
    case 181...250: return Color(red: 0xFF / 255, green: 0xA7 / 255, blue: 0x26 / 255)
    default:        return Color(red: 0xEF / 255, green: 0x53 / 255, blue: 0x50 / 255)
    }
}

// MARK: - Compact / Minimal Content (shared by iOS 17 and iOS 27 paths)

@ViewBuilder
private func compactTrailingContent(_ state: GlucoseActivityAttributes.ContentState) -> some View {
    Text(state.delta)
        .font(.system(.subheadline, design: .rounded))
        .foregroundStyle(.secondary)
}

@ViewBuilder
private func minimalContent(_ state: GlucoseActivityAttributes.ContentState) -> some View {
    HStack(spacing: 0) {
        Text("\(state.sgv)")
            .font(.system(.subheadline, design: .rounded))
            .fontWeight(.bold)
        Text(state.trendArrow)
            .font(.system(.caption2))
    }
    .foregroundStyle(glucoseColor(state.rangeCategory))
}

// MARK: - iOS 27 Landscape Dynamic Island

#if compiler(>=6.4)
// Requires iOS 27 SDK (Xcode 27, Swift 6.4); compiled out on older toolchains.
//
// iOS 27 also shows the Dynamic Island in landscape, where the compact slots
// are much narrower. `isDynamicIslandLimitedInWidth` is the WWDC26 environment
// value name — re-verify it against the final iOS 27 SDK, as it was not
// exposed in pre-release Xcode 26.x SDK interfaces.

@available(iOS 27.0, *)
private struct WidthAwareCompactTrailing: View {
    @Environment(\.isDynamicIslandLimitedInWidth) private var isLimitedInWidth
    let state: GlucoseActivityAttributes.ContentState

    var body: some View {
        if isLimitedInWidth {
            // Tightest rendering: value + arrow already fill the leading
            // slot — drop the delta entirely.
            EmptyView()
        } else {
            compactTrailingContent(state)
        }
    }
}

@available(iOS 27.0, *)
private struct WidthAwareMinimal: View {
    @Environment(\.isDynamicIslandLimitedInWidth) private var isLimitedInWidth
    let state: GlucoseActivityAttributes.ContentState

    var body: some View {
        if isLimitedInWidth {
            // Tightest rendering: value only.
            Text("\(state.sgv)")
                .font(.system(.subheadline, design: .rounded))
                .fontWeight(.bold)
                .foregroundStyle(glucoseColor(state.rangeCategory))
        } else {
            minimalContent(state)
        }
    }
}
#endif

// MARK: - Sparkline View

struct SparklineView: View {
    let historyValues: [Int]
    let predictionValues: [Int]?

    // Brand colors
    private let inRangeColor = Color(red: 0x66 / 255, green: 0xBB / 255, blue: 0x6A / 255)
    private let lowColor = Color(red: 0xFF / 255, green: 0xB7 / 255, blue: 0x4D / 255)
    private let urgentLowColor = Color(red: 0xEF / 255, green: 0x53 / 255, blue: 0x50 / 255)
    private let highColor = Color(red: 0xFF / 255, green: 0xA7 / 255, blue: 0x26 / 255)
    private let urgentHighColor = Color(red: 0xEF / 255, green: 0x53 / 255, blue: 0x50 / 255)

    // Range bounds for the green zone band
    private let rangeLow: Double = 70
    private let rangeHigh: Double = 180

    var body: some View {
        GeometryReader { geo in
            let allValues = combinedValues
            if allValues.count >= 2 {
                let minVal = max(40, (allValues.min() ?? 70) - 10)
                let maxVal = min(400, (allValues.max() ?? 180) + 10)
                let valueRange = Double(maxVal - minVal)
                let w = geo.size.width
                let h = geo.size.height

                ZStack {
                    // Green zone band (70-180)
                    let bandTop = yPosition(for: rangeHigh, minVal: Double(minVal), range: valueRange, height: h)
                    let bandBottom = yPosition(for: rangeLow, minVal: Double(minVal), range: valueRange, height: h)
                    Rectangle()
                        .fill(inRangeColor.opacity(0.25))
                        .frame(height: max(0, bandBottom - bandTop))
                        .offset(y: bandTop + (bandBottom - bandTop) / 2 - h / 2)

                    // History line (colored by range)
                    historyPath(
                        values: historyValues,
                        totalPoints: allValues.count,
                        minVal: Double(minVal),
                        range: valueRange,
                        width: w,
                        height: h
                    )

                    // Prediction dashed line
                    if let predVals = predictionValues, !predVals.isEmpty {
                        predictionPath(
                            historyCount: historyValues.count,
                            predValues: predVals,
                            totalPoints: allValues.count,
                            minVal: Double(minVal),
                            range: valueRange,
                            width: w,
                            height: h
                        )
                    }
                }
            }
            // When < 2 values, render nothing (empty GeometryReader)
        }
    }

    private var combinedValues: [Int] {
        var vals = historyValues
        if let pred = predictionValues {
            vals.append(contentsOf: pred)
        }
        return vals
    }

    private func yPosition(for value: Double, minVal: Double, range: Double, height: CGFloat) -> CGFloat {
        guard range > 0 else { return height / 2 }
        return height - CGFloat((value - minVal) / range) * height
    }

    @ViewBuilder
    private func historyPath(
        values: [Int],
        totalPoints: Int,
        minVal: Double,
        range: Double,
        width: CGFloat,
        height: CGFloat
    ) -> some View {
        let step = totalPoints > 1 ? width / CGFloat(totalPoints - 1) : width
        // Draw segments colored by the value's range
        ForEach(0..<max(0, values.count - 1), id: \.self) { i in
            let x0 = CGFloat(i) * step
            let y0 = yPosition(for: Double(values[i]), minVal: minVal, range: range, height: height)
            let x1 = CGFloat(i + 1) * step
            let y1 = yPosition(for: Double(values[i + 1]), minVal: minVal, range: range, height: height)
            let midSgv = (values[i] + values[i + 1]) / 2

            Path { path in
                path.move(to: CGPoint(x: x0, y: y0))
                path.addLine(to: CGPoint(x: x1, y: y1))
            }
            .stroke(colorForSgv(midSgv), lineWidth: 2)
        }
    }

    @ViewBuilder
    private func predictionPath(
        historyCount: Int,
        predValues: [Int],
        totalPoints: Int,
        minVal: Double,
        range: Double,
        width: CGFloat,
        height: CGFloat
    ) -> some View {
        let step = totalPoints > 1 ? width / CGFloat(totalPoints - 1) : width
        let startIndex = historyCount - 1 // overlap with last history point

        Path { path in
            for (j, val) in predValues.enumerated() {
                let idx = startIndex + j + 1
                let x = CGFloat(idx) * step
                let y = yPosition(for: Double(val), minVal: minVal, range: range, height: height)
                if j == 0 {
                    // Connect from last history point
                    let prevIdx = startIndex
                    let lastHistVal = historyValues.last ?? val
                    let px = CGFloat(prevIdx) * step
                    let py = yPosition(for: Double(lastHistVal), minVal: minVal, range: range, height: height)
                    path.move(to: CGPoint(x: px, y: py))
                    path.addLine(to: CGPoint(x: x, y: y))
                } else {
                    path.addLine(to: CGPoint(x: x, y: y))
                }
            }
        }
        .stroke(
            colorForSgv(predValues.last ?? 100),
            style: StrokeStyle(lineWidth: 2, dash: [4, 3])
        )
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
