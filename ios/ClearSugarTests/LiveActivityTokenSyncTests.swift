import XCTest
@testable import ClearSugar

/// Regression cover for the build-11 fix.
///
/// A Live Activity created by push-to-start while the app was NOT running never
/// had its update token registered: `pushTokenUpdates` is only observed by a live
/// app process. The server therefore kept pushing the previous (dead) token —
/// APNs answers 200 to those forever — so the new card froze on stale glucose and
/// eventually died, and the server could not tell. A card can fail this way on
/// 2026-07-22 and only came back via a delete+reinstall.
final class LiveActivityTokenSyncTests: XCTestCase {
    private typealias Act = (id: String, contentTimestamp: TimeInterval, pushTokenHex: String?)

    func testRegistersTokenOfAPushStartedActivityNeverSeenBefore() {
        // The core bug: app launches, finds a card it never observed, has never
        // registered anything for it.
        let acts: [Act] = [("push-started", 500, "aabb")]
        XCTAssertEqual(
            LiveActivityTokenSync.tokenToRegister(activities: acts, lastRegistered: nil),
            "aabb"
        )
    }

    func testRegistersTheNewestActivitysToken() {
        // Matches LiveActivityCollapse: the newest card is the one that survives,
        // so it is the one whose token the server must hold.
        let acts: [Act] = [
            ("old", 100, "old0"),
            ("new", 300, "new0"),
            ("mid", 200, "mid0"),
        ]
        XCTAssertEqual(
            LiveActivityTokenSync.tokenToRegister(activities: acts, lastRegistered: nil),
            "new0"
        )
    }

    func testSkipsWhenNewestTokenIsAlreadyRegistered() {
        // Foreground re-sync runs on every activation; without this it would POST
        // the same token every time the app comes forward.
        let acts: [Act] = [("a", 100, "same")]
        XCTAssertNil(
            LiveActivityTokenSync.tokenToRegister(activities: acts, lastRegistered: "same")
        )
    }

    func testRegistersWhenTheTokenChangedSinceLastRegistration() {
        let acts: [Act] = [("a", 100, "fresh")]
        XCTAssertEqual(
            LiveActivityTokenSync.tokenToRegister(activities: acts, lastRegistered: "stale"),
            "fresh"
        )
    }

    func testIgnoresActivitiesWithNoTokenYet() {
        // A token arrives asynchronously after an activity appears; a nil token is
        // normal mid-flight, not a reason to register something older.
        let acts: [Act] = [("newest-no-token", 900, nil), ("older", 100, "older0")]
        XCTAssertEqual(
            LiveActivityTokenSync.tokenToRegister(activities: acts, lastRegistered: nil),
            "older0",
            "fall back to the newest activity that actually has a token"
        )
    }

    func testNoActivitiesRegistersNothing() {
        XCTAssertNil(LiveActivityTokenSync.tokenToRegister(activities: [], lastRegistered: nil))
        XCTAssertNil(LiveActivityTokenSync.tokenToRegister(activities: [], lastRegistered: "prev"))
    }

    func testAllTokensNilRegistersNothing() {
        let acts: [Act] = [("a", 100, nil), ("b", 200, nil)]
        XCTAssertNil(LiveActivityTokenSync.tokenToRegister(activities: acts, lastRegistered: nil))
    }
}
