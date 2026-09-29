import Foundation

// MARK: - Lenient number decoding
//
// Episode and estimate payloads come from a JSON store the server keeps
// evolving, and the vision model's output is only clamped — not typed — before
// it is handed back. A single field arriving as "45" instead of 45 must not
// throw the whole decode away, so every optional number goes through this.

private func lenientDouble<K: CodingKey>(_ container: KeyedDecodingContainer<K>, _ key: K) -> Double? {
    if let value = try? container.decode(Double.self, forKey: key) {
        return value
    }
    if let text = try? container.decode(String.self, forKey: key), let value = Double(text) {
        return value
    }
    return nil
}

private func lenientString<K: CodingKey>(_ container: KeyedDecodingContainer<K>, _ key: K) -> String? {
    guard let value = try? container.decode(String.self, forKey: key), !value.isEmpty else {
        return nil
    }
    return value
}

/// Server timestamps are epoch milliseconds; a few older shards hold seconds.
/// Anything past ~1973 in milliseconds is above 1e11, which no plausible
/// seconds-value reaches, so the split is unambiguous for our data.
private func dateFromEpoch(_ value: Double?) -> Date? {
    guard let value, value > 0 else { return nil }
    return Date(timeIntervalSince1970: value > 1e11 ? value / 1000 : value)
}

// MARK: - Nutrition estimate (POST /api/meals/estimate)

/// A confirmed estimate is sent back to the server byte-for-field as received,
/// so every field the contract names is modelled here rather than summarised.
struct NutritionEstimate: Codable, Sendable, Equatable {
    struct CarbRange: Codable, Sendable, Equatable {
        let low: Double
        let mid: Double
        let high: Double

        private enum CodingKeys: String, CodingKey {
            case low, mid, high
        }

        init(low: Double, mid: Double, high: Double) {
            self.low = low
            self.mid = mid
            self.high = high
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            let mid = lenientDouble(container, .mid) ?? 0
            self.mid = mid
            self.low = lenientDouble(container, .low) ?? mid
            self.high = lenientDouble(container, .high) ?? mid
        }
    }

    struct Item: Codable, Sendable, Equatable {
        let name: String
        let portion: String?
        let carbs: Double?

        private enum CodingKeys: String, CodingKey {
            case name, portion, carbs
        }

        init(name: String, portion: String? = nil, carbs: Double? = nil) {
            self.name = name
            self.portion = portion
            self.carbs = carbs
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            name = lenientString(container, .name) ?? "Item"
            portion = lenientString(container, .portion)
            carbs = lenientDouble(container, .carbs)
        }
    }

    let carbs: CarbRange
    let protein: Double?
    let fat: Double?
    let fiber: Double?
    let giClass: String?
    let confidence: Double
    let items: [Item]?
    let model: String?
    let provider: String?
    let estimatedAt: String?
    let notes: String?
    let rawResponse: String?
    let followUp: String?
    let estimateId: String?
    let promptVersion: String?

    private enum CodingKeys: String, CodingKey {
        case carbs, protein, fat, fiber, giClass, confidence, items, model, provider, estimatedAt, notes, rawResponse, followUp, estimateId, promptVersion
    }

