import SwiftUI
import SafariServices
import WidgetKit

struct ContentView: View {
    @Environment(\.scenePhase) private var scenePhase
    @State private var reading: GlucoseReading?
    @State private var error: String?
    @State private var isLoading = false
    @State private var refreshTimer: Timer?
    @State private var showWebDashboard = false
    @State private var patientName: String = AppConfig.patientDisplayName
    @State private var authManager = AuthManager.shared
    @ObservedObject private var store = GlucoseStore.shared

    // Chart data
    @State private var glucoseHistory: [GlucoseReading] = []
    @State private var treatments: [Treatment] = []
    @State private var prediction: PredictionResult?
    @State private var chartTimeRange: Int = 3
    @State private var pumpStatus: PumpStatus?
    @State private var iobDisplay: String = "--"
    @State private var cobDisplay: String = "--"
    @AppStorage("predictionHorizon") private var predictionHorizon: Int = 30

    // MARK: - Design Tokens (ClearSugar web app)

    private let bgColor = Color(red: 0, green: 0, blue: 0) // #000000
    private let surfaceColor = Color(red: 0.067, green: 0.067, blue: 0.067) // #111111
    private let borderColor = Color.white.opacity(0.06)
    private let textSecondary = Color(red: 0.64, green: 0.64, blue: 0.64) // #a3a3a3
    private let accentPurple = Color(red: 0.486, green: 0.302, blue: 1.0) // #7c4dff
    private let insulinBlue = Color(red: 0.259, green: 0.647, blue: 0.961) // #42a5f5
    private let carbAmber = Color(red: 1.0, green: 0.655, blue: 0.149) // #ffa726

    var body: some View {
        ZStack(alignment: .top) {
            bgColor.ignoresSafeArea()

            VStack(spacing: 0) {
                // Offline banner
                if !store.isOnline {
                    offlineBanner
                }

                // Stale data banner
                if let reading, reading.isStale {
                    staleBanner(minutesAgo: reading.minutesAgo)
                }

                // Session expiring / expired — surface instead of silently 401ing
                if authManager.needsReauth {
                    reauthBanner
                }

                if let reading {
                    glucoseDisplay(reading)
                } else if let error {
                    errorDisplay(error)
                } else {
                    loadingView
                }
            }
        }
        .preferredColorScheme(.dark)
        .task {
            // Show cached reading immediately
            if let cached = store.cachedReading {
                reading = cached
            }
            await refreshPatientProfile()
            await refreshChartData()
            await refresh()
            startAutoRefresh()
        }
        .onDisappear {
            refreshTimer?.invalidate()
            refreshTimer = nil
        }
        .onChange(of: scenePhase) { _, newPhase in
            if newPhase == .active, store.minutesSinceLastFetch >= 1 {
                Task {
                    await refreshChartData()
                    await refresh()
                }
                startAutoRefresh()
            }
        }
        // chartTimeRange only controls the visible window, no re-fetch needed
    }

    // MARK: - Offline Banner

    private var offlineBanner: some View {
        HStack(spacing: 6) {
            Image(systemName: "wifi.slash")
                .font(.caption2.weight(.bold))
            Text("OFFLINE")
                .font(.system(.caption2, design: .rounded))
                .fontWeight(.bold)
        }
        .foregroundStyle(.white)
        .frame(maxWidth: .infinity)
        .padding(.vertical, 6)
        .background(Color(red: 0.94, green: 0.33, blue: 0.31)) // #ef5350
        .accessibilityLabel("Device is offline. Glucose data may not be current.")
    }

    // MARK: - Stale Banner

