import XCTest
@testable import ClearSugar

final class InstallIdentityTests: XCTestCase {
    private let suite = "InstallIdentityTests.suite"

    override func setUp() {
        UserDefaults().removePersistentDomain(forName: suite)
    }

    func testGeneratesStableIdAcrossCalls() {
        let defaults = UserDefaults(suiteName: suite)!
        let a = InstallIdentity.current(defaults: defaults)
        let b = InstallIdentity.current(defaults: defaults)
        XCTAssertEqual(a, b, "installId must be stable across calls")
        XCTAssertFalse(a.isEmpty)
        XCTAssertEqual(UUID(uuidString: a)?.uuidString.lowercased(), a.lowercased(), "should be a UUID")
    }

    func testPersistsAcrossFreshDefaults() {
        let d1 = UserDefaults(suiteName: suite)!
        let first = InstallIdentity.current(defaults: d1)
        let d2 = UserDefaults(suiteName: suite)!   // simulates a new process reading the same store
        XCTAssertEqual(InstallIdentity.current(defaults: d2), first)
    }
}