    init(
        carbs: CarbRange,
        protein: Double? = nil,
        fat: Double? = nil,
        fiber: Double? = nil,
        giClass: String? = nil,
        confidence: Double,
        items: [Item]? = nil,
        model: String? = nil,
        provider: String? = nil,
        estimatedAt: String? = nil,
        notes: String? = nil,
        rawResponse: String? = nil,
        followUp: String? = nil,
        estimateId: String? = nil,
        promptVersion: String? = nil
    ) {
        self.carbs = carbs
        self.protein = protein
        self.fat = fat
        self.fiber = fiber
        self.giClass = giClass
        self.confidence = confidence
        self.items = items
        self.model = model
        self.provider = provider
        self.estimatedAt = estimatedAt
        self.notes = notes
        self.rawResponse = rawResponse
        self.followUp = followUp
        self.estimateId = estimateId
        self.promptVersion = promptVersion
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        carbs = try container.decode(CarbRange.self, forKey: .carbs)
        protein = lenientDouble(container, .protein)
        fat = lenientDouble(container, .fat)
        fiber = lenientDouble(container, .fiber)
        giClass = lenientString(container, .giClass)
        confidence = min(max(lenientDouble(container, .confidence) ?? 0, 0), 1)
        items = try? container.decode([Item].self, forKey: .items)
        model = lenientString(container, .model)
        provider = lenientString(container, .provider)
        notes = lenientString(container, .notes)
        rawResponse = lenientString(container, .rawResponse)
        followUp = lenientString(container, .followUp)
        estimateId = lenientString(container, .estimateId)
        promptVersion = lenientString(container, .promptVersion)

        if let text = lenientString(container, .estimatedAt) {
            estimatedAt = text
        } else if let epoch = dateFromEpoch(lenientDouble(container, .estimatedAt)) {
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime]
            estimatedAt = formatter.string(from: epoch)
        } else {
            estimatedAt = nil
        }
    }

    /// "38\u{2013}55 g, likely 45 g" — the range leads, because the midpoint is
    /// the number a reader will otherwise treat as measured.
    var carbRangeText: String {
        let low = Int(carbs.low.rounded())
        let mid = Int(carbs.mid.rounded())
        let high = Int(carbs.high.rounded())
        if low == high {
            return "\(mid) g"
        }
        return "Most likely \(mid) g (\(low)\u{2013}\(high) g)"
    }

    var suggestedGrams: Int {
        max(0, Int(carbs.mid.rounded()))
    }
}

// MARK: - Reply (POST /api/meals/reply)

/// How long after the bolus eating actually started. Raw values are the server's
/// `EatTiming` vocabulary; `minutesBolusToEat` is derived server-side.
enum MealEatTiming: String, CaseIterable, Identifiable, Sendable {
    case beforeBolus = "before_bolus"
    case withBolus = "with_bolus"
    case five = "5"
    case fifteen = "15"
    case thirty = "30"
    case sixtyPlus = "60plus"

    var id: String { rawValue }

    var title: String {
        switch self {
        case .beforeBolus: return "Before bolus"
        case .withBolus: return "With bolus"
        case .five: return "5 min later"
        case .fifteen: return "15 min later"
        case .thirty: return "30 min later"
        case .sixtyPlus: return "60+ min later"
        }
    }
}

/// The three answers a glucose-rise prompt can take. A rise prompt asks whether
/// anything was eaten at all, so it does not share the bolus timing vocabulary.
enum MealRiseAnswer: String, CaseIterable, Identifiable, Sendable {
    case bolused
    case noBolus
    case didNotEat

    var id: String { rawValue }

    var title: String {
        switch self {
        case .bolused: return "Yes, bolused"
        case .noBolus: return "Yes, no bolus"
        case .didNotEat: return "No"
        }
    }
}

struct MealReplyInput: Codable, Sendable, Equatable {
    let childId: String?
    /// Server vocabulary for `kind`.
    static let kindChip = "chip"
    static let kindText = "text"
    static let kindPhoto = "photo"
    static let kindDismiss = "dismiss"

    /// The server caps free text at 280 characters; trim before sending so a
    /// long dictation is shortened rather than 400ed and dropped.
    static let maxTextLength = 280

    let episodeId: String
    let kind: String
    let ateSomething: Bool?
    let bolused: Bool?
    let eatTiming: String?
    let text: String?
    let photoId: String?
    let nutrition: NutritionEstimate?
    let mealLogId: String?

    init(
        episodeId: String,
        kind: String,
        ateSomething: Bool? = nil,
        bolused: Bool? = nil,
        eatTiming: String? = nil,
        text: String? = nil,
        photoId: String? = nil,
        nutrition: NutritionEstimate? = nil,
        mealLogId: String? = nil,
        childId: String? = nil
    ) {
        self.childId = childId
        self.episodeId = episodeId
        self.kind = kind
        self.ateSomething = ateSomething
        self.bolused = bolused
        self.eatTiming = eatTiming
        self.text = text
        self.photoId = photoId
        self.nutrition = nutrition
        self.mealLogId = mealLogId
    }

