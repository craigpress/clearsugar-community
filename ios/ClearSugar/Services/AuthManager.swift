import Foundation
import Observation
import Security

@MainActor @Observable
final class AuthManager: NSObject {
    static let shared = AuthManager()

    // Auth state
    var isAuthenticated: Bool { authMethod != .none }
    private(set) var authMethod: AuthMethod = .none
    private(set) var username: String?
    /// Set when the stored JWT is expiring/expired and could not be silently
    /// refreshed — the UI surfaces a re-login banner instead of silently 401ing.
    private(set) var needsReauth = false
    /// Describes where the last sign-in attempt failed, for UI display
    private(set) var lastAuthError: String?

    enum AuthMethod {
        case none
        case credentials  // username/password → 7-day JWT from /api/auth/mobile/token
        case apiKey
    }

    /// Re-request a fresh JWT when the stored one expires within this window.
    private static let refreshWindow: TimeInterval = 24 * 60 * 60

    private override init() {
        super.init()
        loadAuthState()
    }

    // MARK: - Load Saved Auth

    private func loadAuthState() {
        if let jwt = Self.loadFromKeychain(service: AppConfig.jwtKeychainService) {
            print("[Auth] Found JWT in Keychain (\(jwt.prefix(20))...)")
            // Decode JWT to check expiry (without verifying signature — server does that)
            if let payload = decodeJWTPayload(jwt),
               let exp = payload["exp"] as? TimeInterval {
                let expiryDate = Date(timeIntervalSince1970: exp)
                if expiryDate > Date() {
                    authMethod = .credentials
                    username = (payload["name"] as? String) ?? (payload["sub"] as? String)
                    print("[Auth] JWT valid, expires \(expiryDate)")
                    return
                } else if loadStoredCredentials() != nil {
                    // Expired but we can silently re-login — stay authenticated
                    // and let refreshTokenIfNeeded() (called on launch/foreground)
                    // fetch a fresh token.
                    print("[Auth] JWT expired at \(expiryDate) — will refresh with stored credentials")
                    authMethod = .credentials
                    username = (payload["name"] as? String) ?? (payload["sub"] as? String)
                    return
                } else {
                    print("[Auth] JWT expired at \(expiryDate), no stored credentials — clearing")
                    Self.deleteFromKeychain(service: AppConfig.jwtKeychainService)
                }
            } else {
                print("[Auth] JWT decode failed — clearing")
                Self.deleteFromKeychain(service: AppConfig.jwtKeychainService)
            }
        } else {
            print("[Auth] No JWT in Keychain")
        }

        if let apiKey = Self.loadFromKeychain(service: AppConfig.apiKeyKeychainService), !apiKey.isEmpty {
            print("[Auth] Found API key in Keychain")
            authMethod = .apiKey
            return
        }

        print("[Auth] No saved auth — showing setup")
        authMethod = .none
    }

    // MARK: - Username/Password Login

