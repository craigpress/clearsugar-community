import XCTest
@testable import ClearSugar

/// Phase 1 shipped an unversioned outbox holding only `MealLogInput` items.
/// A carb entry queued offline on that build must still send after the app
/// updates — dropping it is dropping a treatment the forecast needs.
final class MealOutboxMigrationTests: XCTestCase {
    private actor Recorder {
        private var operations: [MealOutboxOperation] = []

        func append(_ operation: MealOutboxOperation) {
            operations.append(operation)
        }

        func values() -> [MealOutboxOperation] {
            operations
        }
    }

    private func fileURL() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
            .appendingPathComponent("meal-outbox.json")
    }

    /// Byte-for-byte the v1 shape: `input` (not `operation`), no `version`.
    private func writeLegacyV1(to url: URL, clientId: String) throws {
        let legacy = """
        {
          "pending": [
            {
              "input": {
                "clientId": "\(clientId)",
                "grams": 20,
                "carbClass": "rescue",
                "reason": "low",
                "eatenAt": "2026-09-04T12:00:00Z"
              },
              "attempts": 1,
              "nextAttemptAt": 0
            }
          ],
          "failed": [
            {
              "input": {
                "clientId": "already-dead",
                "grams": 15,
                "carbClass": "snack",
                "reason": "forgot_bolus"
              },
              "message": "Server error (HTTP 400)",
              "failedAt": 0,
              "notPatient": false
            }
          ],
          "lastError": "Server error (HTTP 400)",
          "lastErrorWasNotPatient": false
        }
        """
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try Data(legacy.utf8).write(to: url)
    }

    func testMigratesV1PendingLogMealItems() async throws {
        let url = fileURL()
        try writeLegacyV1(to: url, clientId: "queued-offline")

        let queue = MealOutboxQueue(fileURL: url) { _ in }
        let snapshot = await queue.currentSnapshot()

        XCTAssertEqual(snapshot.pendingCount, 1)
        XCTAssertEqual(snapshot.failedCount, 1)
        XCTAssertEqual(snapshot.lastError, "Server error (HTTP 400)")
    }

    func testMigratedItemStillSendsAsALogMeal() async throws {
        let url = fileURL()
        try writeLegacyV1(to: url, clientId: "queued-offline")

        let recorder = Recorder()
        let queue = MealOutboxQueue(fileURL: url) { operation in
            await recorder.append(operation)
        }
        let snapshot = await queue.process()
        let sent = await recorder.values()

        XCTAssertEqual(snapshot.pendingCount, 0)
        XCTAssertEqual(sent.count, 1)
        guard let first = sent.first, case .logMeal(let input) = first else {
            return XCTFail("Migrated item should still be a logMeal operation")
        }
        XCTAssertEqual(input.clientId, "queued-offline")
        XCTAssertEqual(input.grams, 20)
        XCTAssertEqual(input.carbClass, "rescue")
    }

    func testMigrationRewritesTheFileAtSchemaV2() async throws {
        let url = fileURL()
        try writeLegacyV1(to: url, clientId: "queued-offline")

        let queue = MealOutboxQueue(fileURL: url) { _ in }
        _ = await queue.currentSnapshot()

        let version = await queue.persistedSchemaVersion()
        XCTAssertEqual(version, MealOutboxQueue.schemaVersion)
        XCTAssertEqual(MealOutboxQueue.schemaVersion, 2)
    }

    func testV2FileIsReadBackWithoutMigration() async throws {
        let url = fileURL()
        let first = MealOutboxQueue(fileURL: url) { _ in }
        _ = await first.enqueue(.reply(.withBolus(episodeId: "ep-1")))
        _ = await first.enqueue(.eating(EatingNowInput(clientId: "eat-1", at: Date())))

        let restored = MealOutboxQueue(fileURL: url) { _ in }
        let snapshot = await restored.currentSnapshot()

        let version = await restored.persistedSchemaVersion()
        XCTAssertEqual(snapshot.pendingCount, 2)
        XCTAssertEqual(version, 2)
    }

    func testReplyOperationsSurviveARoundTripInOrder() async throws {
        let url = fileURL()
        let seed = MealOutboxQueue(fileURL: url) { _ in }
        _ = await seed.enqueue(.reply(.dismiss(episodeId: "ep-a")))
        _ = await seed.enqueue(MealOutboxOperation.logMeal(
            MealLogInput(clientId: "meal-b", grams: 30, carbClass: "snack", reason: "other")
        ))

        let recorder = Recorder()
        // Pinned clock so a persisted nextAttemptAt is unambiguously in the past.
        let restored = MealOutboxQueue(
            fileURL: url,
            sender: { operation in await recorder.append(operation) },
            now: { Date(timeIntervalSince1970: 2_000_000_000) }
        )
        _ = await restored.process()
        let sent = await recorder.values()

        XCTAssertEqual(sent.map(\.clientId), ["ep-a", "meal-b"])
    }

    func testUnknownEpisodeIsDroppedNotRetried() async {
        let queue = MealOutboxQueue(fileURL: fileURL()) { _ in
            throw APIError.httpError(404)
        }
        _ = await queue.enqueue(.reply(.withBolus(episodeId: "expired")))

        let snapshot = await queue.process()

        XCTAssertEqual(snapshot.pendingCount, 0)
        XCTAssertEqual(snapshot.failedCount, 1)
    }
}
