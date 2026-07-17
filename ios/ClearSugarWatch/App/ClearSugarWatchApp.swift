import SwiftUI

@main
struct ClearSugarWatchApp: App {
    // Initialize WatchConnectivity receiver at launch
    @WKApplicationDelegateAdaptor(WatchAppDelegate.self) var delegate

    var body: some Scene {
        WindowGroup {
            GlucoseView()
        }
    }
}

class WatchAppDelegate: NSObject, WKApplicationDelegate {
    func applicationDidFinishLaunching() {
        _ = WatchSessionReceiver.shared
    }
}
