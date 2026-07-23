import Foundation

/// Owns the foreground auto-refresh timer.
///
/// ContentView previously created the timer inline and guarded the callback
/// with `[weak refreshTimer]` — but a capture list is evaluated when the
/// closure is created, before the new timer is assigned to the property, so
/// the guard always saw nil/the invalidated old timer and the refresh never
/// ran. Holding the timer in a dedicated object removes the self-referential
/// capture entirely: `start` invalidates any previous timer, and `stop` (or
/// deinit) invalidates the current one, so a fired callback is always from
/// the live timer.
@MainActor
final class RefreshScheduler {
    private var timer: Timer?
    private let interval: TimeInterval

    init(interval: TimeInterval) {
        self.interval = interval
    }

    var isRunning: Bool {
        timer?.isValid ?? false
    }

    func start(_ tick: @escaping @MainActor () -> Void) {
        stop()
        timer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { _ in
            Task { @MainActor in tick() }
        }
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }

    deinit {
        timer?.invalidate()
    }
}
