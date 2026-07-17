import SwiftUI
import WidgetKit

struct ComplicationViews: View {
    let entry: GlucoseComplicationEntry

    @Environment(\.widgetFamily) var family

    var body: some View {
        switch family {
        case .accessoryCircular:
            circularView
        case .accessoryRectangular:
            rectangularView
        case .accessoryInline:
            inlineView
        default:
            circularView
        }
    }

    // MARK: - Circular: glucose + arrow

    private var circularView: some View {
        VStack(spacing: 0) {
            Text("\(entry.sgv)")
                .font(.system(size: 26, weight: .bold, design: .rounded))
                .minimumScaleFactor(0.7)
                .lineLimit(1)
            Text(entry.trendArrow)
                .font(.system(size: 16))
        }
        .foregroundStyle(complicationColor)
        .widgetAccentable()
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(entry.sgv) \(entry.trendArrow)")
    }

    // MARK: - Rectangular: glucose + delta + arrow + sparkline + time

    private var rectangularView: some View {
        VStack(alignment: .leading, spacing: 1) {
            HStack(alignment: .firstTextBaseline, spacing: 2) {
                Text("\(entry.sgv)")
                    .font(.system(size: 22, weight: .bold, design: .rounded))
                    .minimumScaleFactor(0.7)
                    .lineLimit(1)
                Text(entry.deltaString)
                    .font(.system(size: 12, weight: .semibold, design: .rounded))
                Text(entry.trendArrow)
                    .font(.system(size: 12))
                Spacer()
                Text(timeAgoString)
                    .font(.system(size: 10))
                    .foregroundStyle(stalenessColor)
            }
            .foregroundStyle(complicationColor)

            // Taller sparkline with dynamic Y-axis
            if entry.sparklineValues.count >= 2 {
                ComplicationSparkline(values: entry.sparklineValues)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .widgetAccentable()
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(entry.sgv) \(entry.deltaString) \(entry.trendArrow), \(timeAgoString)")
    }

    // MARK: - Inline: "145 →"

    private var inlineView: some View {
        Text("\(entry.sgv) \(entry.trendArrow)")
            .accessibilityLabel("\(entry.sgv) \(entry.trendArrow)")
    }

    // MARK: - Brand Colors

    private var complicationColor: Color {
        glucoseColor(entry.rangeCategory)
    }

    private func glucoseColor(_ category: RangeCategory) -> Color {
        switch category {
        case .urgentLow:  return Color(red: 0.94, green: 0.33, blue: 0.31)
        case .low:        return Color(red: 1.0, green: 0.72, blue: 0.30)
        case .inRange:    return Color(red: 0.40, green: 0.73, blue: 0.42)
        case .high:       return Color(red: 1.0, green: 0.65, blue: 0.15)
        case .urgentHigh: return Color(red: 0.94, green: 0.33, blue: 0.31)
        }
    }

    private var stalenessColor: Color {
        let mins = entry.minutesAgo
        if mins > 15 {
            return Color(red: 0.94, green: 0.33, blue: 0.31)
        } else if mins > 10 {
            return Color(red: 1.0, green: 0.72, blue: 0.30)
        } else {
            return .secondary
        }
    }

    private var timeAgoString: String {
        let mins = entry.minutesAgo
        return mins <= 1 ? "now" : "\(mins)m ago"
    }
}

// MARK: - Complication Sparkline (dynamic Y-axis, 30 bottom, min 180 top)

struct ComplicationSparkline: View {
    let values: [Int]

    private let inRangeColor = Color(red: 0.40, green: 0.73, blue: 0.42)
    private let lowColor = Color(red: 1.0, green: 0.72, blue: 0.30)
    private let highColor = Color(red: 1.0, green: 0.65, blue: 0.15)
    private let urgentColor = Color(red: 0.94, green: 0.33, blue: 0.31)

    private let fixedMin: Double = 30
    private let rangeLow: Double = 70
    private let rangeHigh: Double = 180
    private let yAxisWidth: CGFloat = 18
    private let xAxisHeight: CGFloat = 9

    // Dynamic top: at least 180, extends if data exceeds
    private var dynamicMax: Double {
        let maxVal = Double(values.max() ?? 180)
        if maxVal <= 180 { return 180 }
        if maxVal <= 200 { return 200 }
        if maxVal <= 250 { return 250 }
        if maxVal <= 300 { return 300 }
        return 350
    }

    // Hours of data shown (values are 5-min intervals)
    private var hoursOfData: Int {
        max(1, values.count * 5 / 60)
    }

    var body: some View {
        GeometryReader { geo in
            if values.count >= 2 {
                sparklineContent(size: geo.size)
            }
        }
    }

    private func sparklineContent(size: CGSize) -> some View {
        let chartWidth = size.width - yAxisWidth
        let chartHeight = size.height - xAxisHeight
        let step = chartWidth / CGFloat(values.count - 1)

        return ZStack(alignment: .topLeading) {
            // Y-axis labels (tiny, left edge)
            yAxisLabels(chartHeight: chartHeight)

            // Chart area
            ZStack {
                // Green zone band (subtle)
                greenBand(chartWidth: chartWidth, chartHeight: chartHeight)

                // Range marker lines at 70 and 180
                rangeLines(chartWidth: chartWidth, chartHeight: chartHeight)

                // Color-coded line segments
                ForEach(0..<values.count - 1, id: \.self) { i in
                    Path { path in
                        path.move(to: CGPoint(x: CGFloat(i) * step, y: yPos(Double(values[i]), chartHeight)))
                        path.addLine(to: CGPoint(x: CGFloat(i + 1) * step, y: yPos(Double(values[i + 1]), chartHeight)))
                    }
                    .stroke(colorForSgv((values[i] + values[i + 1]) / 2), lineWidth: 2)
                }
            }
            .frame(width: chartWidth, height: chartHeight)
            .offset(x: yAxisWidth)

            // X-axis: hours at edges
            xAxisLabels(chartWidth: chartWidth, chartHeight: chartHeight)
        }
    }

    private func yAxisLabels(chartHeight: CGFloat) -> some View {
        let markers: [Double] = dynamicMax > 180 ? [70, 180, dynamicMax] : [70, 180]

        return ZStack {
            ForEach(markers, id: \.self) { marker in
                Text("\(Int(marker))")
                    .font(.system(size: 7, weight: .medium, design: .rounded))
                    .foregroundStyle(.white.opacity(0.5))
                    .position(x: yAxisWidth / 2, y: yPos(marker, chartHeight))
            }
        }
    }

    private func greenBand(chartWidth: CGFloat, chartHeight: CGFloat) -> some View {
        let bandTop = yPos(rangeHigh, chartHeight)
        let bandBottom = yPos(rangeLow, chartHeight)

        return Rectangle()
            .fill(inRangeColor.opacity(0.12))
            .frame(width: chartWidth, height: max(0, bandBottom - bandTop))
            .offset(y: bandTop + (bandBottom - bandTop) / 2 - chartHeight / 2)
    }

    private func rangeLines(chartWidth: CGFloat, chartHeight: CGFloat) -> some View {
        let markers: [Double] = [70, 180]

        return ZStack {
            ForEach(markers, id: \.self) { marker in
                Path { path in
                    path.move(to: CGPoint(x: 0, y: yPos(marker, chartHeight)))
                    path.addLine(to: CGPoint(x: chartWidth, y: yPos(marker, chartHeight)))
                }
                .stroke(.white.opacity(0.15), style: StrokeStyle(lineWidth: 0.5, dash: [2, 2]))
            }
        }
    }

    private func xAxisLabels(chartWidth: CGFloat, chartHeight: CGFloat) -> some View {
        // Show hours: e.g., "3h" on left edge, "now" on right
        return ZStack {
            Text("\(hoursOfData)h")
                .font(.system(size: 9, weight: .medium, design: .rounded))
                .foregroundStyle(.white.opacity(0.45))
                .position(x: yAxisWidth + 8, y: chartHeight + xAxisHeight / 2)

            Text("now")
                .font(.system(size: 9, weight: .medium, design: .rounded))
                .foregroundStyle(.white.opacity(0.45))
                .position(x: yAxisWidth + chartWidth - 10, y: chartHeight + xAxisHeight / 2)
        }
    }

    private func yPos(_ value: Double, _ height: CGFloat) -> CGFloat {
        let range = dynamicMax - fixedMin
        let clamped = min(dynamicMax, max(fixedMin, value))
        return height - CGFloat((clamped - fixedMin) / range) * height
    }

    private func colorForSgv(_ sgv: Int) -> Color {
        switch sgv {
        case ..<55:     return urgentColor
        case 55..<70:   return lowColor
        case 70...180:  return inRangeColor
        case 181...250: return highColor
        default:        return urgentColor
        }
    }
}