    /// Exchange username/password for a 7-day JWT via POST /api/auth/mobile/token.
    /// Pass `serverURL` during first-time setup to store it; nil reuses the
    /// configured server.
    func login(serverURL: String? = nil, username: String, password: String) async -> Bool {
        lastAuthError = nil

        if let serverURL, !serverURL.trimmingCharacters(in: .whitespaces).isEmpty {
            AppConfig.setRuntimeServerURL(serverURL)
        }

        guard let base = AppConfig.serverURL else {
            lastAuthError = "Enter your server URL first."
            return false
        }

        var request = URLRequest(url: base.appendingPathComponent("api/auth/mobile/token"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: [
            "username": username,
            "password": password,
        ])
        request.timeoutInterval = 15

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                lastAuthError = "No HTTP response from server."
                return false
            }
            guard http.statusCode == 200 else {
                switch http.statusCode {
                case 401: lastAuthError = "Invalid username or password."
                case 429: lastAuthError = "Too many attempts — try again later."
                default:  lastAuthError = "Server error (HTTP \(http.statusCode))."
                }
                print("[Auth] Token request HTTP \(http.statusCode)")
                return false
            }
            let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            guard let token = json?["token"] as? String, !token.isEmpty else {
                lastAuthError = "Unexpected response from server."
                return false
            }

            // Persist JWT + credentials (credentials enable silent refresh)
            Self.saveToKeychain(service: AppConfig.jwtKeychainService, value: token)
            saveStoredCredentials(username: username, password: password)

            // Update APIClient
            await APIClient.shared.updateBearerToken(token)

            // Update state
            authMethod = .credentials
            let user = json?["user"] as? [String: Any]
            self.username = (user?["name"] as? String) ?? (user?["username"] as? String) ?? username
            needsReauth = false
            return true
        } catch {
            lastAuthError = "Network error: \(error.localizedDescription)"
            print("[Auth] Token request error: \(error)")
            return false
        }
    }

    // MARK: - Proactive JWT Refresh

    /// Called on launch and on foreground activation. If the stored JWT expires
    /// within 24h, silently re-request one with the stored credentials; if that
    /// isn't possible, flag `needsReauth` so the UI shows a re-login banner.
    func refreshTokenIfNeeded() async {
        guard authMethod == .credentials else { return }
        guard let jwt = Self.loadFromKeychain(service: AppConfig.jwtKeychainService),
              let payload = decodeJWTPayload(jwt),
              let exp = payload["exp"] as? TimeInterval else {
            needsReauth = loadStoredCredentials() == nil
            return
        }

        let expiryDate = Date(timeIntervalSince1970: exp)
        guard expiryDate < Date().addingTimeInterval(Self.refreshWindow) else {
            return // plenty of life left
        }

        guard let creds = loadStoredCredentials() else {
            print("[Auth] JWT expiring \(expiryDate), no stored credentials — needs re-login")
            needsReauth = true
            return
        }

        print("[Auth] JWT expiring \(expiryDate) — refreshing with stored credentials")
        let ok = await login(username: creds.username, password: creds.password)
        if ok {
            needsReauth = false
        } else {
            // Password may have changed server-side, or the server is down.
            // Only demand re-login once the token is actually unusable.
            needsReauth = expiryDate <= Date()
        }
    }

    // MARK: - QR Code Pairing

    /// Parse the payload of the pairing QR shown by the web dashboard
    /// (GET /api/auth/qr → qr_data = {"serverUrl": "..."}).
    /// Returns the server URL, or nil if the payload doesn't match.
    nonisolated static func parseQRPayload(_ string: String) -> String? {
        guard let data = string.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let serverUrl = json["serverUrl"] as? String,
              !serverUrl.trimmingCharacters(in: .whitespaces).isEmpty else {
            return nil
        }
        return serverUrl
    }

    // MARK: - Manual API Key

    func setAPIKey(_ key: String, serverURL: String? = nil) async -> Bool {
        lastAuthError = nil

        if let serverURL, !serverURL.trimmingCharacters(in: .whitespaces).isEmpty {
            AppConfig.setRuntimeServerURL(serverURL)
        }
        guard AppConfig.isServerConfigured else {
            lastAuthError = "Enter your server URL first."
            return false
        }

        await APIClient.shared.updateAPIKey(key)
        let ok = await APIClient.shared.testConnection()
        if ok {
            authMethod = .apiKey
            username = nil
            needsReauth = false
        } else {
            lastAuthError = "Connection failed. Check the server URL and API key."
        }
        return ok
    }

    // MARK: - Logout

    func logout() async {
        Self.deleteFromKeychain(service: AppConfig.jwtKeychainService)
        Self.deleteFromKeychain(service: AppConfig.apiKeyKeychainService)
        Self.deleteFromKeychain(service: AppConfig.credentialsKeychainService)
        await APIClient.shared.clearAuth()
        authMethod = .none
        username = nil
        needsReauth = false
    }

    // MARK: - Stored Credentials (for silent JWT refresh)

    private struct StoredCredentials: Codable {
        let username: String
        let password: String
    }

    private func saveStoredCredentials(username: String, password: String) {
        let creds = StoredCredentials(username: username, password: password)
        guard let data = try? JSONEncoder().encode(creds),
              let json = String(data: data, encoding: .utf8) else { return }
        Self.saveToKeychain(service: AppConfig.credentialsKeychainService, value: json)
    }

    private func loadStoredCredentials() -> (username: String, password: String)? {
        guard let json = Self.loadFromKeychain(service: AppConfig.credentialsKeychainService),
              let data = json.data(using: .utf8),
              let creds = try? JSONDecoder().decode(StoredCredentials.self, from: data) else {
            return nil
        }
        return (creds.username, creds.password)
    }

    // MARK: - JWT Decode (no verification — just read payload)

    private func decodeJWTPayload(_ jwt: String) -> [String: Any]? {
        let parts = jwt.split(separator: ".")
        guard parts.count == 3 else { return nil }
        var base64 = String(parts[1])
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        while base64.count % 4 != 0 { base64.append("=") }
        guard let data = Data(base64Encoded: base64) else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }

    // MARK: - Keychain Helpers

    /// Extract account name from service for unambiguous Keychain item identity
    nonisolated private static func accountForService(_ service: String) -> String {
        if service.hasSuffix(".jwt") { return "jwt" }
        if service.hasSuffix(".apikey") { return "apikey" }
        if service.hasSuffix(".credentials") { return "credentials" }
        return "default"
    }

    nonisolated static func loadFromKeychain(service: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: accountForService(service),
            kSecAttrAccessGroup as String: AppConfig.keychainAccessGroup,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status != errSecSuccess {
            print("[Keychain] Load \(accountForService(service)): OSStatus \(status)")
        }
        guard status == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    nonisolated static func saveToKeychain(service: String, value: String) {
        let data = value.data(using: .utf8)!
        deleteFromKeychain(service: service)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: accountForService(service),
            kSecAttrAccessGroup as String: AppConfig.keychainAccessGroup,
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
        ]
        let status = SecItemAdd(query as CFDictionary, nil)
        if status == errSecSuccess {
            print("[Keychain] Saved \(accountForService(service)) successfully")
        } else {
            print("[Keychain] FAILED to save \(accountForService(service)): OSStatus \(status)")
        }
    }

    nonisolated static func deleteFromKeychain(service: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: accountForService(service),
            kSecAttrAccessGroup as String: AppConfig.keychainAccessGroup,
        ]
        SecItemDelete(query as CFDictionary)
    }
}
