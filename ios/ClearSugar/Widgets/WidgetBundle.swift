import SwiftUI
import WidgetKit

@main
struct ClearSugarWidgetBundle: WidgetBundle {
    var body: some Widget {
        GlucoseLiveActivity()
        GlucoseSmallWidget()
        GlucoseMediumWidget()
        GlucoseAccessoryCircularWidget()
        GlucoseAccessoryRectangularWidget()
        GlucoseAccessoryInlineWidget()
    }
}
