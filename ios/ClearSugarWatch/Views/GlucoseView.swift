import SwiftUI

struct GlucoseView: View {
    @ObservedObject var receiver = WatchSessionReceiver.shared

    var body: some View {
        if let reading = receiver.latestReading {
            glucoseContent(reading)
        } else {
            waitingView
        }
    }

    // Brand colors
    private let insulinBlue = Color(red: 0.259, green: 0.647, blue: 0.961)
    private let carbAmber = Color(red: 1.0, green: 0.655, blue: 0.149)
    private let inRangeColor = Color(red: 0.40, green: 0.73, blue: 0.42)
    private let lowColor = Color(red: 1.0, green: 0.72, blue: 0.30)
    private let highColor = Color(red: 1.0, green: 0.65, blue: 0.15)
    private let urgentColor = Color(red: 0.94, green: 0.33, blue: 0.31)

    // MARK: - Glucose Content

    @ViewBuilder
    private func glucoseContent(_ reading: GlucoseReading) -> some View {
        VStack(spacing: 2) {
            // Header: BG + arrow | IOB (center) | COB (right) — all same size
            HStack(alignment: .center, spacing: 0) {
                HStack(alignment: .firstTextBaseline, spacing: 2) {
                    Text("\(reading.sgv)")
                        .foregroundStyle(glucoseColor(reading.rangeCategory))
                    Text(reading.trendArrow)
                        .foregroundStyle(glucoseColor(reading.rangeCategory))
                }

                Spacer(minLength: 0)

                if let iob = receiver.latestIOB {
                    Text(iob)
                        .foregroundStyle(insulinBlue)
                }

                Spacer(minLength: 0)

                if let cob = receiver.latestCOB {
                    Text(cob)
                        .foregroundStyle(carbAmber)
                }
            }
            .font(.system(size: 22, weight: .bold, design: .rounded))
            .minimumScaleFactor(0.7)
            .lineLimit(1)

            // Full-height trend chart (owns Crown focus)
            if !receiver.sparklineValues.isEmpty {
                WatchTrendChart(
                    historyValues: receiver.sparklineValues,
                    predictionValues: receiver.predictionValues.isEmpty ? nil : receiver.predictionValues
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }

            // Time ago
            let mins = reading.minutesAgo
            Text(mins <= 1 ? "Just now" : "\(mins)m ago")
                .font(.system(size: 10, design: .rounded))
                .foregroundStyle(stalenessColor(minutesAgo: mins))
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(reading.accessibilityDescription)
    }

    // MARK: - Waiting State

    private var waitingView: some View {
        VStack(spacing: 8) {
            ProgressView()
            Text("Waiting for data")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    // MARK: - Brand Colors

    private func glucoseColor(_ category: RangeCategory) -> Color {
        switch category {
        case .urgentLow:  return urgentColor
        case .low:        return lowColor
        case .inRange:    return inRangeColor
        case .high:       return highColor
        case .urgentHigh: return urgentColor
        }
    }

    private func stalenessColor(minutesAgo mins: Int) -> Color {
        if mins > 15 {
            return urgentColor
        } else if mins > 10 {
            return lowColor
        } else {
            return .secondary
        }
    }
}
