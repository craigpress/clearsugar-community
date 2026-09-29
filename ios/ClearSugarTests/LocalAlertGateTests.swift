import XCTest
@testable import ClearSugar

/// Build-13 regression cover: the on-device alerter fired in parallel with the
/// server pushes (and ignored snoozes entirely), so every threshold crossing
/// produced duplicate banners and a snooze appeared to do nothing.
final class LocalAlertGateTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_784_900_000)

    func testSuppressedWhileServerPushesAreArriving() {
        // Pushes arriving 2 min ago → server owns alerting; local stays quiet.
        XCTAssertFalse(LocalAlertGate.mayFire(
            now: now, lastServerPush: now.addingTimeInterval(-120),
            snoozedUntil: nil, snoozedUntilRange: false
        ))
    }

    func testFiresOnceThePushPipelineGoesQuiet() {
        XCTAssertTrue(LocalAlertGate.mayFire(
            now: now, lastServerPush: now.addingTimeInterval(-16 * 60),
            snoozedUntil: nil, snoozedUntilRange: false
        ))
    }

    func testFiresWhenNoPushWasEverSeen() {
        // Fresh install: better a duplicate on day one than silence in an outage.
        XCTAssertTrue(LocalAlertGate.mayFire(
            now: now, lastServerPush: nil,
            snoozedUntil: nil, snoozedUntilRange: false
        ))
    }

    func testSnoozeSilencesTheBackstopToo() {
        // Even with the pipeline down, an active snooze means the user asked for
        // quiet — the backstop must honor it (it previously ignored snoozes).
        XCTAssertFalse(LocalAlertGate.mayFire(
            now: now, lastServerPush: now.addingTimeInterval(-60 * 60),
            snoozedUntil: now.addingTimeInterval(600), snoozedUntilRange: false
        ))
        XCTAssertFalse(LocalAlertGate.mayFire(
            now: now, lastServerPush: nil,
            snoozedUntil: nil, snoozedUntilRange: true
        ))
    }

    func testExpiredSnoozeDoesNotSuppress() {
        XCTAssertTrue(LocalAlertGate.mayFire(
            now: now, lastServerPush: now.addingTimeInterval(-60 * 60),
            snoozedUntil: now.addingTimeInterval(-1), snoozedUntilRange: false
        ))
    }
}
