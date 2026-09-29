import Foundation

/// Pure selection: given (id, content-timestamp) for every live activity, return
/// the ids to end so exactly the newest one survives. Keeps the anti-stack rule
/// testable without ActivityKit.
enum LiveActivityCollapse {
    static func idsToEnd(_ activities: [(id: String, contentTimestamp: TimeInterval)]) -> [String] {
        guard activities.count > 1 else { return [] }
        guard let newest = activities.max(by: { $0.contentTimestamp < $1.contentTimestamp }) else { return [] }
        return activities.filter { $0.id != newest.id }.map { $0.id }
    }
}
