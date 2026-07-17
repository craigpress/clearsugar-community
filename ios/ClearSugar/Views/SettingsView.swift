import SwiftUI
import SafariServices

struct SettingsView: View {
    // Alert toggles
    @AppStorage("alertsLowEnabled") private var alertsLowEnabled = true
    @AppStorage("alertsHighEnabled") private var alertsHighEnabled = true
    @AppStorage("alertsUrgentEnabled") private var alertsUrgentEnabled = true

    // Glucose thresholds
    @AppStorage("thresholdUrgentLow") private var thresholdUrgentLow: Double = 55
    @AppStorage("thresholdLow") private var thresholdLow: Double = 70
    @AppStorage("thresholdHigh") private var thresholdHigh: Double = 180
    @AppStorage("thresholdUrgentHigh") private var thresholdUrgentHigh: Double = 250

    // Alert tones
    @AppStorage("urgentAlertTone") private var urgentAlertTone: String = "Critical (Default)"
    @AppStorage("warningAlertTone") private var warningAlertTone: String = "Default"
    @AppStorage("hapticFeedbackEnabled") private var hapticFeedbackEnabled = true

    // Prediction
    @AppStorage("predictionHorizon") private var predictionHorizon: Int = 30

    // Server / API key
    @State private var apiKeyInput: String = ""
    @State private var connectionStatus: ConnectionTestStatus = .idle
    @State private var showWebDashboard = false

    enum ConnectionTestStatus {
        case idle, testing, success, failure
    }

    // MARK: - Design Tokens

    private let bgColor = Color(red: 0, green: 0, blue: 0)
    private let surfaceColor = Color(red: 0.067, green: 0.067, blue: 0.067)
    private let borderColor = Color.white.opacity(0.06)
    private let textSecondary = Color(red: 0.64, green: 0.64, blue: 0.64)
    private let accentPurple = Color(red: 0.486, green: 0.302, blue: 1.0)
    private let inRangeGreen = Color(red: 0.40, green: 0.73, blue: 0.42)
    private let urgentRed = Color(red: 0.94, green: 0.33, blue: 0.31)
    private let warningOrange = Color(red: 1.0, green: 0.72, blue: 0.30)

    private let urgentToneOptions = ["Critical (Default)", "Alarm", "Chime"]
    private let warningToneOptions = ["Default", "Gentle", "None"]
    private let horizonOptions = [15, 30, 60, 180]

    private var appVersion: String {
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0"
        let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "1"
        return "\(version) (\(build))"
    }

    var body: some View {
        NavigationStack {
            ZStack {
                bgColor.ignoresSafeArea()

                ScrollView {
                    VStack(spacing: 24) {
                        header
                        serverSection
                        thresholdsSection
                        alertTonesSection
                        alertsSection
                        predictionSection
                        aboutSection
                    }
                    .padding(.horizontal, 20)
                    .padding(.top, 16)
                    .padding(.bottom, 40)
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarColorScheme(.dark, for: .navigationBar)
        }
        .preferredColorScheme(.dark)
        .onChange(of: thresholdUrgentLow) { _, _ in syncThresholds() }
        .onChange(of: thresholdLow) { _, _ in syncThresholds() }
        .onChange(of: thresholdHigh) { _, _ in syncThresholds() }
        .onChange(of: thresholdUrgentHigh) { _, _ in syncThresholds() }
    }

    private func syncThresholds() {
        Task { await ThresholdSyncer.sync() }
    }

    // MARK: - Header

    private var header: some View {
        VStack(spacing: 4) {
            Text("ClearSugar")
                .font(.system(.title2, design: .rounded))
                .fontWeight(.bold)
                .foregroundStyle(.white)
            Text("v\(appVersion)")
                .font(.system(.caption, design: .rounded))
                .foregroundStyle(textSecondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 12)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("ClearSugar version \(appVersion)")
    }

    // MARK: - Server / Account

    private var serverSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionHeader("Account")

            VStack(spacing: 0) {
                // Current auth status
                HStack(spacing: 12) {
                    Image(systemName: authStatusIcon)
                        .foregroundStyle(authStatusColor)
                        .frame(width: 24)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(authStatusTitle)
                            .font(.system(.body, design: .rounded))
                            .fontWeight(.medium)
                            .foregroundStyle(.white)
                        Text(authStatusSubtitle)
                            .font(.system(.caption, design: .rounded))
                            .foregroundStyle(textSecondary)
                    }
                    Spacer()
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(inRangeGreen)
                }
                .padding(16)

                Divider().background(borderColor)

                // Sign out button
                Button(role: .destructive) {
                    Task {
                        await AuthManager.shared.logout()
                    }
                } label: {
                    HStack(spacing: 12) {
                        Image(systemName: "rectangle.portrait.and.arrow.right")
                            .foregroundStyle(urgentRed)
                            .frame(width: 24)
                        Text("Sign Out")
                            .font(.system(.body, design: .rounded))
                            .fontWeight(.medium)
                            .foregroundStyle(urgentRed)
                        Spacer()
                    }
                    .padding(16)
                }
            }
            .background(surfaceColor)
            .clipShape(RoundedRectangle(cornerRadius: 16))
            .overlay(
                RoundedRectangle(cornerRadius: 16)
                    .stroke(borderColor, lineWidth: 1)
            )
        }
    }

