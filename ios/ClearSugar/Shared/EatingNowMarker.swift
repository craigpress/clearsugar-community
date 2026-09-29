import Foundation

// Shared between the app and the widget extension. Foundation only — no
// APIClient, no MealOutbox, no UIKit. The widget extension process cannot reach
// the app's Keychain JWT in any reliable way, so the Live Activity's "Eating"
// button does not talk to the server at all: it drops a marker in the App Group
// container and the app posts it on its next launch or foreground.

/// One "eating now" tap that has not reached the server yet. `clientId` is the
/// server's idempotency key for POST /api/meals/eating, so a marker flushed
/// twice (app relaunched mid-flush) upserts the same episode instead of opening
/// a second one.
struct EatingNowMarker: Codable, Sendable, Equatable {
    let clientId: String
    let at: Date

    init(clientId: String = UUID().uuidString.lowercased(), at: Date = Date()) {
        self.clientId = clientId
        self.at = at
    }
}

/// Append-only handoff file in the shared App Group container.
///
/// Deliberately dumb: a versioned envelope, an atomic whole-file write, and a
/// drain that removes the file. Two processes can touch it, so there is no
/// read-modify-write that must survive interleaving — a lost append costs one
/// eat timestamp, while a corrupt file would cost every pending one.
struct EatingNowMarkerStore: Sendable {
    /// Must match `com.apple.security.application-groups` in both
    /// ClearSugar.entitlements and Widgets.entitlements.
    static let appGroupIdentifier = AppConfig.appGroup

    static let fileName = "eating-now-markers.json"

    /// Schema version of the envelope on disk.
    static let schemaVersion = 1

    /// The server pairs an eat timestamp with a bolus inside a 2-hour window, so
    /// a backlog deeper than this is stale by definition. Caps the file size in
    /// the pathological "app never opened for a week" case.
    static let maxMarkers = 32

    static let shared = EatingNowMarkerStore()

    let fileURL: URL?

    init() {
        self.fileURL = FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: Self.appGroupIdentifier)?
            .appendingPathComponent(Self.fileName)
    }

    /// Test seam: point the store at a temporary file instead of the container.
    init(fileURL: URL?) {
        self.fileURL = fileURL
    }

    private struct Envelope: Codable {
        var version: Int
        var markers: [EatingNowMarker]
    }

    private static func encoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .secondsSince1970
        return encoder
    }

    private static func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .secondsSince1970
        return decoder
    }

    /// Adds a marker, keeping the newest `maxMarkers`.
    func append(_ marker: EatingNowMarker) {
        guard let fileURL else { return }
        var markers = peek()
        // Same clientId twice (a double tap replayed by ActivityKit) is one tap.
        guard !markers.contains(where: { $0.clientId == marker.clientId }) else { return }
        markers.append(marker)
        if markers.count > Self.maxMarkers {
            markers.removeFirst(markers.count - Self.maxMarkers)
        }
        write(markers, to: fileURL)
    }

    /// Reads without consuming.
    func peek() -> [EatingNowMarker] {
        guard let fileURL, let data = try? Data(contentsOf: fileURL) else { return [] }
        guard let envelope = try? Self.decoder().decode(Envelope.self, from: data) else {
            // Unreadable or a future schema: leave the file alone rather than
            // silently discarding somebody's eat timestamps.
            return []
        }
        return envelope.markers
    }

    /// Reads and clears. The caller owns the returned markers from here on, so
    /// it must enqueue them durably before doing anything else.
    func drain() -> [EatingNowMarker] {
        let markers = peek()
        guard let fileURL, !markers.isEmpty else { return markers }
        try? FileManager.default.removeItem(at: fileURL)
        return markers
    }

    private func write(_ markers: [EatingNowMarker], to fileURL: URL) {
        do {
            try FileManager.default.createDirectory(
                at: fileURL.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            let data = try Self.encoder().encode(
                Envelope(version: Self.schemaVersion, markers: markers)
            )
            try data.write(to: fileURL, options: .atomic)
        } catch {
            debugLog("[EatingNowMarker] Couldn't save marker: \(error)")
        }
    }
}
