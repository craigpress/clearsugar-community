import XCTest
@testable import ClearSugar

/// The four MEAL_PROMPT actions are the whole contract between the notification
/// banner and POST /api/meals/reply. These assert the encoded body, not just the
/// struct, because a renamed key is silently accepted by the server as "field
/// absent" and the answer is lost.
final class MealReplyMappingTests: XCTestCase {
    private func body(_ input: MealReplyInput) throws -> [String: Any] {
        let data = try JSONEncoder().encode(input)
        let object = try JSONSerialization.jsonObject(with: data)
        return try XCTUnwrap(object as? [String: Any])
    }

    func testWithBolusMapsToChipWithBolusTiming() throws {
        let json = try body(.withBolus(episodeId: "ep-1"))

        XCTAssertEqual(json["episodeId"] as? String, "ep-1")
        XCTAssertEqual(json["kind"] as? String, "chip")
        XCTAssertEqual(json["ateSomething"] as? Bool, true)
        XCTAssertEqual(json["bolused"] as? Bool, true)
        XCTAssertEqual(json["eatTiming"] as? String, "with_bolus")
        XCTAssertNil(json["text"])
    }

    func testAteLaterMapsToFifteenMinuteTimingWithoutBolusFlag() throws {
        let json = try body(.ateLater(episodeId: "ep-2"))

        XCTAssertEqual(json["kind"] as? String, "chip")
        XCTAssertEqual(json["ateSomething"] as? Bool, true)
        XCTAssertEqual(json["eatTiming"] as? String, "15")
        // "Ate 15+ min later" says nothing about whether a bolus happened.
        XCTAssertNil(json["bolused"])
    }

    func testTextActionCarriesUserText() throws {
        let json = try body(.text(episodeId: "ep-3", text: "  two slices of pizza  "))

        XCTAssertEqual(json["kind"] as? String, "text")
        XCTAssertEqual(json["ateSomething"] as? Bool, true)
        XCTAssertEqual(json["text"] as? String, "two slices of pizza")
        XCTAssertNil(json["eatTiming"])
    }

    func testTextIsTrimmedToTheServerCap() throws {
        let long = String(repeating: "a", count: 400)
        let json = try body(.text(episodeId: "ep-4", text: long))

        XCTAssertEqual((json["text"] as? String)?.count, MealReplyInput.maxTextLength)
    }

    func testDismissCarriesNothingButTheEpisode() throws {
        let json = try body(.dismiss(episodeId: "ep-5"))

        XCTAssertEqual(json["kind"] as? String, "dismiss")
        XCTAssertEqual(json["episodeId"] as? String, "ep-5")
        XCTAssertNil(json["ateSomething"])
        XCTAssertNil(json["bolused"])
        XCTAssertNil(json["eatTiming"])
        XCTAssertNil(json["photoId"])
        XCTAssertNil(json["nutrition"])
    }

    func testPhotoReplyRoundTripsTheConfirmedEstimate() throws {
        let estimate = NutritionEstimate(
            carbs: .init(low: 38, mid: 45, high: 55),
            protein: 20,
            confidence: 0.62,
            items: [.init(name: "Pizza", portion: "2 slices", carbs: 45)],
            model: "test-model",
            provider: "bifrost",
            estimatedAt: "2026-09-04T18:00:00Z"
        )
        let input = MealReplyInput(
            episodeId: "ep-6",
            kind: MealReplyInput.kindPhoto,
            ateSomething: true,
            eatTiming: MealEatTiming.withBolus.rawValue,
            photoId: "photo-1",
            nutrition: estimate
        )

        let data = try JSONEncoder().encode(input)
        let decoded = try JSONDecoder().decode(MealReplyInput.self, from: data)

        XCTAssertEqual(decoded, input)
        XCTAssertEqual(decoded.nutrition?.carbs.mid, 45)
        XCTAssertEqual(decoded.nutrition?.model, "test-model")
    }

    // MARK: Push userInfo -> prompt context

    func testPromptContextRejectsNonMealPushes() {
        XCTAssertNil(MealPromptContext(userInfo: ["alertType": "urgentLow"]))
        XCTAssertNil(MealPromptContext(userInfo: ["kind": "meal_prompt"]))  // no episodeId
    }

    func testPromptContextReadsBolusTriggerFields() throws {
        let bolusAtMs: Double = 1_757_000_040_000
        let context = try XCTUnwrap(MealPromptContext(userInfo: [
            "kind": "meal_prompt",
            "episodeId": "ep-7",
            "trigger": "pump_bolus",
            "promptKind": "bolus",
            "bolusAt": bolusAtMs,
            "carbs": 55,
            "insulin": 6.2,
        ]))

        XCTAssertEqual(context.episodeId, "ep-7")
        XCTAssertFalse(context.isGlucoseRise)
        XCTAssertEqual(context.carbs, 55)
        XCTAssertEqual(context.insulin, 6.2)
        XCTAssertEqual(context.bolusAt, Date(timeIntervalSince1970: bolusAtMs / 1000))
        // Time is local, so assert the parts that don't move.
        XCTAssertTrue(context.headline.contains("bolus"))
        XCTAssertTrue(context.headline.contains("6.2 u"))
        XCTAssertTrue(context.headline.contains("for 55 g"))
        XCTAssertEqual(context.question, "What did you eat?")
    }

    func testPromptContextReadsRiseTrigger() throws {
        let context = try XCTUnwrap(MealPromptContext(userInfo: [
            "kind": "meal_prompt",
            "episodeId": "ep-8",
            "trigger": "glucose_rise",
            "riseSince": 1_757_000_040_000 as Double,
        ]))

        XCTAssertTrue(context.isGlucoseRise)
        XCTAssertTrue(context.headline.hasPrefix("Rising since "))
        XCTAssertEqual(context.question, "Did you eat something?")
    }
}
