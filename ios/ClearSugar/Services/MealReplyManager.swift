import Foundation
import Observation

/// Mirrors `AckManager`: the thin layer the notification-response switch calls.
/// Everything goes through the durable outbox rather than straight to
/// `URLSession`, because a reply tapped on the lock screen in a basement has to
/// survive the app being suspended two seconds later.
@MainActor
enum MealReplyManager {
    static func reply(_ input: MealReplyInput) async {
        await MealOutbox.shared.enqueue(.reply(input))
    }

    /// One-tap "I'm eating now" from the app, Siri or Shortcuts. The Live
    /// Activity button takes the App Group marker route instead — see
    /// `EatingNowLiveActivityIntent`.
    static func eatingNow(
        clientId: String = UUID().uuidString.lowercased(),
        at date: Date? = nil
    ) async {
        await MealOutbox.shared.enqueue(.eating(EatingNowInput(clientId: clientId, at: date)))
    }
}

/// Where a MEAL_PROMPT tap lands. The AppDelegate can't present a sheet, so it
/// parks the context here and `ContentView` picks it up.
@MainActor @Observable
final class MealNavigation {
    static let shared = MealNavigation()

    /// Non-nil when a prompt is waiting to be answered in the meal sheet.
    var pendingEpisode: MealPromptContext?

    private init() {}

    func present(_ context: MealPromptContext) {
        pendingEpisode = context
    }

    func clear() {
        pendingEpisode = nil
    }
}