    private var authStatusIcon: String {
        switch AuthManager.shared.authMethod {
        case .credentials: return "person.badge.key.fill"
        case .apiKey: return "key.fill"
        case .none: return "exclamationmark.triangle.fill"
        }
    }

    private var authStatusColor: Color {
        switch AuthManager.shared.authMethod {
        case .credentials: return accentPurple
        case .apiKey: return accentPurple
        case .none: return urgentRed
        }
    }

    private var authStatusTitle: String {
        switch AuthManager.shared.authMethod {
        case .credentials: return AuthManager.shared.username ?? "Signed in"
        case .apiKey: return "API Key"
        case .none: return "Not connected"
        }
    }

    private var authStatusSubtitle: String {
        switch AuthManager.shared.authMethod {
        case .credentials: return "Signed in with username & password"
        case .apiKey: return "Connected with API key"
        case .none: return "Set up in onboarding"
        }
    }

    // MARK: - Glucose Thresholds

    private var thresholdsSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionHeader("Glucose Thresholds")

            VStack(spacing: 0) {
                thresholdSlider(
                    title: "Urgent Low",
                    value: $thresholdUrgentLow,
                    range: 40...70,
                    color: urgentRed,
                    icon: "exclamationmark.triangle.fill"
                )

                Divider().background(borderColor)

                thresholdSlider(
                    title: "Low",
                    value: $thresholdLow,
                    range: 55...90,
                    color: warningOrange,
                    icon: "arrow.down.circle.fill"
                )

                Divider().background(borderColor)

                thresholdSlider(
                    title: "High",
                    value: $thresholdHigh,
                    range: 140...250,
                    color: warningOrange,
                    icon: "arrow.up.circle.fill"
                )

                Divider().background(borderColor)

                thresholdSlider(
                    title: "Urgent High",
                    value: $thresholdUrgentHigh,
                    range: 200...400,
                    color: urgentRed,
                    icon: "exclamationmark.triangle.fill"
                )
            }
            .background(surfaceColor)
            .clipShape(RoundedRectangle(cornerRadius: 16))
            .overlay(
                RoundedRectangle(cornerRadius: 16)
                    .stroke(borderColor, lineWidth: 1)
            )
        }
    }

    // MARK: - Alert Tones

    private var alertTonesSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionHeader("Alert Tones")

            VStack(spacing: 0) {
                // Urgent alert tone picker
                HStack(spacing: 12) {
                    Image(systemName: "bell.badge.fill")
                        .foregroundStyle(urgentRed)
                        .frame(width: 24)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Urgent Alert Tone")
                            .font(.system(.body, design: .rounded))
                            .fontWeight(.medium)
                            .foregroundStyle(.white)
                    }
                    Spacer()
                    Picker("", selection: $urgentAlertTone) {
                        ForEach(urgentToneOptions, id: \.self) { option in
                            Text(option).tag(option)
                        }
                    }
                    .tint(accentPurple)
                }
                .padding(16)

                Divider().background(borderColor)

                // Warning alert tone picker
                HStack(spacing: 12) {
                    Image(systemName: "bell.fill")
                        .foregroundStyle(warningOrange)
                        .frame(width: 24)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Warning Alert Tone")
                            .font(.system(.body, design: .rounded))
                            .fontWeight(.medium)
                            .foregroundStyle(.white)
                    }
                    Spacer()
                    Picker("", selection: $warningAlertTone) {
                        ForEach(warningToneOptions, id: \.self) { option in
                            Text(option).tag(option)
                        }
                    }
                    .tint(accentPurple)
                }
                .padding(16)

                Divider().background(borderColor)

                // Haptic feedback toggle
                alertToggle(
                    title: "Haptic Feedback",
                    subtitle: "Vibrate for out-of-range readings",
                    icon: "iphone.radiowaves.left.and.right",
                    iconColor: accentPurple,
                    isOn: $hapticFeedbackEnabled
                )
            }
            .background(surfaceColor)
            .clipShape(RoundedRectangle(cornerRadius: 16))
            .overlay(
                RoundedRectangle(cornerRadius: 16)
                    .stroke(borderColor, lineWidth: 1)
            )
        }
    }

    // MARK: - Alert Settings

    private var alertsSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionHeader("Alert Settings")

            VStack(spacing: 0) {
                alertToggle(
                    title: "Low Glucose Alerts",
                    subtitle: "Below \(Int(thresholdLow)) mg/dL",
                    icon: "arrow.down.circle.fill",
                    iconColor: warningOrange,
                    isOn: $alertsLowEnabled
                )

                Divider().background(borderColor)

                alertToggle(
                    title: "High Glucose Alerts",
                    subtitle: "Above \(Int(thresholdHigh)) mg/dL",
                    icon: "arrow.up.circle.fill",
                    iconColor: warningOrange,
                    isOn: $alertsHighEnabled
                )

                Divider().background(borderColor)

                alertToggle(
                    title: "Urgent Alerts",
                    subtitle: "Below \(Int(thresholdUrgentLow)) or above \(Int(thresholdUrgentHigh)) mg/dL",
                    icon: "exclamationmark.triangle.fill",
                    iconColor: urgentRed,
                    isOn: $alertsUrgentEnabled
                )
            }
            .background(surfaceColor)
            .clipShape(RoundedRectangle(cornerRadius: 16))
            .overlay(
                RoundedRectangle(cornerRadius: 16)
                    .stroke(borderColor, lineWidth: 1)
            )
        }
    }

    // MARK: - Prediction Settings

    private var predictionSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionHeader("Prediction")

            VStack(spacing: 0) {
                // Prediction horizon picker
                HStack(spacing: 12) {
                    Image(systemName: "chart.line.uptrend.xyaxis")
                        .foregroundStyle(accentPurple)
                        .frame(width: 24)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Prediction Horizon")
                            .font(.system(.body, design: .rounded))
                            .fontWeight(.medium)
                            .foregroundStyle(.white)
                        Text("How far ahead to predict")
                            .font(.system(.caption, design: .rounded))
                            .foregroundStyle(textSecondary)
                    }
                    Spacer()
                    Picker("", selection: $predictionHorizon) {
                        ForEach(horizonOptions, id: \.self) { mins in
                            Text(horizonLabel(mins)).tag(mins)
                        }
                    }
                    .tint(accentPurple)
                }
                .padding(16)
            }
            .background(surfaceColor)
            .clipShape(RoundedRectangle(cornerRadius: 16))
            .overlay(
                RoundedRectangle(cornerRadius: 16)
                    .stroke(borderColor, lineWidth: 1)
            )
        }
    }

    // MARK: - About Section

    private var aboutSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionHeader("About")

            VStack(spacing: 0) {
                HStack(spacing: 12) {
                    Image(systemName: "heart.fill")
                        .foregroundStyle(urgentRed)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("ClearSugar Community")
                            .font(.system(.body, design: .rounded))
                            .fontWeight(.medium)
                            .foregroundStyle(.white)
                        Text("Self-hosted T1D monitoring")
                            .font(.system(.caption, design: .rounded))
                            .foregroundStyle(textSecondary)
                    }
                    Spacer()
                }
                .padding(16)

                if let dashboardURL = AppConfig.serverURL {
                    Divider().background(borderColor)

                    Button {
                        showWebDashboard = true
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: "globe")
                                .foregroundStyle(accentPurple)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("View Dashboard")
                                    .font(.system(.body, design: .rounded))
                                    .fontWeight(.medium)
                                    .foregroundStyle(.white)
                                Text(dashboardURL.host ?? AppConfig.serverURLString)
                                    .font(.system(.caption, design: .rounded))
                                    .foregroundStyle(textSecondary)
                            }
                            Spacer()
                            Image(systemName: "arrow.up.right")
                                .font(.caption)
                                .foregroundStyle(textSecondary)
                        }
                        .padding(16)
                    }
                    .sheet(isPresented: $showWebDashboard) {
                        SafariView(url: dashboardURL)
                    }
                    .accessibilityLabel("Open ClearSugar web dashboard")
                }
            }
            .background(surfaceColor)
            .clipShape(RoundedRectangle(cornerRadius: 16))
            .overlay(
                RoundedRectangle(cornerRadius: 16)
                    .stroke(borderColor, lineWidth: 1)
            )
        }
    }

    // MARK: - Helpers

    @ViewBuilder
    private func sectionHeader(_ title: String) -> some View {
        Text(title.uppercased())
            .font(.system(.caption, design: .rounded))
            .fontWeight(.semibold)
            .foregroundStyle(textSecondary)
            .tracking(0.8)
    }

    @ViewBuilder
    private func alertToggle(
        title: String,
        subtitle: String,
        icon: String,
        iconColor: Color,
        isOn: Binding<Bool>
    ) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .foregroundStyle(iconColor)
                .frame(width: 24)

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.system(.body, design: .rounded))
                    .fontWeight(.medium)
                    .foregroundStyle(.white)
                Text(subtitle)
                    .font(.system(.caption, design: .rounded))
                    .foregroundStyle(textSecondary)
            }

            Spacer()

            Toggle("", isOn: isOn)
                .labelsHidden()
                .tint(accentPurple)
        }
        .padding(16)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(title), \(subtitle)")
        .accessibilityValue(isOn.wrappedValue ? "enabled" : "disabled")
    }

    @ViewBuilder
    private func thresholdSlider(
        title: String,
        value: Binding<Double>,
        range: ClosedRange<Double>,
        color: Color,
        icon: String
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 12) {
                Image(systemName: icon)
                    .foregroundStyle(color)
                    .frame(width: 24)
                Text(title)
                    .font(.system(.body, design: .rounded))
                    .fontWeight(.medium)
                    .foregroundStyle(.white)
                Spacer()
                Text("\(Int(value.wrappedValue)) mg/dL")
                    .font(.system(.subheadline, design: .rounded))
                    .fontWeight(.semibold)
                    .foregroundStyle(color)
                    .monospacedDigit()
            }
            Slider(value: value, in: range, step: 5)
                .tint(color)
        }
        .padding(16)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(title) threshold")
        .accessibilityValue("\(Int(value.wrappedValue)) milligrams per deciliter")
    }

    private func horizonLabel(_ minutes: Int) -> String {
        if minutes < 60 {
            return "\(minutes) min"
        } else {
            let hours = minutes / 60
            return "\(hours) hr"
        }
    }
}

#Preview {
    SettingsView()
}
