import Foundation

/// A stable identifier for THIS app install, generated once and persisted in the
/// app group. The server pairs a device's push-to-start token and per-activity
/// update token by this id, so it must survive relaunches and APNs token rotation.
enum InstallIdentity {
    static let key = "clearsugar.installId"
    private static let appGroup = AppConfig.keychainAccessGroup

    /// The app-group defaults, or `.standard` if the group is unavailable (tests pass their own).
    private static var groupDefaults: UserDefaults {
        UserDefaults(suiteName: appGroup) ?? .standard
    }

    static func current(defaults: UserDefaults? = nil) -> String {
        let store = defaults ?? groupDefaults
        if let existing = store.string(forKey: key), !existing.isEmpty {
            return existing
        }
        let fresh = UUID().uuidString.lowercased()
        store.set(fresh, forKey: key)
        return fresh
    }
}
