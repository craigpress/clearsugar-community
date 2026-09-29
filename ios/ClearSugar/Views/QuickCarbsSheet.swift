import SwiftUI
import UIKit

struct QuickCarbsSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var outbox = MealOutbox.shared
    @State private var carbClass = CarbClass.rescue
    @State private var grams = "15"
    @State private var reason = MealReason.low
    @State private var eatenAt = Date()
    @State private var childId = AuthManager.shared.defaultMealChildId
    @State private var note = ""

    // Shared with MealSheet (Models/MealLog.swift) so both sheets send the same
    // raw values to POST /api/meals. Aliased rather than renamed to keep this
    // view's body untouched.
    private typealias CarbClass = MealCarbClass
    private typealias MealReason = MealLogReason

    private var gramValue: Int? {
        guard let value = Int(grams), (1...150).contains(value) else { return nil }
        return value
    }

    var body: some View {
        NavigationStack {
            Form {
                MealChildPicker(selection: $childId)
                Section {
                    Picker("Carb class", selection: $carbClass) {
                        ForEach(CarbClass.allCases) { value in
                            Text(value.title).tag(value)
                        }
                    }
                    .pickerStyle(.segmented)
                    .onChange(of: carbClass) { _, value in
                        reason = value == .rescue ? .low : .forgotBolus
                    }
                } footer: {
                    Text(carbClass == .rescue ? "Fast carbs for a low" : "Carbs not already recorded by the pump")
                }

                Section("Grams") {
                    CarbGramChips(grams: $grams)

                    TextField("Carb grams", text: $grams)
                        .keyboardType(.numberPad)
                        .textFieldStyle(.roundedBorder)
                        .accessibilityLabel("Carb grams")
                }

                Section {
                    Picker("Reason", selection: $reason) {
                        ForEach(MealReason.allCases) { value in
                            Text(value.title).tag(value)
                        }
                    }

                    MealTimePicker(selection: $eatenAt)

                    TextField("What was it? (optional)", text: $note)
                        .onChange(of: note) { _, value in
                            if value.count > 280 {
                                note = String(value.prefix(280))
                            }
                        }
                }

                if outbox.pendingCount > 0 || outbox.lastError != nil {
                    Section {
                        if outbox.pendingCount > 0 {
                            Label(
                                "\(outbox.pendingCount) carb log\(outbox.pendingCount == 1 ? "" : "s") waiting to send",
                                systemImage: "arrow.triangle.2.circlepath"
                            )
                        }
                        if outbox.failedCount > 0 {
                            Label(
                                "\(outbox.failedCount) carb log\(outbox.failedCount == 1 ? "" : "s") couldn't be sent",
                                systemImage: "exclamationmark.triangle.fill"
                            )
                            .foregroundStyle(.orange)
                        }
                        if outbox.isNotPatientError {
                            Label("Sign in as the patient to log carbs", systemImage: "person.crop.circle.badge.exclamationmark")
                                .foregroundStyle(.orange)
                        } else if let error = outbox.lastError {
                            Text(error)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .navigationTitle("Log Carbs")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { save() }
                        .fontWeight(.semibold)
                        .disabled(gramValue == nil || !MealTimePicker.isValid(eatenAt))
                }
            }
        }
    }

    private func save() {
        guard let gramValue else { return }
        let now = Date()
        guard eatenAt >= now.addingTimeInterval(-24 * 60 * 60), eatenAt <= now.addingTimeInterval(300) else { return }
        let validEatenAt = eatenAt
        let trimmedNote = note.trimmingCharacters(in: .whitespacesAndNewlines)
        let input = MealLogInput(
            grams: gramValue,
            carbClass: carbClass.rawValue,
            reason: reason.rawValue,
            eatenAt: validEatenAt,
            description: trimmedNote.isEmpty ? nil : trimmedNote,
            childId: childId
        )
        Task { await outbox.enqueue(input) }
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        dismiss()
    }
}

// MARK: - Gram Chips
//
// Shared with MealSheet's carb section. The rule-of-15 critique in the plan is
// why these are adjustable presets over a fixed default rather than one button.

struct CarbGramChips: View {
    @Binding var grams: String
    var options: [Int] = [15, 20, 30]

    var body: some View {
        HStack(spacing: 12) {
            ForEach(options, id: \.self) { value in
                Button {
                    grams = "\(value)"
                } label: {
                    Text("\(value) g")
                        .font(.headline)
                        .frame(maxWidth: .infinity, minHeight: 48)
                        .background(grams == "\(value)" ? Color.accentColor : Color.secondary.opacity(0.18))
                        .foregroundStyle(grams == "\(value)" ? .white : .primary)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(grams == "\(value)" ? [.isSelected] : [])
            }
        }
    }
}

#Preview {
    QuickCarbsSheet()
}
