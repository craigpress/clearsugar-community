import SwiftUI
import Charts

struct WatchTrendChart: View {
    let historyValues: [Int]
    let predictionValues: [Int]?

    // Constants
    private let fixedMin: Double = 30
    private let rangeLow: Double = 70
    private let rangeHigh: Double = 180
    private let sixHours: Double = 3600 * 6

    // Total seconds of data available
    private var dataSpanSeconds: Double {
        Double(historyValues.count) * 5 * 60
    }

    // Whether we have enough data to scroll
    private var isScrollable: Bool {
        dataSpanSeconds > sixHours
    }

    // Brand colors
    private let inRangeColor = Color(red: 0.40, green: 0.73, blue: 0.42)
    private let lowColor = Color(red: 1.0, green: 0.72, blue: 0.30)
    private let highColor = Color(red: 1.0, green: 0.65, blue: 0.15)
    private let urgentColor = Color(red: 0.94, green: 0.33, blue: 0.31)

    // Dynamic Y-axis top
    private var dynamicMax: Double {
        let maxVal = Double(historyValues.max() ?? 180)
        if maxVal <= 180 { return 180 }
        if maxVal <= 200 { return 200 }
        if maxVal <= 250 { return 250 }
        if maxVal <= 300 { return 300 }
        return 350
    }

    private var yAxisValues: [Double] {
        var vals: [Double] = [30, 50, 120, 180]
        if dynamicMax > 180 { vals.append(dynamicMax) }
        return vals
    }

    // Build data points with timestamps
    private var dataPoints: [GlucosePoint] {
        let now = Date()
        return historyValues.enumerated().map { i, sgv in
            let minutesAgo = Double(historyValues.count - 1 - i) * 5
            return GlucosePoint(
                time: now.addingTimeInterval(-minutesAgo * 60),
                sgv: sgv, isPrediction: false
            )
        }
    }

    private var predictionPoints: [GlucosePoint] {
        guard let pred = predictionValues, !pred.isEmpty else { return [] }
        let now = Date()
        return pred.enumerated().map { j, sgv in
            GlucosePoint(
                time: now.addingTimeInterval(Double(j + 1) * 5 * 60),
                sgv: sgv, isPrediction: true
            )
        }
    }

    var body: some View {
        HStack(spacing: 0) {
            // Fixed Y-axis on the left
            yAxisView
                .frame(width: 28)

            // Scrollable chart
            scrollableChart
        }
    }

    // MARK: - Fixed Y-Axis

    private var yAxisView: some View {
        // Invisible chart that just renders the Y-axis labels
        Chart {
            // Need at least one mark for the axis to render
            PointMark(
                x: .value("X", 0),
                y: .value("Y", 100)
            )
            .opacity(0)
        }
        .chartYScale(domain: fixedMin...dynamicMax)
        .chartXAxis(.hidden)
        .chartYAxis {
            AxisMarks(position: .leading, values: yAxisValues) { value in
                AxisValueLabel {
                    if let v = value.as(Double.self) {
                        Text("\(Int(v))")
                            .font(.system(size: 11, design: .rounded))
                            .foregroundStyle(.white.opacity(0.5))
                    }
                }
            }
        }
        .chartPlotStyle { plot in
            plot.frame(width: 0)
        }
    }

    // MARK: - Scrollable Chart

    private var scrollableChart: some View {
        Chart {
            // Green range band
            if let first = dataPoints.first?.time,
               let last = predictionPoints.last?.time ?? dataPoints.last?.time {
                RectangleMark(
                    xStart: .value("S", first),
                    xEnd: .value("E", last),
                    yStart: .value("Lo", rangeLow),
                    yEnd: .value("Hi", rangeHigh)
                )
                .foregroundStyle(inRangeColor.opacity(0.12))
            }

            // Reference lines
            RuleMark(y: .value("70", 70))
                .lineStyle(StrokeStyle(lineWidth: 0.5, dash: [3, 3]))
                .foregroundStyle(.white.opacity(0.15))
            RuleMark(y: .value("180", 180))
                .lineStyle(StrokeStyle(lineWidth: 0.5, dash: [3, 3]))
                .foregroundStyle(.white.opacity(0.15))

            // History line
            ForEach(Array(dataPoints.enumerated()), id: \.offset) { i, point in
                if i < dataPoints.count - 1 {
                    LineMark(
                        x: .value("Time", point.time),
                        y: .value("BG", point.sgv),
                        series: .value("S", "h\(i)")
                    )
                    .foregroundStyle(colorForSgv(point.sgv))
                    .lineStyle(StrokeStyle(lineWidth: 2))

                    LineMark(
                        x: .value("Time", dataPoints[i + 1].time),
                        y: .value("BG", dataPoints[i + 1].sgv),
                        series: .value("S", "h\(i)")
                    )
                    .foregroundStyle(colorForSgv(point.sgv))
                    .lineStyle(StrokeStyle(lineWidth: 2))
                }
            }

            // Prediction dashed line
            if !predictionPoints.isEmpty, let lastHist = dataPoints.last {
                LineMark(
                    x: .value("Time", lastHist.time),
                    y: .value("BG", lastHist.sgv),
                    series: .value("S", "pred")
                )
                .foregroundStyle(colorForSgv(predictionPoints.last?.sgv ?? 100))
                .lineStyle(StrokeStyle(lineWidth: 2, dash: [4, 3]))

                ForEach(predictionPoints, id: \.time) { point in
                    LineMark(
                        x: .value("Time", point.time),
                        y: .value("BG", point.sgv),
                        series: .value("S", "pred")
                    )
                    .foregroundStyle(colorForSgv(point.sgv))
                    .lineStyle(StrokeStyle(lineWidth: 2, dash: [4, 3]))
                }
            }
        }
        .chartYScale(domain: fixedMin...dynamicMax)
        .chartYAxis(.hidden)
        .chartXAxis {
            AxisMarks(values: .stride(by: .hour, count: 1)) { _ in
                AxisValueLabel(format: .dateTime.hour(.defaultDigits(amPM: .abbreviated)))
                    .font(.system(size: 11, design: .rounded))
                    .foregroundStyle(.white.opacity(0.45))
            }
        }
        .chartScrollableAxes(.horizontal)
        .chartXVisibleDomain(length: isScrollable ? sixHours : dataSpanSeconds)
        .chartScrollPosition(initialX: dataPoints.last?.time ?? Date())
    }

    // MARK: - Helpers

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

private struct GlucosePoint: Identifiable {
    let time: Date
    let sgv: Int
    let isPrediction: Bool
    var id: Date { time }
}