    @ViewBuilder
    private func staleBanner(minutesAgo: Int) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.caption2.weight(.bold))
            Text("DATA STALE \u{2013} Last reading \(minutesAgo) min ago")
                .font(.system(.caption2, design: .rounded))
                .fontWeight(.bold)
        }
        .foregroundStyle(.black)
        .frame(maxWidth: .infinity)
        .padding(.vertical, 6)
        .background(Color(red: 1.0, green: 0.72, blue: 0.30)) // amber / #ffb74d
        .accessibilityLabel("Data is stale. Last reading was \(minutesAgo) minutes ago.")
    }

    // MARK: - Re-login Banner

    private var reauthBanner: some View {
        HStack(spacing: 6) {
            Image(systemName: "person.crop.circle.badge.exclamationmark")
                .font(.caption2.weight(.bold))
            Text("SESSION EXPIRING \u{2013} Sign in again in Settings")
                .font(.system(.caption2, design: .rounded))
                .fontWeight(.bold)
        }
        .foregroundStyle(.black)
        .frame(maxWidth: .infinity)
        .padding(.vertical, 6)
        .background(Color(red: 1.0, green: 0.72, blue: 0.30)) // amber / #ffb74d
        .accessibilityLabel("Your session is expiring. Sign in again in Settings.")
    }

    // MARK: - Loading

    private var loadingView: some View {
        VStack(spacing: 16) {
            ProgressView()
                .scaleEffect(1.5)
                .tint(accentPurple)
            Text("Connecting...")
                .font(.system(.subheadline, design: .rounded))
                .foregroundStyle(textSecondary)
        }
        .frame(maxHeight: .infinity)
        .accessibilityLabel("Loading glucose data")
    }

    // MARK: - Glucose Display

    @ViewBuilder
    private func glucoseDisplay(_ reading: GlucoseReading) -> some View {
        ScrollView {
            VStack(spacing: 0) {
                // Patient header (name from GET /api/profile, initials avatar)
                HStack(spacing: 14) {
                    ZStack {
                        Circle()
                            .fill(accentPurple.opacity(0.18))
                        Text(patientInitials)
                            .font(.system(.title3, design: .rounded).weight(.bold))
                            .foregroundStyle(accentPurple)
                    }
                    .frame(width: 56, height: 56)
                    .overlay(Circle().stroke(accentPurple, lineWidth: 2))
                    VStack(alignment: .leading, spacing: 2) {
                        Text(patientName)
                            .font(.system(.title2, design: .rounded).weight(.bold))
                            .foregroundStyle(.white)
                        Text("Glucose Monitor")
                            .font(.system(.caption, design: .rounded))
                            .foregroundStyle(textSecondary)
                    }
                    Spacer()
                }
                .padding(.horizontal, 20)
                .padding(.top, 16)
                .padding(.bottom, 8)

                // Hero section
                VStack(spacing: 4) {
                    // Glucose number + trend arrow
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text("\(reading.sgv)")
                            .font(.system(size: 96, weight: .bold, design: .rounded))
                            .monospacedDigit()
                            .foregroundStyle(glucoseColor(reading.rangeCategory))
                            .accessibilityLabel("\(reading.sgv) milligrams per deciliter")

                        Text(reading.trendArrow)
                            .font(.system(size: 48))
                            .foregroundStyle(glucoseColor(reading.rangeCategory))
                            .accessibilityLabel("Trend: \(reading.trendDescription)")
                    }
                    .opacity(reading.isStale ? 0.5 : 1.0)
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel(reading.accessibilityDescription)

                    // Natural language status
                    Text(reading.statusText)
                        .font(.system(.body, design: .rounded))
                        .foregroundStyle(textSecondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 32)
                        .padding(.top, 4)
                        .accessibilityLabel(reading.statusText)

                    // Urgency guidance capsule
                    if let guidance = reading.urgencyGuidance {
                        urgencyGuidanceCapsule(guidance, category: reading.rangeCategory)
                            .padding(.top, 8)
                    }
                }
                .padding(.top, 8)
                .padding(.bottom, 24)

                // Time range picker + Chart
                VStack(spacing: 12) {
                    TimeRangePicker(selectedHours: $chartTimeRange)
                        .padding(.horizontal, 20)

                    GlucoseChartView(
                        glucoseHistory: filteredHistory,
                        treatments: filteredTreatments,
                        prediction: prediction,
                        timeRangeHours: chartTimeRange
                    )
                    .padding(.horizontal, 20)
                }
                .padding(.bottom, 20)

                // Stats cards
                VStack(spacing: 12) {
                    // IOB + COB cards
                    HStack(spacing: 12) {
                        statCard(
                            title: "IOB",
                            value: iobDisplay,
                            unit: "",
                            color: insulinBlue
                        )
                        .accessibilityLabel("Insulin on board: \(iobDisplay)")

                        statCard(
                            title: "COB",
                            value: cobDisplay,
                            unit: "",
                            color: carbAmber
                        )
                        .accessibilityLabel("Carbs on board: \(cobDisplay)")
                    }

                    // Updated card
                    HStack(spacing: 12) {
                        statCard(
                            title: "Updated",
                            value: reading.minutesAgo <= 1 ? "Now" : "\(reading.minutesAgo)m",
                            unit: reading.minutesAgo <= 1 ? "" : "ago",
                            color: reading.minutesAgo > 10 ? Color(red: 0.94, green: 0.33, blue: 0.31) : textSecondary
                        )
                        .accessibilityLabel("Updated: \(reading.minutesAgo <= 1 ? "just now" : "\(reading.minutesAgo) minutes ago")")
                    }

                    // Pump status card
                    if let pumpMins = reading.pumpStaleMinutes {
                        pumpCard(minutesStale: pumpMins, isStale: reading.pumpIsStale ?? false)
                    }

                    // View Full Dashboard button (only when a server is configured)
                    if let dashboardURL = AppConfig.serverURL {
                        Button {
                            showWebDashboard = true
                        } label: {
                            HStack {
                                Image(systemName: "globe")
                                Text("View Full Dashboard")
                            }
                            .font(.system(.subheadline, design: .rounded))
                            .fontWeight(.medium)
                            .foregroundStyle(accentPurple)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 14)
                            .background(surfaceColor)
                            .clipShape(RoundedRectangle(cornerRadius: 16))
                            .overlay(RoundedRectangle(cornerRadius: 16).stroke(borderColor, lineWidth: 1))
                        }
                        .sheet(isPresented: $showWebDashboard) {
                            SafariView(url: dashboardURL)
                        }
                    }
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 40)
            }
        }
        .refreshable {
            await refresh()
            await refreshChartData()
        }
    }

    // MARK: - Urgency Guidance Capsule

    @ViewBuilder
    private func urgencyGuidanceCapsule(_ text: String, category: RangeCategory) -> some View {
        let capsuleColor: Color = category.isUrgent
            ? Color(red: 0.94, green: 0.33, blue: 0.31) // red for urgent
            : Color(red: 1.0, green: 0.65, blue: 0.15) // orange for low+falling

        HStack(spacing: 6) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.caption2)
            Text(text)
                .font(.system(.caption, design: .rounded))
                .fontWeight(.semibold)
        }
        .foregroundStyle(capsuleColor)
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(capsuleColor.opacity(0.15))
        .clipShape(Capsule())
        .accessibilityLabel("Alert: \(text)")
    }

    // MARK: - Stat Card

    @ViewBuilder
    private func statCard(title: String, value: String, unit: String, color: Color) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.system(.caption, design: .rounded))
                .foregroundStyle(textSecondary)

            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(value)
                    .font(.system(.title, design: .rounded))
                    .fontWeight(.bold)
                    .monospacedDigit()
                    .foregroundStyle(color)
                if !unit.isEmpty {
                    Text(unit)
                        .font(.system(.caption, design: .rounded))
                        .foregroundStyle(textSecondary)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(surfaceColor)
        .clipShape(RoundedRectangle(cornerRadius: 16))
        .overlay(
            RoundedRectangle(cornerRadius: 16)
                .stroke(borderColor, lineWidth: 1)
        )
    }

    // MARK: - Pump Card

    @ViewBuilder
    private func pumpCard(minutesStale: Int, isStale: Bool) -> some View {
        HStack {
            Image(systemName: "heart.circle.fill")
                .foregroundStyle(insulinBlue)
            VStack(alignment: .leading, spacing: 2) {
                Text("Pump")
                    .font(.system(.caption, design: .rounded))
                    .foregroundStyle(textSecondary)
                Text("Last sync \(minutesStale)m ago")
                    .font(.system(.subheadline, design: .rounded))
                    .fontWeight(.medium)
                    .foregroundStyle(.white)
            }
            Spacer()
            if isStale {
                Text("STALE")
                    .font(.system(.caption2, design: .rounded))
                    .fontWeight(.bold)
                    .foregroundStyle(.orange)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(.orange.opacity(0.15))
                    .clipShape(Capsule())
            }
        }
        .padding(16)
        .background(surfaceColor)
        .clipShape(RoundedRectangle(cornerRadius: 16))
        .overlay(
            RoundedRectangle(cornerRadius: 16)
                .stroke(borderColor, lineWidth: 1)
        )
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Pump last synced \(minutesStale) minutes ago\(isStale ? ", connection is stale" : "")")
    }

    // MARK: - Error Display

    @ViewBuilder
    private func errorDisplay(_ message: String) -> some View {
        VStack(spacing: 20) {
            Image(systemName: "wifi.exclamationmark")
                .font(.system(size: 48))
                .foregroundStyle(textSecondary)

            Text("Unable to connect")
                .font(.system(.title3, design: .rounded))
                .fontWeight(.semibold)
                .foregroundStyle(.white)

            Text(message)
                .font(.subheadline)
                .foregroundStyle(textSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)

            Button {
                Task { await refresh() }
            } label: {
                Text("Retry")
                    .font(.system(.body, design: .rounded))
                    .fontWeight(.semibold)
                    .foregroundStyle(.white)
                    .padding(.horizontal, 32)
                    .padding(.vertical, 12)
                    .background(accentPurple)
                    .clipShape(Capsule())
            }
            .accessibilityLabel("Retry connection")
        }
        .frame(maxHeight: .infinity)
    }

    // MARK: - Filtered Data for Chart

    /// Filter 24h history down to the selected time range for chart rendering performance
    private var filteredHistory: [GlucoseReading] {
        let cutoff = Date().addingTimeInterval(-Double(chartTimeRange) * 3600)
        return glucoseHistory.filter { $0.timestamp >= cutoff }
    }

    private var filteredTreatments: [Treatment] {
        let cutoff = Date().addingTimeInterval(-Double(chartTimeRange) * 3600)
        return treatments.filter { $0.timestamp >= cutoff }
    }

    // MARK: - Color Mapping

    private func glucoseColor(_ category: RangeCategory) -> Color {
        switch category {
        case .inRange:    return Color(red: 0.40, green: 0.73, blue: 0.42)  // #66bb6a
        case .low:        return Color(red: 1.00, green: 0.72, blue: 0.30)  // #ffb74d
        case .high:       return Color(red: 1.00, green: 0.65, blue: 0.15)  // #ffa726
        case .urgentLow:  return Color(red: 0.94, green: 0.33, blue: 0.31)  // #ef5350
        case .urgentHigh: return Color(red: 0.94, green: 0.33, blue: 0.31)  // #ef5350
        }
    }

    // MARK: - Data Fetching

    private func refresh() async {
        isLoading = true
        defer { isLoading = false }

        do {
            let newReading = try await APIClient.shared.fetchLatestGlucose()

            withAnimation(.easeInOut(duration: 0.5)) {
                reading = newReading
            }
            error = nil

            // Fetch pump status (non-blocking -- fail silently)
            if let status = try? await APIClient.shared.fetchPumpStatus() {
                withAnimation(.easeInOut(duration: 0.3)) {
                    pumpStatus = status
                }
            }

            // Fetch real IOB/COB (non-blocking -- fail silently)
            // Capture fresh values locally to avoid stale state in widget/LA/Watch updates
            var freshIOB: String = iobDisplay
            var freshCOB: String = cobDisplay
            if let iobcob = try? await APIClient.shared.fetchIOBCOB() {
                freshIOB = iobcob.iobDisplay
                freshCOB = iobcob.cobDisplay
                withAnimation(.easeInOut(duration: 0.3)) {
                    iobDisplay = freshIOB
                    cobDisplay = freshCOB
                }
            }

            // Persist for offline / widget use
            await MainActor.run {
                GlucoseStore.shared.save(newReading)
            }

            // Save sparkline + IOB/COB for WidgetKit widgets and reload timelines
            let iobForWidgets = freshIOB == "--" ? nil : freshIOB
            let cobForWidgets = freshCOB == "--" ? nil : freshCOB
            await MainActor.run {
                let sparkline = Array(glucoseHistory.prefix(36).reversed()).map { $0.sgv }
                GlucoseStore.shared.saveSparklineForWidgets(sparkline)
                GlucoseStore.shared.saveIOBCOBForWidgets(iob: iobForWidgets, cob: cobForWidgets)
                if let pred = prediction {
                    let predValues = pred.points.map { Int($0.predicted) }
                    GlucoseStore.shared.savePredictionForWidgets(predValues)
                }
                WidgetCenter.shared.reloadAllTimelines()
            }

            // Evaluate alerts (handles haptics internally) + re-arm dead-man watchdog
            await MainActor.run {
                AlertManager.shared.evaluate(newReading)
                AlertManager.shared.rearmDataWatchdog()
            }

            // Update Live Activity (Dynamic Island + Lock Screen)
            await MainActor.run {
                LiveActivityManager.shared.startOrUpdate(
                    with: newReading,
                    history: glucoseHistory,
                    prediction: prediction,
                    iob: iobForWidgets,
                    cob: cobForWidgets
                )
            }

            // Push to Watch (glucoseHistory already has 24h)
            let watchSparkline = Array(glucoseHistory.prefix(288).reversed()).map { $0.sgv }
            let watchPrediction: [Int]? = prediction?.points.map { Int($0.predicted) }
            WatchSessionManager.shared.pushToWatch(newReading, iob: iobForWidgets, cob: cobForWidgets, sparkline: watchSparkline, prediction: watchPrediction)

        } catch {
            // If we have no reading at all, show the error
            if reading == nil {
                self.error = error.localizedDescription
            }
            // Otherwise keep showing the last known reading
        }
    }

    private func refreshChartData() async {
        // Always fetch 24h — time range buttons just control the visible window
        async let historyTask = APIClient.shared.fetchGlucoseHistory(hours: 24)
        async let treatmentsTask = APIClient.shared.fetchTreatments(hours: 24)

        do {
            let (history, fetchedTreatments) = try await (historyTask, treatmentsTask)
            withAnimation(.easeInOut(duration: 0.3)) {
                glucoseHistory = history
                treatments = fetchedTreatments
            }
        } catch {
            // History fetch failed -- keep whatever we have
            // Try them individually so partial success works
            if let history = try? await APIClient.shared.fetchGlucoseHistory(hours: 24) {
                withAnimation(.easeInOut(duration: 0.3)) {
                    glucoseHistory = history
                }
            }
            if let fetchedTreatments = try? await APIClient.shared.fetchTreatments(hours: 24) {
                withAnimation(.easeInOut(duration: 0.3)) {
                    treatments = fetchedTreatments
                }
            }
        }

        // Fetch prediction via server-side auto endpoint
        do {
            let pred = try await APIClient.shared.fetchAutoPrediction(horizon: predictionHorizon)
            withAnimation(.easeInOut(duration: 0.3)) {
                prediction = pred
            }
        } catch {
            // Prediction is optional -- fail silently
        }
    }

    /// Fetch the patient profile and cache the display name in app-group
    /// UserDefaults so widgets/watch can share it. Falls back to "ClearSugar".
    private func refreshPatientProfile() async {
        if let profile = try? await APIClient.shared.fetchProfile() {
            AppConfig.setPatientName(profile.name)
        }
        patientName = AppConfig.patientDisplayName
    }

    /// Up to two initials from the patient name, for the avatar circle.
    private var patientInitials: String {
        let words = patientName.split(separator: " ").prefix(2)
        let initials = words.compactMap { $0.first }.map(String.init).joined()
        return initials.isEmpty ? "CS" : initials.uppercased()
    }

    private func startAutoRefresh() {
        refreshTimer?.invalidate()
        refreshTimer = Timer.scheduledTimer(withTimeInterval: 150, repeats: true) { [weak refreshTimer] _ in // 2.5 min — Dexcom updates every 5 min
            // Guard against firing after invalidation
            guard refreshTimer != nil else { return }
            Task {
                await refreshChartData()
                await refresh()
            }
        }
    }
}

// MARK: - Safari View

struct SafariView: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> SFSafariViewController {
        let config = SFSafariViewController.Configuration()
        config.entersReaderIfAvailable = false
        let vc = SFSafariViewController(url: url, configuration: config)
        vc.preferredControlTintColor = UIColor(red: 0.486, green: 0.302, blue: 1.0, alpha: 1.0)
        return vc
    }

    func updateUIViewController(_ vc: SFSafariViewController, context: Context) {}
}

#Preview {
    ContentView()
}
