import XCTest
@testable import ClearSugar

final class GlucoseValidityTests: XCTestCase {
    private func reading(_ sgv: Int) -> GlucoseReading {
        GlucoseReading(
            sgv: sgv,
            direction: "Flat",
            date: Date().timeIntervalSince1970 * 1000,
            dateString: nil,
            delta: 0,
            pumpLastUpdate: nil,
            pumpStaleMinutes: nil,
            pumpIsStale: nil
        )
    }

    func testSensorSentinelsAndGarbageAreInvalid() {
        XCTAssertFalse(reading(0).isValid)
        XCTAssertFalse(reading(1).isValid)
        XCTAssertFalse(reading(12).isValid)
        XCTAssertFalse(reading(600).isValid)
        XCTAssertFalse(reading(999).isValid)
    }

    func testPhysiologicalBoundaryValuesRemainValid() {
        XCTAssertTrue(reading(13).isValid)
        XCTAssertTrue(reading(39).isValid)
        XCTAssertTrue(reading(599).isValid)
    }

    func testSharedRangeClassifierRejectsInvalidValues() {
        XCTAssertNil(RangeCategory.classify(0))
        XCTAssertNil(RangeCategory.classify(600))
        XCTAssertEqual(RangeCategory.classify(54), .urgentLow)
        XCTAssertEqual(RangeCategory.classify(70), .inRange)
        XCTAssertEqual(RangeCategory.classify(251), .urgentHigh)
    }
}

final class WidgetNoDataTests: XCTestCase {
    func testNoDataNeverUsesPreviewValues() {
        let entry = GlucoseWidgetEntry.noData
        XCTAssertEqual(entry.glucoseText, "—")
        XCTAssertEqual(entry.trendArrow, "")
        XCTAssertEqual(entry.deltaString, "")
        XCTAssertTrue(entry.sparklineValues.isEmpty)
        XCTAssertNil(entry.iob)
        XCTAssertTrue(entry.isStale)
    }
}
