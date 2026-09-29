import XCTest
@testable import ClearSugar

final class MealOutboxTests: XCTestCase {
    private actor Recorder {
        private var clientIds: [String] = []

        func append(_ clientId: String) {
            clientIds.append(clientId)
        }

        func values() -> [String] {
            clientIds
        }
    }

    private func fileURL() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
            .appendingPathComponent("meal-outbox.json")
    }

    private func input(clientId: String, grams: Int = 15) -> MealLogInput {
        MealLogInput(
            clientId: clientId,
            grams: grams,
            carbClass: "rescue",
            reason: "low",
            eatenAt: Date(timeIntervalSince1970: 1_700_000_000)
        )
    }

    func testPersistsPendingInputAcrossQueueInstances() async {
        let url = fileURL()
        let first = MealOutboxQueue(fileURL: url) { _ in }
        _ = await first.enqueue(input(clientId: "first"))

        let restored = MealOutboxQueue(fileURL: url) { _ in }
        let snapshot = await restored.currentSnapshot()

        XCTAssertEqual(snapshot.pendingCount, 1)
    }

    func testProcessesPendingMealsFIFO() async {
        let recorder = Recorder()
        let queue = MealOutboxQueue(fileURL: fileURL()) { input in
            await recorder.append(input.clientId)
        }
        _ = await queue.enqueue(input(clientId: "first"))
        _ = await queue.enqueue(input(clientId: "second"))

        let snapshot = await queue.process()
        let sent = await recorder.values()

        XCTAssertEqual(sent, ["first", "second"])
        XCTAssertEqual(snapshot.pendingCount, 0)
    }

    func testRetryableFailureKeepsItemAndSchedulesBackoff() async {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let queue = MealOutboxQueue(
            fileURL: fileURL(),
            sender: { _ in throw APIError.retryableRequest("temporary") },
            now: { now }
        )
        _ = await queue.enqueue(input(clientId: "retry"))

        let snapshot = await queue.process()

        XCTAssertEqual(snapshot.pendingCount, 1)
        XCTAssertEqual(snapshot.failedCount, 0)
        XCTAssertEqual(snapshot.nextAttemptAt, now.addingTimeInterval(5))
    }

    func testPermanentClientErrorMovesItemToFailed() async {
        let queue = MealOutboxQueue(fileURL: fileURL()) { _ in
            throw APIError.httpError(400)
        }
        _ = await queue.enqueue(input(clientId: "invalid"))

        let snapshot = await queue.process()

        XCTAssertEqual(snapshot.pendingCount, 0)
        XCTAssertEqual(snapshot.failedCount, 1)
        XCTAssertNotNil(snapshot.lastError)
    }

    func testNotPatientFailureIsDistinct() async {
        let queue = MealOutboxQueue(fileURL: fileURL()) { _ in
            throw APIError.notPatient
        }
        _ = await queue.enqueue(input(clientId: "wrong-user"))

        let snapshot = await queue.process()

        XCTAssertEqual(snapshot.pendingCount, 0)
        XCTAssertEqual(snapshot.failedCount, 1)
        XCTAssertTrue(snapshot.isNotPatientError)
        XCTAssertEqual(snapshot.lastError, "Sign in with an account assigned to this meal profile")
    }

    func testUnauthorizedFailureRemainsPending() async {
        let queue = MealOutboxQueue(fileURL: fileURL()) { _ in
            throw APIError.httpError(401)
        }
        _ = await queue.enqueue(input(clientId: "signed-out"))

        let snapshot = await queue.process()

        XCTAssertEqual(snapshot.pendingCount, 1)
        XCTAssertEqual(snapshot.failedCount, 0)
    }
}
