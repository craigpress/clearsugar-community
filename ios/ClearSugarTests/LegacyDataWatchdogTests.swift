import XCTest
@testable import ClearSugar

@MainActor
final class LegacyDataWatchdogTests: XCTestCase {
    func testRetirementRemovesOnlyLegacyWatchdog() {
        var pending: Set<String> = ["data-watchdog", "urgent-glucose-repeat"]
        var delivered: Set<String> = ["data-watchdog", "urgent-glucose", "pump-stale"]
        AlertManager.retireLegacyDataWatchdog(
            removePending: { pending.subtract($0) },
            removeDelivered: { delivered.subtract($0) }
        )
        XCTAssertEqual(pending, ["urgent-glucose-repeat"])
        XCTAssertEqual(delivered, ["urgent-glucose", "pump-stale"])
    }
}
