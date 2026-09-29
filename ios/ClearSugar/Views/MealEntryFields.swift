import SwiftUI
import UIKit

struct MealChildPicker: View {
    @Binding var selection: String

    var body: some View {
        Section {
            Picker("Meal for", selection: $selection) {
                ForEach(AuthManager.shared.mealChildren) { child in
                    Text(child.name + (child.isTest ? " (test)" : "")).tag(child.id)
                }
            }
        } footer: {
            Text(selection == "patient"
                 ? "Confirmed uncovered carbs are saved to the primary Nightscout profile."
                 : "Meals and photos stay in this profile’s separate local journal.")
        }
    }
}

struct MealTimePicker: View {
    @Binding var selection: Date

    static func isValid(_ date: Date, now: Date = Date()) -> Bool {
        date >= now.addingTimeInterval(-24 * 60 * 60) && date <= now.addingTimeInterval(300)
    }

    var body: some View {
        VStack(alignment: .leading) {
            Text("When eaten")
            MinuteDatePicker(selection: $selection).frame(height: 160)
            if !Self.isValid(selection) {
                Text("Choose a time within the last 24 hours.").font(.caption).foregroundStyle(.orange)
            }
        }
    }
}

private struct MinuteDatePicker: UIViewRepresentable {
    @Binding var selection: Date

    func makeUIView(context: Context) -> UIDatePicker {
        let picker = UIDatePicker()
        picker.datePickerMode = .dateAndTime
        picker.preferredDatePickerStyle = .wheels
        picker.minuteInterval = 1
        picker.addTarget(context.coordinator, action: #selector(Coordinator.changed(_:)), for: .valueChanged)
        return picker
    }

    func updateUIView(_ picker: UIDatePicker, context: Context) {
        context.coordinator.selection = $selection
        picker.minuteInterval = 1
        if picker.date != selection { picker.setDate(selection, animated: false) }
    }

    func makeCoordinator() -> Coordinator { Coordinator(selection: $selection) }

    final class Coordinator: NSObject {
        var selection: Binding<Date>
        init(selection: Binding<Date>) { self.selection = selection }
        @objc func changed(_ picker: UIDatePicker) { selection.wrappedValue = picker.date }
    }
}