    // MARK: Notification-action mappings
    //
    // These four are the whole contract between the MEAL_PROMPT banner and the
    // server. They live here (not in the AppDelegate switch) so the mapping is
    // testable without a notification response.

    /// "Ate with bolus" chip.
    static func withBolus(episodeId: String) -> MealReplyInput {
        MealReplyInput(
            episodeId: episodeId,
            kind: kindChip,
            ateSomething: true,
            bolused: true,
            eatTiming: MealEatTiming.withBolus.rawValue
        )
    }

    /// "Ate 15+ min later" chip.
    static func ateLater(episodeId: String) -> MealReplyInput {
        MealReplyInput(
            episodeId: episodeId,
            kind: kindChip,
            ateSomething: true,
            eatTiming: MealEatTiming.fifteen.rawValue
        )
    }

    /// Text-input action ("What did you eat?") or the note field in the sheet.
    static func text(episodeId: String, text: String) -> MealReplyInput {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return MealReplyInput(
            episodeId: episodeId,
            kind: kindText,
            ateSomething: true,
            text: String(trimmed.prefix(maxTextLength))
        )
    }

    /// Swipe-away / "clear" on the banner. Recorded so an unanswered prompt is
    /// distinguishable from a declined one.
    static func dismiss(episodeId: String) -> MealReplyInput {
        MealReplyInput(episodeId: episodeId, kind: kindDismiss)
    }
}

// MARK: - Eating now (POST /api/meals/eating)

struct EatingNowInput: Codable, Sendable, Equatable {
    let clientId: String
    let at: Date?

    init(clientId: String = UUID().uuidString.lowercased(), at: Date? = nil) {
        self.clientId = clientId
        self.at = at
    }

    private enum CodingKeys: String, CodingKey {
        case clientId
        case at
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        clientId = try container.decode(String.self, forKey: .clientId)

        if let value = try container.decodeIfPresent(String.self, forKey: .at) {
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime]
            guard let date = formatter.date(from: value) else {
                throw DecodingError.dataCorruptedError(
                    forKey: .at,
                    in: container,
                    debugDescription: "Invalid ISO 8601 date"
                )
            }
            at = date
        } else {
            at = nil
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(clientId, forKey: .clientId)
        if let at {
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime]
            try container.encode(formatter.string(from: at), forKey: .at)
        }
    }
}

// MARK: - Episode (GET /api/meals/episodes)

/// Read-only mirror of the server's `MealEpisode`. Decode-only and deliberately
/// lenient: the app never writes one, and a field the server adds must not break
/// an installed build.
struct MealEpisode: Decodable, Sendable, Identifiable, Equatable {
    let id: String
    let openedAt: Date?
    let expiresAt: Date?
    let trigger: String
    let status: String
    let bolusAt: Date?
    let bolusInsulin: Double?
    let bolusCarbs: Double?
    let riseSinceAt: Date?
    let eatingAt: Date?
    let promptedAt: Date?
    let minutesBolusToEat: Double?
    let shadow: Bool

    private enum CodingKeys: String, CodingKey {
        case id, openedAt, expiresAt, trigger, status
        case bolusAt, bolusInsulin, bolusCarbs
        case riseSinceAt, eatingAt, promptedAt
        case minutesBolusToEat, shadow
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        openedAt = dateFromEpoch(lenientDouble(container, .openedAt))
        expiresAt = dateFromEpoch(lenientDouble(container, .expiresAt))
        trigger = lenientString(container, .trigger) ?? ""
        status = lenientString(container, .status) ?? ""
        bolusAt = dateFromEpoch(lenientDouble(container, .bolusAt))
        bolusInsulin = lenientDouble(container, .bolusInsulin)
        bolusCarbs = lenientDouble(container, .bolusCarbs)
        riseSinceAt = dateFromEpoch(lenientDouble(container, .riseSinceAt))
        eatingAt = dateFromEpoch(lenientDouble(container, .eatingAt))
        promptedAt = dateFromEpoch(lenientDouble(container, .promptedAt))
        minutesBolusToEat = lenientDouble(container, .minutesBolusToEat)
        shadow = (try? container.decode(Bool.self, forKey: .shadow)) ?? false
    }
}

