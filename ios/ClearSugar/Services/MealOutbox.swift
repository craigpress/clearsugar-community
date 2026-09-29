import Foundation
import CryptoKit
import Observation

struct MealOutboxSnapshot: Sendable {
    let pendingCount: Int
    let failedCount: Int
    let lastError: String?
    let isNotPatientError: Bool
    let nextAttemptAt: Date?
}

/// Everything the outbox can owe the server. All three are safe to retry: meals
/// and "eating now" dedupe on `clientId`, and a reply upserts onto its episode.
enum MealOutboxOperation: Codable, Sendable, Equatable {
    case logMeal(MealLogInput)
    case reply(MealReplyInput)
    case eating(EatingNowInput)

    private enum CodingKeys: String, CodingKey {
        case kind
        case logMeal
        case reply
        case eating
    }

    private enum Kind: String, Codable {
        case logMeal
        case reply
        case eating
    }

    /// The server-side idempotency key, used for logging and by the tests to
    /// identify an operation without matching on its whole payload.
    var clientId: String {
        switch self {
        case .logMeal(let input): return input.clientId
        case .reply(let input): return input.episodeId
        case .eating(let input): return input.clientId
        }
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(Kind.self, forKey: .kind) {
        case .logMeal:
            self = .logMeal(try container.decode(MealLogInput.self, forKey: .logMeal))
        case .reply:
            self = .reply(try container.decode(MealReplyInput.self, forKey: .reply))
        case .eating:
            self = .eating(try container.decode(EatingNowInput.self, forKey: .eating))
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .logMeal(let input):
            try container.encode(Kind.logMeal, forKey: .kind)
            try container.encode(input, forKey: .logMeal)
        case .reply(let input):
            try container.encode(Kind.reply, forKey: .kind)
            try container.encode(input, forKey: .reply)
        case .eating(let input):
            try container.encode(Kind.eating, forKey: .kind)
            try container.encode(input, forKey: .eating)
        }
    }
}

