import Foundation

// Presentation permission only. Every write is still authorized by the server.
struct MealAccess: Codable, Equatable, Sendable {
    let sub: String
    let expiresAt: Date
    var children: [MealChild]? = nil

    func allows(subject: String?, now: Date = Date()) -> Bool {
        !sub.isEmpty && sub == subject && now < expiresAt
    }

    static let defaults = UserDefaults(suiteName: AppConfig.appGroup)
    private static let key = "mealAccess"

    static func load() -> MealAccess? {
        guard let data = defaults?.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(MealAccess.self, from: data)
    }

    static func save(_ access: MealAccess?) {
        if let access, let data = try? JSONEncoder().encode(access) {
            defaults?.set(data, forKey: key)
        } else {
            defaults?.removeObject(forKey: key)
        }
    }

    static var allowsWidgetEntry: Bool {
        guard let access = load() else { return false }
        return (access.children?.count ?? 1) == 1 && access.allows(subject: access.sub)
    }
}

struct MealChild: Codable, Equatable, Sendable, Identifiable {
    let id: String
    let name: String
    let isTest: Bool
}

enum MealAccessError: LocalizedError {
    case patientRequired

    var errorDescription: String? {
        "Meal entry is available only to the patient. Open ClearSugar and sign in with the patient account."
    }
}
