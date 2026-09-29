import XCTest
@testable import ClearSugar

final class MealProfileTests: XCTestCase {
    func testQueuedMealPreservesSelectedChildPhotoAndExplanation() throws {
        let estimate = NutritionEstimate(carbs: .init(low: 20, mid: 32, high: 50), confidence: 0.5,
                                         notes: "Includes BBQ sauce", rawResponse: "original JSON", followUp: "What about the sauce?",
                                         estimateId: "d737e7bc-a183-45a4-9f2c-7ad076031d60", promptVersion: "meal-v2")
        let input = MealLogInput(grams: 32, carbClass: "meal", reason: "other",
                                 eatenAt: Date(timeIntervalSince1970: 1788732420), photoId: "photo-id",
                                 nutrition: estimate, childId: "sandbox")
        let data = try JSONEncoder().encode(input)
        let decoded = try JSONDecoder().decode(MealLogInput.self, from: data)
        XCTAssertEqual(decoded, input)
        XCTAssertEqual(decoded.childId, "sandbox")
        XCTAssertEqual(decoded.nutrition?.notes, "Includes BBQ sauce")
        XCTAssertEqual(decoded.nutrition?.rawResponse, "original JSON")
        XCTAssertEqual(decoded.nutrition?.estimateId, estimate.estimateId)
        XCTAssertEqual(decoded.nutrition?.promptVersion, "meal-v2")
    }

    func testAllMinutesCanBeLoggedWithoutRounding() throws {
        for minute in 0..<60 {
            let date = Date(timeIntervalSince1970: 1788732000 + Double(minute * 60))
            let input = MealLogInput(grams: 15, carbClass: "rescue", reason: "low", eatenAt: date)
            let decoded = try JSONDecoder().decode(MealLogInput.self, from: JSONEncoder().encode(input))
            XCTAssertEqual(decoded.eatenAt, date)
        }
        XCTAssertEqual(MealCarbClass.meal.title, "Meal")
        XCTAssertEqual(MealCarbClass.rescue.title, "Quick sugar")
    }
}
