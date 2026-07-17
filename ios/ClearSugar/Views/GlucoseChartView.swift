import SwiftUI
import Charts

// MARK: - Glucose Chart View

struct GlucoseChartView: View {
    let glucoseHistory: [GlucoseReading]
    let treatments: [Treatment]
    let prediction: PredictionResult?
    let timeRangeHours: Int // 3, 6, 12, 24

    // MARK: - Design Tokens

    private let bgColor = Color(red: 0, green: 0, blue: 0)
    private let surfaceColor = Color(red: 0.067, green: 0.067, blue: 0.067)
    private let borderColor = Color.white.opacity(0.06)
    private let textSecondary = Color(red: 0.64, green: 0.64, blue: 0.64)

    private let inRangeGreen = Color(red: 0.40, green: 0.73, blue: 0.42)   // #66bb6a
    private let warningOrange = Color(red: 1.00, green: 0.72, blue: 0.30)  // #ffb74d
    private let urgentRed = Color(red: 0.94, green: 0.33, blue: 0.31)      // #ef5350
    private let insulinBlue = Color(red: 0.259, green: 0.647, blue: 0.961) // #42a5f5
    private let carbAmber = Color(red: 1.00, green: 0.655, blue: 0.149)    // #ffa726
    private let predictionPurple = Color(red: 0.486, green: 0.302, blue: 1.0) // #7c4dff

    // MARK: - Computed Data

    private var sortedReadings: [GlucoseReading] {
        glucoseHistory
            .filter { $0.sgv > 0 && $0.sgv < 600 }
            .sorted { $0.date < $1.date }
    }

    private var bolusEvents: [Treatment] {
        treatments.filter(\.isBolus).sorted { $0.timestamp < $1.timestamp }
    }

    private var carbEvents: [Treatment] {
        treatments.filter(\.isCarb).sorted { $0.timestamp < $1.timestamp }
    }

    private var basalEvents: [Treatment] {
        treatments.filter(\.isTempBasal).sorted { $0.timestamp < $1.timestamp }
    }

    private var predictionPoints: [PredictionChartPoint] {
        guard let prediction, let lastReading = sortedReadings.last else { return [] }
        let baseDate = lastReading.timestamp
        // Start from the current reading to connect the line
        var points = [PredictionChartPoint(date: baseDate, value: Double(lastReading.sgv))]
        for p in prediction.points {
            let date = baseDate.addingTimeInterval(Double(p.offset) * 60)
            points.append(PredictionChartPoint(date: date, value: p.predicted))
        }
        return points
    }

    private var timeRange: ClosedRange<Date> {
        let now = Date()
        let start = now.addingTimeInterval(-Double(timeRangeHours) * 3600)
        // Extend end if predictions go further
        var end = now
        if let lastPred = predictionPoints.last {
            end = max(end, lastPred.date)
        }
        // Add 5 min padding on the right
        end = end.addingTimeInterval(300)
        return start...end
    }

    private var yDomain: ClosedRange<Int> {
        let sgvValues = sortedReadings.map(\.sgv)
        let predValues = predictionPoints.map { Int($0.value) }
        let allValues = sgvValues + predValues
        guard !allValues.isEmpty else { return 40...400 }
        let minVal = max(40, (allValues.min() ?? 40) - 10)
        let maxVal = min(400, (allValues.max() ?? 400) + 20)
        return min(minVal, 40)...max(maxVal, 200)
    }

    // MARK: - Body

    var body: some View {
        VStack(spacing: 0) {
            if sortedReadings.isEmpty {
                emptyState
            } else {
                // Zone 1: Treatment Lane (boluses + carbs)
                if !bolusEvents.isEmpty || !carbEvents.isEmpty {
                    treatmentLane
                }

                // Zone 2: Glucose Chart
                glucoseChart

                // Zone 3: Basal Rate
                if !basalEvents.isEmpty {
                    basalChart
                        .padding(.top, 2)
                }
            }
        }
        .padding(12)
        .background(surfaceColor)
        .clipShape(RoundedRectangle(cornerRadius: 16))
        .overlay(
            RoundedRectangle(cornerRadius: 16)
                .stroke(borderColor, lineWidth: 1)
        )
    }

    // MARK: - Empty State

