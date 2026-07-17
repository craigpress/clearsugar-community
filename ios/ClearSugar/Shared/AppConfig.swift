import Foundation

/// Central runtime configuration, compiled into all four targets
/// (iOS app, iOS widgets, watch app, watch complications).
///
/// Build-time values come from Info.plist keys that project.yml populates from
/// Config/Server.xcconfig:
///   - ClearSugarAppGroup  = group.$(CLEARSUGAR_BUNDLE_PREFIX)
///   - ClearSugarServerURL = $(CLEARSUGAR_SERVER_URL)
///
/// The server URL can also be entered at runtime in SetupView; the runtime
/// value (stored in app-group UserDefaults) always wins over the baked-in one
/// so widgets, the watch app, and the main app all agree.
enum AppConfig {

    // MARK: - App Group

    /// App group shared by the app, widgets, watch app, and complications.
    static let appGroup: String = {
        (Bundle.main.object(forInfoDictionaryKey: "ClearSugarAppGroup") as? String)
            ?? "group.invalid.clearsugar"
    }()

    /// Shared UserDefaults suite (falls back to .standard if the group is unavailable).
    static var sharedDefaults: UserDefaults {
        UserDefaults(suiteName: appGroup) ?? .standard
    }

    // MARK: - Server URL

    private static let runtimeServerURLKey = "clearsugar_server_url"

    /// The server URL baked in at build time. Empty when unset or still the placeholder.
    private static var bakedServerURLString: String {
        let raw = (Bundle.main.object(forInfoDictionaryKey: "ClearSugarServerURL") as? String) ?? ""
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("http"),
              !trimmed.contains("your-server.example.com") else { return "" }
        return trimmed
    }

    /// Effective server URL string: a URL the user entered in SetupView wins
    /// over the baked-in one. Empty string when nothing is configured.
    static var serverURLString: String {
        if let stored = sharedDefaults.string(forKey: runtimeServerURLKey), !stored.isEmpty {
            return stored
        }
        return bakedServerURLString
    }

    /// Effective server URL, or nil when the app is not yet configured.
    static var serverURL: URL? {
        let string = serverURLString
        guard !string.isEmpty else { return nil }
        return URL(string: string)
    }

    static var isServerConfigured: Bool { serverURL != nil }

    /// Store a server URL entered at runtime (SetupView). Pass nil/empty to clear.
    static func setRuntimeServerURL(_ urlString: String?) {
        guard var cleaned = urlString?.trimmingCharacters(in: .whitespacesAndNewlines),
              !cleaned.isEmpty else {
            sharedDefaults.removeObject(forKey: runtimeServerURLKey)
            return
        }
        while cleaned.hasSuffix("/") { cleaned.removeLast() }
        if !cleaned.hasPrefix("http") { cleaned = "https://" + cleaned }
        sharedDefaults.set(cleaned, forKey: runtimeServerURLKey)
    }

    // MARK: - Bundle Prefix

    /// The iOS app's bundle identifier. Extensions strip their well-known
    /// suffixes so every target derives the same prefix.
    static let bundlePrefix: String = {
        let raw = Bundle.main.bundleIdentifier ?? "com.example.clearsugar"
        for suffix in [".widgets", ".watchkitapp.complications", ".watchkitapp"] {
            if raw.hasSuffix(suffix) {
                return String(raw.dropLast(suffix.count))
            }
        }
        return raw
    }()

    /// BGTask identifier (must match BGTaskSchedulerPermittedIdentifiers in Info.plist).
    static var backgroundRefreshTaskID: String { bundlePrefix + ".refresh" }

    // MARK: - Keychain

    /// App-group-based Keychain access group shared across all targets.
    static var keychainAccessGroup: String { appGroup }

    static var jwtKeychainService: String { bundlePrefix + ".jwt" }
    static var apiKeyKeychainService: String { bundlePrefix + ".apikey" }
    static var credentialsKeychainService: String { bundlePrefix + ".credentials" }

    // MARK: - Patient Identity

    private static let patientNameKey = "cached_patient_name"

    /// Cached patient display name (from GET /api/profile). Falls back to
    /// "ClearSugar" when no profile is set — same convention as the web app.
    static var patientDisplayName: String {
        let stored = sharedDefaults.string(forKey: patientNameKey)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return stored.isEmpty ? "ClearSugar" : stored
    }

    static func setPatientName(_ name: String?) {
        let cleaned = name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if cleaned.isEmpty {
            sharedDefaults.removeObject(forKey: patientNameKey)
        } else {
            sharedDefaults.set(cleaned, forKey: patientNameKey)
        }
    }
}