actor MealOutboxQueue {
    typealias Sender = @Sendable (MealOutboxOperation) async throws -> Void

    /// v1 held only `MealLogInput` items under an `input` key and carried no
    /// version field. v2 wraps every item in a `MealOutboxOperation`.
    static let schemaVersion = 2

    private struct QueuedOperation: Codable, Sendable {
        let operation: MealOutboxOperation
        var attempts: Int
        var nextAttemptAt: Date
    }

    private struct FailedOperation: Codable, Sendable {
        let operation: MealOutboxOperation
        let message: String
        let failedAt: Date
        let notPatient: Bool
    }

    private struct PersistedState: Codable, Sendable {
        var version: Int
        var pending: [QueuedOperation]
        var failed: [FailedOperation]
        var lastError: String?
        var lastErrorWasNotPatient: Bool

        init(
            version: Int = MealOutboxQueue.schemaVersion,
            pending: [QueuedOperation] = [],
            failed: [FailedOperation] = [],
            lastError: String? = nil,
            lastErrorWasNotPatient: Bool = false
        ) {
            self.version = version
            self.pending = pending
            self.failed = failed
            self.lastError = lastError
            self.lastErrorWasNotPatient = lastErrorWasNotPatient
        }
    }

    /// Reads just the version so an unversioned (v1) file is recognised without
    /// depending on a v2 decode failing in some particular way.
    private struct SchemaProbe: Decodable {
        let version: Int?
    }

    // MARK: v1 on-disk shape (Phase 1). Kept verbatim so the migration reads it.

    private struct LegacyQueuedMealV1: Decodable {
        let input: MealLogInput
        var attempts: Int
        var nextAttemptAt: Date
    }

    private struct LegacyFailedMealV1: Decodable {
        let input: MealLogInput
        let message: String
        let failedAt: Date
        let notPatient: Bool
    }

    private struct LegacyStateV1: Decodable {
        var pending: [LegacyQueuedMealV1]
        var failed: [LegacyFailedMealV1]
        var lastError: String?
        var lastErrorWasNotPatient: Bool?
    }

    private let fileURL: URL
    private let sender: Sender
    private let now: @Sendable () -> Date
    private var state = PersistedState()
    private var isLoaded = false
    private var isProcessing = false

    init(
        fileURL: URL,
        sender: @escaping Sender,
        now: @escaping @Sendable () -> Date = Date.init
    ) {
        self.fileURL = fileURL
        self.sender = sender
        self.now = now
    }

    func enqueue(_ input: MealLogInput) async -> MealOutboxSnapshot {
        await enqueue(MealOutboxOperation.logMeal(input))
    }

    func enqueue(_ operation: MealOutboxOperation) async -> MealOutboxSnapshot {
        loadIfNeeded()
        state.pending.append(QueuedOperation(operation: operation, attempts: 0, nextAttemptAt: now()))
        persist()
        return snapshot()
    }

    func process() async -> MealOutboxSnapshot {
        loadIfNeeded()
        guard !isProcessing else { return snapshot() }
        isProcessing = true
        defer { isProcessing = false }

        while let item = state.pending.first, item.nextAttemptAt <= now() {
            do {
                try await sender(item.operation)
                state.pending.removeFirst()
                if !state.lastErrorWasNotPatient {
                    state.lastError = nil
                }
                persist()
            } catch {
                let message = error.localizedDescription
                if Self.shouldDrop(error) {
                    let notPatient = (error as? APIError)?.statusCode == 403
                    state.pending.removeFirst()
                    state.failed.append(FailedOperation(
                        operation: item.operation,
                        message: message,
                        failedAt: now(),
                        notPatient: notPatient
                    ))
                    state.lastError = message
                    state.lastErrorWasNotPatient = notPatient
                    debugLog("[MealOutbox] Permanently failed \(item.operation.clientId): \(message)")
                    persist()
                    continue
                }

                var retry = item
                retry.attempts += 1
                retry.nextAttemptAt = now().addingTimeInterval(Self.backoff(for: retry.attempts))
                state.pending[0] = retry
                state.lastError = message
                state.lastErrorWasNotPatient = false
                persist()
                break
            }
        }

        return snapshot()
    }

    func currentSnapshot() -> MealOutboxSnapshot {
        loadIfNeeded()
        return snapshot()
    }

    /// Test seam: the persisted schema version currently on disk.
    func persistedSchemaVersion() -> Int? {
        guard let data = try? Data(contentsOf: fileURL) else { return nil }
        return (try? JSONDecoder().decode(SchemaProbe.self, from: data))?.version
    }

    private static func shouldDrop(_ error: Error) -> Bool {
        guard let code = (error as? APIError)?.statusCode else { return false }
        return (400...499).contains(code) && code != 401 && code != 408 && code != 429
    }

    private static func backoff(for attempts: Int) -> TimeInterval {
        min(pow(2.0, Double(max(0, attempts - 1))) * 5, 15 * 60)
    }

    private func snapshot() -> MealOutboxSnapshot {
        MealOutboxSnapshot(
            pendingCount: state.pending.count,
            failedCount: state.failed.count,
            lastError: state.lastError,
            isNotPatientError: state.lastErrorWasNotPatient,
            nextAttemptAt: state.pending.first?.nextAttemptAt
        )
    }

    private func loadIfNeeded() {
        guard !isLoaded else { return }
        isLoaded = true
        guard let data = try? Data(contentsOf: fileURL) else { return }

        let decoder = JSONDecoder()
        let version = (try? decoder.decode(SchemaProbe.self, from: data))?.version ?? 1

        if version >= Self.schemaVersion {
            do {
                state = try decoder.decode(PersistedState.self, from: data)
            } catch {
                debugLog("[MealOutbox] Couldn't read saved queue: \(error)")
            }
            return
        }

        do {
            state = Self.migrated(from: try decoder.decode(LegacyStateV1.self, from: data))
            persist()
            debugLog("[MealOutbox] Migrated queue from schema v\(version) to v\(Self.schemaVersion)")
        } catch {
            debugLog("[MealOutbox] Couldn't migrate saved queue: \(error)")
        }
    }

    private static func migrated(from legacy: LegacyStateV1) -> PersistedState {
        PersistedState(
            version: schemaVersion,
            pending: legacy.pending.map {
                QueuedOperation(
                    operation: .logMeal($0.input),
                    attempts: $0.attempts,
                    nextAttemptAt: $0.nextAttemptAt
                )
            },
            failed: legacy.failed.map {
                FailedOperation(
                    operation: .logMeal($0.input),
                    message: $0.message,
                    failedAt: $0.failedAt,
                    notPatient: $0.notPatient
                )
            },
            lastError: legacy.lastError,
            lastErrorWasNotPatient: legacy.lastErrorWasNotPatient ?? false
        )
    }

    private func persist() {
        do {
            try FileManager.default.createDirectory(
                at: fileURL.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            state.version = Self.schemaVersion
            let data = try JSONEncoder().encode(state)
            try data.write(to: fileURL, options: .atomic)
        } catch {
            debugLog("[MealOutbox] Couldn't save queue: \(error)")
        }
    }
}

@MainActor @Observable
final class MealOutbox {
    static let shared = MealOutbox()

    private(set) var pendingCount = 0
    private(set) var failedCount = 0
    private(set) var lastError: String?
    private(set) var isNotPatientError = false

    private var queues: [String: MealOutboxQueue] = [:]
    private var retryTask: Task<Void, Never>?
    private init() {}

    private func currentQueue() -> (String, MealOutboxQueue)? {
        guard AuthManager.shared.canLogMeals, let key = AuthManager.shared.mealAccountKey else { return nil }
        if let queue = queues[key] { return (key, queue) }
        let name = SHA256.hash(data: Data(key.utf8)).map { String(format: "%02x", $0) }.joined()
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let url = support.appendingPathComponent("ClearSugar").appendingPathComponent("meal-outbox-" + name + ".json")
        let queue = MealOutboxQueue(fileURL: url) { operation in
            try await MealRequestContext.$accountKey.withValue(key) {
                switch operation {
                case .logMeal(let input): _ = try await APIClient.shared.logMeal(input)
                case .reply(let input): _ = try await APIClient.shared.postMealReply(input)
                case .eating(let input): _ = try await APIClient.shared.postEatingNow(input)
                }
            }
        }
        queues[key] = queue
        return (key, queue)
    }
    func enqueue(_ input: MealLogInput) async { await enqueue(MealOutboxOperation.logMeal(input)) }
    func enqueue(_ operation: MealOutboxOperation) async {
        guard let (key, queue) = currentQueue() else { return }
        let snapshot = await queue.enqueue(operation)
        if AuthManager.shared.mealAccountKey == key { apply(snapshot) }
        await process()
    }
    func process() async {
        guard let (key, queue) = currentQueue() else {
            retryTask?.cancel(); pendingCount = 0; failedCount = 0; lastError = nil
            return
        }
        let snapshot = await queue.process()
        if AuthManager.shared.mealAccountKey == key { apply(snapshot) }
    }

    private func apply(_ snapshot: MealOutboxSnapshot) {
        pendingCount = snapshot.pendingCount
        failedCount = snapshot.failedCount
        lastError = snapshot.lastError
        isNotPatientError = snapshot.isNotPatientError
        scheduleRetry(at: snapshot.nextAttemptAt)
    }

    private func scheduleRetry(at date: Date?) {
        retryTask?.cancel()
        guard let date, pendingCount > 0 else {
            retryTask = nil
            return
        }

        let delay = max(0, date.timeIntervalSinceNow)
        retryTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard !Task.isCancelled else { return }
            await self?.process()
        }
    }
}