    private var emptyState: some View {
        VStack(spacing: 8) {
            Image(systemName: "chart.xyaxis.line")
                .font(.title2)
                .foregroundStyle(textSecondary)
            Text("No glucose data")
                .font(.system(.subheadline, design: .rounded))
                .foregroundStyle(textSecondary)
        }
        .frame(height: 240)
        .frame(maxWidth: .infinity)
    }

    // MARK: - Zone 1: Treatment Lane

    private var treatmentLane: some View {
        Chart {
            // Bolus bars — label below the bar (matches web app)
            ForEach(bolusEvents) { bolus in
                let units = bolus.insulin ?? 0
                let barHeight = max(0.3, min(2.0, units * 0.6))

                BarMark(
                    x: .value("Time", bolus.timestamp),
                    y: .value("Units", barHeight),
                    width: 6
                )
                .foregroundStyle(insulinBlue.opacity(0.85))
                .annotation(position: .bottom, spacing: 2) {
                    Text(bolus.bolusLabel)
                        .font(.system(size: 8, weight: .semibold, design: .monospaced))
                        .foregroundStyle(insulinBlue.opacity(0.9))
                }
            }

            // Carb circles — label inside the bubble (grams always shown)
            ForEach(carbEvents) { carb in
                let grams = carb.carbs ?? 0
                let scaledValue = max(0.3, min(2.0, sqrt(grams) * 0.25))

                PointMark(
                    x: .value("Time", carb.timestamp),
                    y: .value("Carbs", scaledValue)
                )
                .symbolSize(max(80, min(300, grams * 5)))
                .foregroundStyle(carbAmber.opacity(0.7))
                .annotation(position: .overlay) {
                    Text("\(Int(grams))")
                        .font(.system(size: 7, weight: .bold, design: .rounded))
                        .foregroundStyle(.white)
                }
            }
        }
        .chartXScale(domain: timeRange)
        .chartYScale(domain: 0...2.5)
        .chartXAxis(.hidden)
        .chartYAxis(.hidden)
        .chartPlotStyle { plotArea in
            plotArea
                .padding(.leading, 38)
                .background(Color.clear)
        }
        .frame(height: 40)
        .clipped()
    }

    // MARK: - Zone 2: Glucose Chart

