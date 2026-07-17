import Foundation
import Network

/// Persists glucose readings for offline access and provides network monitoring
@MainActor
final class GlucoseStore: ObservableObject {
    static let shared = GlucoseStore()

    @Published var cachedReading: GlucoseReading?
    @Published var isOnline = true

    private let defaults: UserDefaults
    private let monitor = NWPathMonitor()
    private let monitorQueue = DispatchQueue(label: "clearsugar.network-monitor")

    private init() {
        self.defaults = AppConfig.sharedDefaults
        loadCachedReading()
        startNetworkMonitor()
    }

    // MARK: - Persistence

    func save(_ reading: GlucoseReading) {
        cachedReading = reading

        defaults.set(reading.sgv, forKey: "cached_sgv")
        defaults.set(reading.direction, forKey: "cached_direction")
        defaults.set(reading.date, forKey: "cached_date")
        defaults.set(reading.delta ?? 0, forKey: "cached_delta")
        defaults.set(reading.pumpStaleMinutes ?? 0, forKey: "cached_pumpStaleMinutes")
        defaults.set(reading.pumpIsStale ?? false, forKey: "cached_pumpIsStale")
        defaults.set(Date().timeIntervalSince1970, forKey: "cached_fetchTime")
    }

    private func loadCachedReading() {
        guard defaults.object(forKey: "cached_sgv") != nil else { return }

        let sgv = defaults.integer(forKey: "cached_sgv")
        guard sgv > 0 else { return }

        cachedReading = GlucoseReading(fromWatchPayload: [
            "sgv": sgv,
            "direction": defaults.string(forKey: "cached_direction") ?? "NOT COMPUTABLE",
            "date": defaults.double(forKey: "cached_date"),
            "delta": defaults.double(forKey: "cached_delta")
        ])
    }

    var lastFetchTime: Date? {
        let ts = defaults.double(forKey: "cached_fetchTime")
        return ts > 0 ? Date(timeIntervalSince1970: ts) : nil
    }

    var minutesSinceLastFetch: Int {
        guard let lastFetch = lastFetchTime else { return 999 }
        return Int(Date().timeIntervalSince(lastFetch) / 60)
    }

    // MARK: - Widget Data

    /// Save sparkline history for WidgetKit widgets to read.
    /// Call this from ContentView after fetching glucose history.
    func saveSparklineForWidgets(_ values: [Int]) {
        if let data = try? JSONEncoder().encode(values) {
            defaults.set(data, forKey: "cached_sparkline")
        }
    }

    /// Save prediction values for WidgetKit widgets to read.
    func savePredictionForWidgets(_ values: [Int]) {
        if let data = try? JSONEncoder().encode(values) {
            defaults.set(data, forKey: "cached_prediction")
        }
    }

    /// Save IOB/COB strings for WidgetKit widgets to read.
    /// Call this from ContentView after fetching IOB/COB values.
    func saveIOBCOBForWidgets(iob: String?, cob: String?) {
        defaults.set(iob, forKey: "cached_iob")
        defaults.set(cob, forKey: "cached_cob")
    }

    // MARK: - Network Monitoring

    private func startNetworkMonitor() {
        monitor.pathUpdateHandler = { [weak self] path in
            Task { @MainActor [weak self] in
                self?.isOnline = path.status == .satisfied
            }
        }
        monitor.start(queue: monitorQueue)
    }

    deinit {
        monitor.cancel()
    }
}
