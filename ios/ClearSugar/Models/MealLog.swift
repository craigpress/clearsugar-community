import Foundation

struct MealLog: Codable, Sendable, Identifiable {
    let id: String
    let createdAt: Double
    let eatenAt: Double
    let source: String
    let carbClass: String
    let reason: String?
    let description: String?
    let grams: Double?
    let nightscoutId: String?
    let clientId: String?
}

/// Shared by the quick-carb sheet, the meal sheet and `LogCarbsIntent` so the
/// raw values that reach `POST /api/meals` are declared once.
enum MealCarbClass: String, CaseIterable, Identifiable, Sendable {
    case rescue
    case snack
    case meal

    var id: Self { self }
    var title: String { self == .rescue ? "Quick sugar" : self == .meal ? "Meal" : "Snack" }
}

enum MealLogReason: String, CaseIterable, Identifiable, Sendable {
    case low
    case forgotBolus = "forgot_bolus"
    case other

    var id: Self { self }

    var title: String {
        switch self {
        case .low: return "Low"
        case .forgotBolus: return "Forgot bolus"
        case .other: return "Other"
        }
    }
}

struct MealLogInput: Codable, Sendable, Equatable {
    let childId: String?
    let clientId: String
    let grams: Int
    let carbClass: String
    let reason: String
    let eatenAt: Date?
    let description: String?
    /// Set only when the grams came from a confirmed photo estimate.
    let photoId: String?
    /// The confirmed estimate, echoed back exactly as the server returned it so
    /// provenance (model, provider, confidence) is stored with the meal.
    let nutrition: NutritionEstimate?

    init(
        clientId: String = UUID().uuidString.lowercased(),
        grams: Int,
        carbClass: String,
        reason: String,
        eatenAt: Date? = nil,
        description: String? = nil,
        photoId: String? = nil,
        nutrition: NutritionEstimate? = nil,
        childId: String? = nil
    ) {
        self.childId = childId
        self.clientId = clientId
        self.grams = grams
        self.carbClass = carbClass
        self.reason = reason
        self.eatenAt = eatenAt
        self.description = description
        self.photoId = photoId
        self.nutrition = nutrition
    }

    private enum CodingKeys: String, CodingKey {
        case clientId
        case childId
        case grams
        case carbClass
        case reason
        case eatenAt
        case description
        case photoId
        case nutrition
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        childId = try container.decodeIfPresent(String.self, forKey: .childId)
        clientId = try container.decode(String.self, forKey: .clientId)
        grams = try container.decode(Int.self, forKey: .grams)
        carbClass = try container.decode(String.self, forKey: .carbClass)
        reason = try container.decode(String.self, forKey: .reason)
        description = try container.decodeIfPresent(String.self, forKey: .description)
        photoId = try container.decodeIfPresent(String.self, forKey: .photoId)
        nutrition = try container.decodeIfPresent(NutritionEstimate.self, forKey: .nutrition)

        if let value = try container.decodeIfPresent(String.self, forKey: .eatenAt) {
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime]
            guard let date = formatter.date(from: value) else {
                throw DecodingError.dataCorruptedError(
                    forKey: .eatenAt,
                    in: container,
                    debugDescription: "Invalid ISO 8601 date"
                )
            }
            eatenAt = date
        } else {
            eatenAt = nil
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(childId, forKey: .childId)
        try container.encode(clientId, forKey: .clientId)
        try container.encode(grams, forKey: .grams)
        try container.encode(carbClass, forKey: .carbClass)
        try container.encode(reason, forKey: .reason)
        try container.encodeIfPresent(description, forKey: .description)
        try container.encodeIfPresent(photoId, forKey: .photoId)
        try container.encodeIfPresent(nutrition, forKey: .nutrition)

        if let eatenAt {
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime]
            try container.encode(formatter.string(from: eatenAt), forKey: .eatenAt)
        }
    }
}