    private var glucoseChart: some View {
        Chart {
            // Target range band (70-180)
            RectangleMark(
                xStart: .value("Start", timeRange.lowerBound),
                xEnd: .value("End", timeRange.upperBound),
                yStart: .value("Low", 70),
                yEnd: .value("High", 180)
            )
            .foregroundStyle(inRangeGreen.opacity(0.15))

            // Urgent low threshold line (55)
            RuleMark(y: .value("UrgentLow", 55))
                .lineStyle(StrokeStyle(lineWidth: 1, dash: [4, 4]))
                .foregroundStyle(urgentRed.opacity(0.4))

            // High threshold line (250)
            RuleMark(y: .value("High", 250))
                .lineStyle(StrokeStyle(lineWidth: 1, dash: [4, 4]))
                .foregroundStyle(urgentRed.opacity(0.3))

            // Glucose line segments colored by range
            ForEach(Array(sortedReadings.enumerated()), id: \.element.date) { index, reading in
                if index > 0 {
                    let prev = sortedReadings[index - 1]
                    // Only draw line segment if gap < 10 minutes
                    let gap = reading.date - prev.date
                    if gap < 600_000 {
                        LineMark(
                            x: .value("Time", prev.timestamp),
                            y: .value("Glucose", clampGlucose(prev.sgv)),
                            series: .value("Segment", "seg-\(index)")
                        )
                        .foregroundStyle(glucoseColor(for: reading.sgv))
                        .lineStyle(StrokeStyle(lineWidth: 2.5, lineCap: .round))
                        .interpolationMethod(.monotone)

                        LineMark(
                            x: .value("Time", reading.timestamp),
                            y: .value("Glucose", clampGlucose(reading.sgv)),
                            series: .value("Segment", "seg-\(index)")
                        )
                        .foregroundStyle(glucoseColor(for: reading.sgv))
                        .lineStyle(StrokeStyle(lineWidth: 2.5, lineCap: .round))
                        .interpolationMethod(.monotone)
                    }
                }

                // Color dots at each reading
                PointMark(
                    x: .value("Time", reading.timestamp),
                    y: .value("Glucose", clampGlucose(reading.sgv))
                )
                .symbolSize(16)
                .foregroundStyle(glucoseColor(for: reading.sgv))
            }

            // Prediction line (dashed purple)
            if predictionPoints.count > 1 {
                ForEach(Array(predictionPoints.enumerated()), id: \.element.date) { _, point in
                    LineMark(
                        x: .value("Time", point.date),
                        y: .value("Glucose", clampGlucose(Int(point.value))),
                        series: .value("Prediction", "prediction")
                    )
                    .foregroundStyle(predictionPurple.opacity(0.8))
                    .lineStyle(StrokeStyle(lineWidth: 2, lineCap: .round, dash: [6, 4]))
                    .interpolationMethod(.monotone)
                }

                // Prediction endpoint dot
                if let last = predictionPoints.last {
                    PointMark(
                        x: .value("Time", last.date),
                        y: .value("Glucose", clampGlucose(Int(last.value)))
                    )
                    .symbolSize(30)
                    .foregroundStyle(predictionPurple)
                }
            }
        }
        .chartXScale(domain: timeRange)
        .chartYScale(domain: yDomain)
        .chartXAxis {
            AxisMarks(values: .stride(by: .hour, count: xAxisStride)) { value in
                AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5))
                    .foregroundStyle(Color.white.opacity(0.06))
                AxisValueLabel(format: .dateTime.hour(.defaultDigits(amPM: .abbreviated)))
                    .foregroundStyle(textSecondary)
                    .font(.system(size: 11, design: .monospaced))
            }
        }
        .chartYAxis {
            AxisMarks(position: .leading, values: .automatic(desiredCount: 6)) { value in
                AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5))
                    .foregroundStyle(Color.white.opacity(0.04))
                AxisValueLabel {
                    if let v = value.as(Int.self) {
                        Text(String(format: "%3d", v))
                            .foregroundStyle(textSecondary)
                            .font(.system(size: 11, design: .monospaced))
                    }
                }
            }
        }
        .chartPlotStyle { plotArea in
            plotArea.background(Color.clear)
        }
        .frame(height: 200)
        .clipped()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(chartAccessibilityLabel)
    }

    // MARK: - Zone 3: Basal Chart

    private var basalChart: some View {
        Chart {
            ForEach(Array(basalEvents.enumerated()), id: \.element.id) { index, basal in
                let rate = basal.rate ?? 0
                let endDate: Date = {
                    if let dur = basal.duration, dur > 0 {
                        return basal.timestamp.addingTimeInterval(dur * 60)
                    } else if index + 1 < basalEvents.count {
                        return basalEvents[index + 1].timestamp
                    } else {
                        return basal.timestamp.addingTimeInterval(300)
                    }
                }()

                AreaMark(
                    x: .value("Time", basal.timestamp),
                    yStart: .value("Rate", 0),
                    yEnd: .value("Rate", rate)
                )
                .foregroundStyle(insulinBlue.opacity(0.25))
                .interpolationMethod(.stepEnd)

                AreaMark(
                    x: .value("Time", endDate),
                    yStart: .value("Rate", 0),
                    yEnd: .value("Rate", rate)
                )
                .foregroundStyle(insulinBlue.opacity(0.25))
                .interpolationMethod(.stepEnd)

                LineMark(
                    x: .value("Time", basal.timestamp),
                    y: .value("Rate", rate),
                    series: .value("Basal", "basal")
                )
                .foregroundStyle(insulinBlue.opacity(0.8))
                .lineStyle(StrokeStyle(lineWidth: 1.5))
                .interpolationMethod(.stepEnd)

                LineMark(
                    x: .value("Time", endDate),
                    y: .value("Rate", rate),
                    series: .value("Basal", "basal")
                )
                .foregroundStyle(insulinBlue.opacity(0.8))
                .lineStyle(StrokeStyle(lineWidth: 1.5))
                .interpolationMethod(.stepEnd)
            }
        }
        .chartXScale(domain: timeRange)
        .chartYScale(domain: 0...3)
        .chartXAxis {
            AxisMarks(values: .stride(by: .hour, count: xAxisStride)) { _ in
                AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5))
                    .foregroundStyle(Color.white.opacity(0.04))
            }
        }
        .chartYAxis {
            AxisMarks(position: .leading, values: [0, 1, 2, 3]) { value in
                AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5))
                    .foregroundStyle(Color.white.opacity(0.04))
                AxisValueLabel {
                    if let v = value.as(Int.self) {
                        Text(String(format: "%3d", v))
                            .foregroundStyle(textSecondary.opacity(0.6))
                            .font(.system(size: 11, design: .monospaced))
                    }
                }
            }
        }
        .chartPlotStyle { plotArea in
            plotArea.background(surfaceColor)
        }
        .frame(height: 50)
        .clipped()
        .overlay(alignment: .topLeading) {
            Text("U/hr")
                .font(.system(size: 9, design: .monospaced))
                .foregroundStyle(textSecondary.opacity(0.6))
                .padding(.leading, 4)
                .padding(.top, 2)
        }
    }

    // MARK: - Helpers

    private var xAxisStride: Int {
        switch timeRangeHours {
        case ...3:  return 1
        case 4...6: return 1
        case 7...12: return 2
        default:     return 4
        }
    }

    private func clampGlucose(_ sgv: Int) -> Int {
        max(40, min(400, sgv))
    }

    private func glucoseColor(for sgv: Int) -> Color {
        switch sgv {
        case ..<55:     return urgentRed
        case 55..<70:   return warningOrange
        case 70...180:  return inRangeGreen
        case 181...250: return warningOrange
        default:        return urgentRed
        }
    }

    private var chartAccessibilityLabel: String {
        let count = sortedReadings.count
        guard count > 0 else { return "Glucose chart with no data" }
        let latest = sortedReadings.last!
        let oldest = sortedReadings.first!
        let inRange = sortedReadings.filter { $0.sgv >= 70 && $0.sgv <= 180 }.count
        let pct = Int(Double(inRange) / Double(count) * 100)
        return "Glucose chart showing \(count) readings over \(timeRangeHours) hours. Latest \(latest.sgv), range \(oldest.sgv) to \(sortedReadings.map(\.sgv).max() ?? 0). Time in range \(pct) percent."
    }
}

