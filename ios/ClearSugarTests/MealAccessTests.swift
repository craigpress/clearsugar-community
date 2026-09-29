import XCTest
@testable import ClearSugar

final class MealAccessTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    func testPermissionIsBoundToTheSignedInSubject() {
        let access = MealAccess(sub: "patient", expiresAt: now.addingTimeInterval(3600))
        XCTAssertTrue(access.allows(subject: "patient", now: now))
        XCTAssertFalse(access.allows(subject: "parent", now: now))
        XCTAssertFalse(access.allows(subject: nil, now: now))
    }

    func testExpiredOrEmptyPermissionDoesNotEnableEntry() {
        let expired = MealAccess(sub: "patient", expiresAt: now)
        XCTAssertFalse(expired.allows(subject: "patient", now: now))
        let empty = MealAccess(sub: "", expiresAt: now.addingTimeInterval(3600))
        XCTAssertFalse(empty.allows(subject: "", now: now))
    }

    func testPersistencePreservesIdentityAndExpiry() throws {
        let access = MealAccess(sub: "patient", expiresAt: now.addingTimeInterval(3600))
        let restored = try JSONDecoder().decode(MealAccess.self, from: JSONEncoder().encode(access))
        XCTAssertEqual(restored, access)
        XCTAssertFalse(restored.allows(subject: "parent", now: now))
        XCTAssertFalse(restored.allows(subject: "patient", now: now.addingTimeInterval(3600)))
    }
}
