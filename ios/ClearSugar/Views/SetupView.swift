import SwiftUI

struct SetupView: View {
    let onComplete: () -> Void

    @State private var serverURLInput = AppConfig.serverURLString
    @State private var usernameInput = ""
    @State private var passwordInput = ""
    @State private var showQRScanner = false
    @State private var showAPIKeyEntry = false
    @State private var apiKeyInput = ""
    @State private var isSigningIn = false
    @State private var isTesting = false
    @State private var errorMessage: String?

    private let bgColor = Color.black
    private let accentPurple = Color(red: 0.486, green: 0.302, blue: 1.0)
    private let textSecondary = Color(red: 0.64, green: 0.64, blue: 0.64)
    private let surfaceColor = Color(red: 0.067, green: 0.067, blue: 0.067)

    private var canSignIn: Bool {
        !serverURLInput.trimmingCharacters(in: .whitespaces).isEmpty
            && !usernameInput.trimmingCharacters(in: .whitespaces).isEmpty
            && !passwordInput.isEmpty
    }

    var body: some View {
        ZStack {
            bgColor.ignoresSafeArea()

            ScrollView {
                VStack(spacing: 28) {
                    // Icon + title
                    VStack(spacing: 16) {
                        Image(systemName: "waveform.path.ecg")
                            .font(.system(size: 56))
                            .foregroundStyle(accentPurple)

                        Text("ClearSugar")
                            .font(.system(.largeTitle, design: .rounded).weight(.bold))
                            .foregroundStyle(.white)

                        Text("Connect to your self-hosted glucose server")
                            .font(.system(.body, design: .rounded))
                            .foregroundStyle(textSecondary)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 40)
                    }
                    .padding(.top, 48)

                    VStack(spacing: 14) {
                        // Server URL (scan the dashboard QR to fill it in)
                        HStack(spacing: 8) {
                            TextField("Server URL (https://…)", text: $serverURLInput)
                                .font(.system(.subheadline, design: .monospaced))
                                .keyboardType(.URL)
                                .textContentType(.URL)
                                .autocorrectionDisabled()
                                .textInputAutocapitalization(.never)
                                .padding(12)
                                .background(Color.white.opacity(0.06))
                                .clipShape(RoundedRectangle(cornerRadius: 10))

                            Button {
                                showQRScanner = true
                            } label: {
                                Image(systemName: "qrcode.viewfinder")
                                    .font(.title2)
                                    .foregroundStyle(accentPurple)
                                    .frame(width: 44, height: 44)
                                    .background(accentPurple.opacity(0.12))
                                    .clipShape(RoundedRectangle(cornerRadius: 10))
                            }
                            .accessibilityLabel("Scan setup QR code from the web dashboard")
                        }

                        // Username / password
                        TextField("Username", text: $usernameInput)
                            .font(.system(.body, design: .rounded))
                            .textContentType(.username)
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(.never)
                            .padding(12)
                            .background(Color.white.opacity(0.06))
                            .clipShape(RoundedRectangle(cornerRadius: 10))

                        SecureField("Password", text: $passwordInput)
                            .font(.system(.body, design: .rounded))
                            .textContentType(.password)
                            .padding(12)
                            .background(Color.white.opacity(0.06))
                            .clipShape(RoundedRectangle(cornerRadius: 10))

                        // Sign in
                        Button {
                            Task {
                                isSigningIn = true
                                errorMessage = nil
                                let success = await AuthManager.shared.login(
                                    serverURL: serverURLInput,
                                    username: usernameInput.trimmingCharacters(in: .whitespaces),
                                    password: passwordInput
                                )
                                isSigningIn = false
                                if success {
                                    onComplete()
                                } else {
                                    errorMessage = AuthManager.shared.lastAuthError ?? "Sign-in failed."
                                }
                            }
                        } label: {
                            HStack {
                                if isSigningIn {
                                    ProgressView()
                                        .scaleEffect(0.8)
                                        .tint(.white)
                                } else {
                                    Image(systemName: "person.badge.key.fill")
                                }
                                Text(isSigningIn ? "Signing in..." : "Sign In")
                            }
                            .font(.system(.body, design: .rounded).weight(.semibold))
                            .foregroundStyle(.white)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 16)
                            .background(canSignIn ? accentPurple : accentPurple.opacity(0.4))
                            .clipShape(RoundedRectangle(cornerRadius: 14))
                        }
                        .disabled(!canSignIn || isSigningIn)

                        // Alternative: manual API key
                        Button {
                            withAnimation(.easeInOut(duration: 0.2)) {
                                showAPIKeyEntry.toggle()
                            }
                        } label: {
                            HStack {
                                Image(systemName: "key.fill")
                                Text("Use an API Key Instead")
                            }
                            .font(.system(.subheadline, design: .rounded).weight(.medium))
                            .foregroundStyle(textSecondary)
                        }
                        .padding(.top, 4)

                        // Expandable API key field
                        if showAPIKeyEntry {
                            VStack(spacing: 12) {
                                SecureField("Paste API key", text: $apiKeyInput)
                                    .font(.system(.caption, design: .monospaced))
                                    .textContentType(.password)
                                    .autocorrectionDisabled()
                                    .textInputAutocapitalization(.never)
                                    .padding(12)
                                    .background(Color.white.opacity(0.06))
                                    .clipShape(RoundedRectangle(cornerRadius: 10))

                                Button {
                                    Task {
                                        isTesting = true
                                        errorMessage = nil
                                        let ok = await AuthManager.shared.setAPIKey(
                                            apiKeyInput,
                                            serverURL: serverURLInput
                                        )
                                        isTesting = false
                                        if ok {
                                            onComplete()
                                        } else {
                                            errorMessage = AuthManager.shared.lastAuthError
                                                ?? "Connection failed. Check your API key."
                                        }
                                    }
                                } label: {
                                    HStack {
                                        if isTesting {
                                            ProgressView().scaleEffect(0.7).tint(.white)
                                        }
                                        Text(isTesting ? "Testing..." : "Save & Connect")
                                    }
                                    .font(.system(.subheadline, design: .rounded).weight(.semibold))
                                    .foregroundStyle(.white)
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 12)
                                    .background(apiKeyInput.isEmpty ? accentPurple.opacity(0.4) : accentPurple)
                                    .clipShape(RoundedRectangle(cornerRadius: 10))
                                }
                                .disabled(apiKeyInput.isEmpty || isTesting)
                            }
                            .padding(16)
                            .background(surfaceColor)
                            .clipShape(RoundedRectangle(cornerRadius: 14))
                            .transition(.opacity.combined(with: .move(edge: .top)))
                        }

                        // Error message
                        if let errorMessage {
                            Text(errorMessage)
                                .font(.system(.caption, design: .rounded))
                                .foregroundStyle(Color(red: 0.94, green: 0.33, blue: 0.31))
                                .multilineTextAlignment(.center)
                        }

                        Text("Open the Mobile Setup card on your ClearSugar dashboard to show the pairing QR code.")
                            .font(.system(.caption2, design: .rounded))
                            .foregroundStyle(textSecondary)
                            .multilineTextAlignment(.center)
                            .padding(.top, 8)
                    }
                    .padding(.horizontal, 32)
                    .padding(.bottom, 48)
                }
            }
        }
        .sheet(isPresented: $showQRScanner) {
            QRScannerView { serverUrl in
                showQRScanner = false
                serverURLInput = serverUrl
                errorMessage = nil
            }
            .ignoresSafeArea()
        }
    }
}