// MARK: - Prediction Chart Point

private struct PredictionChartPoint: Identifiable {
    let date: Date
    let value: Double
    var id: Date { date }
}

// MARK: - GlucoseReading Identifiable Conformance

extension GlucoseReading: Identifiable {
    var id: TimeInterval { date }
}

// MARK: - Time Range Picker

struct TimeRangePicker: View {
    @Binding var selectedHours: Int
    let options = [3, 6, 12, 24]

    private let surfaceColor = Color(red: 0.067, green: 0.067, blue: 0.067)
    private let borderColor = Color.white.opacity(0.06)
    private let textSecondary = Color(red: 0.64, green: 0.64, blue: 0.64)
    private let accentPurple = Color(red: 0.486, green: 0.302, blue: 1.0)

    var body: some View {
        HStack(spacing: 8) {
            ForEach(options, id: \.self) { hours in
                Button {
                    withAnimation(.easeInOut(duration: 0.2)) {
                        selectedHours = hours
                    }
                } label: {
                    Text("\(hours)h")
                        .font(.system(.caption, design: .rounded))
                        .fontWeight(selectedHours == hours ? .bold : .medium)
                        .foregroundStyle(selectedHours == hours ? .white : textSecondary)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 6)
                        .background(
                            selectedHours == hours
                                ? accentPurple
                                : surfaceColor
                        )
                        .clipShape(Capsule())
                        .overlay(
                            Capsule()
                                .stroke(
                                    selectedHours == hours ? Color.clear : borderColor,
                                    lineWidth: 1
                                )
                        )
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(hours) hour range")
                .accessibilityAddTraits(selectedHours == hours ? .isSelected : [])
            }
        }
    }
}

// MARK: - Preview

#Preview {
    ZStack {
        Color.black.ignoresSafeArea()
        VStack(spacing: 16) {
            TimeRangePicker(selectedHours: .constant(3))
            GlucoseChartView(
                glucoseHistory: [],
                treatments: [],
                prediction: nil,
                timeRangeHours: 3
            )
        }
        .padding()
    }
    .preferredColorScheme(.dark)
}
