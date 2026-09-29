import XCTest
@testable import ClearSugar

/// Regression tests for the foreground auto-refresh timer.
///
/// The original ContentView implementation captured the `refreshTimer`
/// property `[weak refreshTimer]` at closure-creation time — before the new
/// timer was assigned — so the guard inside the callback always saw nil (or
/// the just-invalidated previous timer) and returned without refreshing.
/// Foreground auto-refresh never fired. RefreshScheduler owns its timer
/// directly so the tick cannot be silently dropped.
@MainActor
final class RefreshSchedulerTests: XCTestCase {

    func testTickFiresAfterStart() {
        let scheduler = RefreshScheduler(interval: 0.05)
        let fired = expectation(description: "tick fired")
        fired.assertForOverFulfill = false

        scheduler.start { fired.fulfill() }

        wait(for: [fired], timeout: 2.0)
        scheduler.stop()
    }

    func testRestartKeepsFiring() {
        // The buggy version died precisely on restart: the new closure saw the
        // old invalidated timer and bailed forever.
        let scheduler = RefreshScheduler(interval: 0.05)
        scheduler.start {}
        let fired = expectation(description: "tick fired after restart")
        fired.assertForOverFulfill = false

        scheduler.start { fired.fulfill() }

        wait(for: [fired], timeout: 2.0)
        scheduler.stop()
    }

    func testStopPreventsFurtherTicks() {
        let scheduler = RefreshScheduler(interval: 0.05)
        var ticks = 0
        scheduler.start { ticks += 1 }
        scheduler.stop()
        let settle = expectation(description: "settle")

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { settle.fulfill() }
        wait(for: [settle], timeout: 2.0)

        XCTAssertEqual(ticks, 0)
        XCTAssertFalse(scheduler.isRunning)
    }

    func testIsRunningReflectsState() {
        let scheduler = RefreshScheduler(interval: 60)
        XCTAssertFalse(scheduler.isRunning)
        scheduler.start {}
        XCTAssertTrue(scheduler.isRunning)
        scheduler.stop()
        XCTAssertFalse(scheduler.isRunning)
    }
}
