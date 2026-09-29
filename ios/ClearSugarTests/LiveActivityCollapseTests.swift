import XCTest
@testable import ClearSugar

final class LiveActivityCollapseTests: XCTestCase {
    func testKeepsNewestEndsRest() {
        let acts: [(id: String, contentTimestamp: TimeInterval)] = [
            ("old", 100),
            ("new", 300),
            ("mid", 200),
        ]
        let toEnd = LiveActivityCollapse.idsToEnd(acts)
        XCTAssertEqual(Set(toEnd), ["old", "mid"], "keep newest 'new', end the other two")
    }

    func testSingleActivityEndsNothing() {
        XCTAssertTrue(LiveActivityCollapse.idsToEnd([("only", 100)]).isEmpty)
    }

    func testEmptyEndsNothing() {
        XCTAssertTrue(LiveActivityCollapse.idsToEnd([]).isEmpty)
    }
}