// MARK: - Push prompt context

/// The `userInfo` of a MEAL_PROMPT push, in the shape the sheet needs. Built
/// from the raw notification dictionary, so it is also what a default tap
/// carries into the app.
struct MealPromptContext: Sendable, Equatable, Identifiable {
    static let pushKind = "meal_prompt"
    static let triggerPumpBolus = "pump_bolus"
    static let triggerGlucoseRise = "glucose_rise"

    let episodeId: String
    let trigger: String
    let promptKind: String?
    let bolusAt: Date?
    let carbs: Double?
    let insulin: Double?
    let riseSince: Date?

    var id: String { episodeId }

    /// A rise prompt asks a different question ("did you eat?") than a bolus
    /// prompt ("when did you eat?"), so the sheet branches on this.
    var isGlucoseRise: Bool { trigger == Self.triggerGlucoseRise }

    init(
        episodeId: String,
        trigger: String,
        promptKind: String? = nil,
        bolusAt: Date? = nil,
        carbs: Double? = nil,
        insulin: Double? = nil,
        riseSince: Date? = nil
    ) {
        self.episodeId = episodeId
        self.trigger = trigger
        self.promptKind = promptKind
        self.bolusAt = bolusAt
        self.carbs = carbs
        self.insulin = insulin
        self.riseSince = riseSince
    }

    /// Returns nil for any notification that is not a meal prompt, which is how
    /// the AppDelegate tells a MEAL_PROMPT dismissal apart from a glucose-alert
    /// dismissal (both arrive as UNNotificationDismissActionIdentifier).
    init?(userInfo: [AnyHashable: Any]) {
        guard Self.string(userInfo, "kind") == Self.pushKind,
              let episodeId = Self.string(userInfo, "episodeId") else {
            return nil
        }
        self.episodeId = episodeId
        self.trigger = Self.string(userInfo, "trigger") ?? Self.triggerPumpBolus
        self.promptKind = Self.string(userInfo, "promptKind")
        self.bolusAt = dateFromEpoch(Self.double(userInfo, "bolusAt"))
        self.carbs = Self.double(userInfo, "carbs")
        self.insulin = Self.double(userInfo, "insulin")
        self.riseSince = dateFromEpoch(Self.double(userInfo, "riseSince"))
    }

    private static func string(_ userInfo: [AnyHashable: Any], _ key: String) -> String? {
        guard let value = userInfo[key] as? String, !value.isEmpty else { return nil }
        return value
    }

    private static func double(_ userInfo: [AnyHashable: Any], _ key: String) -> Double? {
        if let number = userInfo[key] as? NSNumber { return number.doubleValue }
        if let value = userInfo[key] as? Double { return value }
        if let text = userInfo[key] as? String { return Double(text) }
        return nil
    }

    // MARK: Display

    /// Quotes the prompt back so the sheet is unambiguous about which meal is
    /// being answered: "2:14 PM bolus \u{00B7} 6.2 u for 55 g" or
    /// "Rising since 12:40 PM".
    var headline: String {
        if isGlucoseRise {
            guard let riseSince else { return "Glucose rising" }
            return "Rising since \(Self.localTime(riseSince))"
        }

        var parts: [String] = []
        if let bolusAt {
            parts.append("\(Self.localTime(bolusAt)) bolus")
        } else {
            parts.append("Recent bolus")
        }
        if let insulin {
            parts.append("\(Self.trimmedNumber(insulin)) u")
        }
        if let carbs {
            parts.append("for \(Self.trimmedNumber(carbs)) g")
        }
        return parts.joined(separator: " \u{00B7} ")
    }

    var question: String {
        isGlucoseRise ? "Did you eat something?" : "What did you eat?"
    }

    private static func localTime(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateStyle = .none
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }

    private static func trimmedNumber(_ value: Double) -> String {
        value == value.rounded() ? String(Int(value)) : String(format: "%.1f", value)
    }
}
