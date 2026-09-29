import PhotosUI
import SwiftUI
import UIKit

/// What the meal sheet is answering.
enum MealSheetRoute: Identifiable, Equatable {
    /// Opened from a MEAL_PROMPT push (banner tap, "Add photo" action, or the
    /// parked context an AppDelegate handler left behind).
    case prompt(MealPromptContext)
    /// Opened from the main screen's "Add meal photo" button — no episode, so a
    /// confirmed estimate becomes an uncovered-carb log instead of a reply.
    case uncovered

    var id: String {
        switch self {
        case .prompt(let context): return "prompt-\(context.episodeId)"
        case .uncovered: return "uncovered"
        }
    }

    var context: MealPromptContext? {
        if case .prompt(let context) = self { return context }
        return nil
    }
}

struct MealSheet: View {
    let route: MealSheetRoute

    @Environment(\.dismiss) private var dismiss
    @State private var outbox = MealOutbox.shared

    // Answers
    @State private var timing: MealEatTiming?
    @State private var riseAnswer: MealRiseAnswer?
    @State private var note = ""
    @State private var grams = ""
    @State private var carbClass = MealCarbClass.meal
    @State private var reason = MealLogReason.forgotBolus
    @State private var eatenAt = Date()
    @State private var childId = AuthManager.shared.defaultMealChildId
    @State private var accountKey = AuthManager.shared.mealAccountKey

    // Photo + estimate
    @State private var photoPreview: UIImage?
    @State private var photoId: String?
    @State private var estimate: NutritionEstimate?
    @State private var phase = PhotoPhase.idle
    @State private var pickerSource: MealCameraSource?
    @State private var libraryItem: PhotosPickerItem?
    @State private var isSaving = false
    @State private var followUp = ""

    private enum PhotoPhase: Equatable {
        case idle
        case preparing
        case uploading
        case estimating
        case failed(String)

        var isBusy: Bool {
            switch self {
            case .preparing, .uploading, .estimating: return true
            case .idle, .failed: return false
            }
        }

        var label: String? {
            switch self {
            case .preparing: return "Preparing the photo\u{2026}"
            case .uploading: return "Uploading\u{2026}"
            case .estimating: return "Reading the meal\u{2026}"
            case .idle, .failed: return nil
            }
        }
    }

    var body: some View {
        NavigationStack {
            Form {
                if route.context == nil {
                    MealChildPicker(selection: $childId).disabled(phase.isBusy)
                }
                if let context = route.context {
                    promptSection(context)
                    if context.isGlucoseRise {
                        riseSection
                    } else {
                        timingSection
                    }
                }

                photoSection

                if let estimate {
                    estimateSection(estimate)
                }

                if writesCarbLog {
                    carbSection
                }

                noteSection
                outboxSection
            }
            .navigationTitle(route.context == nil ? "Add Meal" : "Meal")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { cancel() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Confirm") { confirm() }
                        .fontWeight(.semibold)
                        .disabled(!canConfirm)
                }
            }
            .sheet(item: $pickerSource) { source in
                MealCameraPicker(sourceType: source.uiKitSource) { image in
                    pickerSource = nil
                    if let image {
                        handlePicked(image)
                    }
                }
                .ignoresSafeArea()
            }
            .onChange(of: childId) { _, _ in
                photoId = nil
                photoPreview = nil
                estimate = nil
                followUp = ""
                grams = ""
                phase = .idle
            }
            .onChange(of: libraryItem) { _, item in
                guard let item else { return }
                Task { await loadLibraryItem(item) }
            }
        }
    }

    // MARK: - Prompt header

    @ViewBuilder
    private func promptSection(_ context: MealPromptContext) -> some View {
        Section {
            VStack(alignment: .leading, spacing: 4) {
                Text(context.headline)
                    .font(.system(.headline, design: .rounded))
                Text(context.question)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("\(context.headline). \(context.question)")
        }
    }

    // MARK: - Timing chips (pump-bolus prompt)

    private var timingSection: some View {
        Section {
            chipGrid(MealEatTiming.allCases) { value in
                timing = (timing == value) ? nil : value
            } title: { $0.title } isSelected: { timing == $0 }
        } header: {
            Text("When did you eat?")
        }
    }

    // MARK: - Rise chips (glucose-rise prompt)

    private var riseSection: some View {
        Section {
            chipGrid(MealRiseAnswer.allCases) { value in
                riseAnswer = (riseAnswer == value) ? nil : value
            } title: { $0.title } isSelected: { riseAnswer == $0 }
        } header: {
            Text("Did you eat?")
        } footer: {
            if riseAnswer == .noBolus {
                Text("Uncovered carbs are logged to Nightscout so COB and the forecast see them.")
            }
        }
    }

    /// Wrapping chip row. `LazyVGrid` with adaptive columns keeps six chips
    /// legible at accessibility text sizes, which a fixed HStack does not.
    @ViewBuilder
    private func chipGrid<T: Identifiable>(
        _ values: [T],
        onTap: @escaping (T) -> Void,
        title: @escaping (T) -> String,
        isSelected: @escaping (T) -> Bool
    ) -> some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 108), spacing: 8)], spacing: 8) {
            ForEach(values) { value in
                Button {
                    onTap(value)
                } label: {
                    Text(title(value))
                        .font(.system(.subheadline, design: .rounded))
                        .fontWeight(.medium)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .background(isSelected(value) ? Color.accentColor : Color.secondary.opacity(0.18))
                        .foregroundStyle(isSelected(value) ? .white : .primary)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(isSelected(value) ? [.isSelected] : [])
            }
        }
        .padding(.vertical, 4)
    }

    // MARK: - Photo

    private var photoSection: some View {
        Section {
            if let photoPreview {
                Image(uiImage: photoPreview)
                    .resizable()
                    .scaledToFit()
                    .frame(maxHeight: 200)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                    .accessibilityLabel("Selected meal photo")
            }

            Button {
                pickerSource = UIImagePickerController.isSourceTypeAvailable(.camera)
                    ? MealCameraSource.camera
                    : MealCameraSource.library
            } label: {
                Label(
                    UIImagePickerController.isSourceTypeAvailable(.camera) ? "Take photo" : "Choose photo",
                    systemImage: "camera.fill"
                )
            }
            .disabled(phase.isBusy)

            // PhotosPicker cannot capture, so it is the fallback rather than the
            // primary path — useful when the meal was photographed earlier.
            PhotosPicker(selection: $libraryItem, matching: .images, photoLibrary: .shared()) {
                Label("Choose from library", systemImage: "photo.on.rectangle")
            }
            .disabled(phase.isBusy)

            if let label = phase.label {
                HStack(spacing: 8) {
                    ProgressView()
                        .controlSize(.small)
                    Text(label)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }

            if case .failed(let message) = phase {
                VStack(alignment: .leading, spacing: 8) {
                    Label(message, systemImage: "exclamationmark.triangle.fill")
                        .font(.subheadline)
                        .foregroundStyle(.orange)
                    if photoPreview != nil {
                        Button("Try again") { retry() }
                            .font(.subheadline.weight(.semibold))
                    }
                }
            }
        } header: {
            Text("Photo")
        } footer: {
            Text("Photos are downscaled on the phone before upload, which also strips location data.")
        }
    }

    // MARK: - Estimate

    @ViewBuilder
    private func estimateSection(_ estimate: NutritionEstimate) -> some View {
        Section {
            VStack(alignment: .leading, spacing: 8) {
                Text(estimate.carbRangeText)
                    .font(.system(.title3, design: .rounded).weight(.semibold))
                    .accessibilityLabel("Estimated carbs \(estimate.carbRangeText)")

                VStack(alignment: .leading, spacing: 4) {
                    ProgressView(value: estimate.confidence)
                        .tint(confidenceColor(estimate.confidence))
                    Text("Confidence \(Int((estimate.confidence * 100).rounded()))%")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Model confidence \(Int((estimate.confidence * 100).rounded())) percent")
            }

            if let items = estimate.items, !items.isEmpty {
                ForEach(items.indices, id: \.self) { index in
                    itemRow(items[index])
                }
            }

            if let notes = estimate.notes, !notes.isEmpty {
                Text(notes).font(.subheadline)
            }
            TextField("Did you account for the BBQ sauce on the ribs?", text: $followUp, axis: .vertical)
                .lineLimit(2...4)
                .onChange(of: followUp) { _, value in
                    if value.count > 1000 { followUp = String(value.prefix(1000)) }
                }
            Button("Ask and revise estimate") { Task { await reviseEstimate() } }
                .disabled(phase.isBusy || followUp.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

            if let macros = macroSummary(estimate) {
                Text(macros)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        } header: {
            Text("Estimate")
        } footer: {
            Text("An estimate, not a measurement \u{2014} check it before dosing.")
        }
    }

    @ViewBuilder
    private func itemRow(_ item: NutritionEstimate.Item) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(item.name)
                    .font(.subheadline)
                if let portion = item.portion {
                    Text(portion)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
            if let carbs = item.carbs {
                Text("\(Int(carbs.rounded())) g")
                    .font(.subheadline.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func confidenceColor(_ value: Double) -> Color {
        switch value {
        case ..<0.4: return .orange
        case 0.4..<0.7: return .yellow
        default: return .green
        }
    }

    private func macroSummary(_ estimate: NutritionEstimate) -> String? {
        var parts: [String] = []
        if let protein = estimate.protein { parts.append("\(Int(protein.rounded())) g protein") }
        if let fat = estimate.fat { parts.append("\(Int(fat.rounded())) g fat") }
        if let fiber = estimate.fiber { parts.append("\(Int(fiber.rounded())) g fiber") }
        if let giClass = estimate.giClass { parts.append("\(giClass) GI") }
        return parts.isEmpty ? nil : parts.joined(separator: " \u{00B7} ")
    }

    // MARK: - Carbs (only when this sheet will actually write a carb log)
    //
    // A reply NEVER writes carbs — that is the guard against double-counted COB
    // (plan risk #1). So the grams field appears only for the uncovered paths:
    // the "Add meal photo" entry point, and a rise prompt answered "no bolus".

    private var carbSection: some View {
        Section("Carbs") {
            Picker("Carb class", selection: $carbClass) {
                ForEach(MealCarbClass.allCases) { value in
                    Text(value.title).tag(value)
                }
            }
            .pickerStyle(.segmented)
            .onChange(of: carbClass) { _, value in
                reason = value == .rescue ? .low : .forgotBolus
            }

            CarbGramChips(grams: $grams)

            TextField("Carb grams", text: $grams)
                .keyboardType(.numberPad)
                .textFieldStyle(.roundedBorder)
                .accessibilityLabel("Carb grams")

            Picker("Reason", selection: $reason) {
                ForEach(MealLogReason.allCases) { value in
                    Text(value.title).tag(value)
                }
            }

            MealTimePicker(selection: $eatenAt)
        }
    }

    // MARK: - Note

    private var noteSection: some View {
        Section {
            // The keyboard's mic key supplies dictation, so there is no Speech
            // framework and no microphone permission string (decision 6).
            TextField("What was it? (optional)", text: $note, axis: .vertical)
                .lineLimit(1...4)
                .onChange(of: note) { _, value in
                    if value.count > MealReplyInput.maxTextLength {
                        note = String(value.prefix(MealReplyInput.maxTextLength))
                    }
                }
            Button(estimate == nil ? "Estimate from description" : "Update estimate from description") {
                Task { await reviseEstimate() }
            }
            .disabled(phase.isBusy || trimmedNote.isEmpty)
        } footer: {
            Text("Tap the mic on the keyboard to dictate.")
        }
    }

    // MARK: - Outbox state

    @ViewBuilder
    private var outboxSection: some View {
        if outbox.pendingCount > 0 || outbox.lastError != nil {
            Section {
                if outbox.pendingCount > 0 {
                    Label(
                        "\(outbox.pendingCount) update\(outbox.pendingCount == 1 ? "" : "s") waiting to send",
                        systemImage: "arrow.triangle.2.circlepath"
                    )
                }
                if outbox.isNotPatientError {
                    Label("Sign in with an assigned meal account", systemImage: "person.crop.circle.badge.exclamationmark")
                        .foregroundStyle(.orange)
                } else if let error = outbox.lastError {
                    Text(error)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    // MARK: - Derived state

    private var trimmedNote: String {
        note.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var replyText: String? {
        trimmedNote.isEmpty ? nil : String(trimmedNote.prefix(MealReplyInput.maxTextLength))
    }

    private var gramValue: Int? {
        guard let value = Int(grams), (1...150).contains(value) else { return nil }
        return value
    }

    private var writesCarbLog: Bool {
        route.context == nil || riseAnswer == .noBolus
    }

    private var canConfirm: Bool {
        guard accountKey != nil, accountKey == AuthManager.shared.mealAccountKey else { return false }
        if isSaving || phase.isBusy || !followUp.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return false }
        if writesCarbLog && !MealTimePicker.isValid(eatenAt) { return false }
        guard let context = route.context else { return gramValue != nil }

        if context.isGlucoseRise {
            guard let riseAnswer else { return false }
            // "Yes, no bolus" is the one answer that also writes carbs, so it
            // needs a gram value before Confirm means anything.
            return riseAnswer == .noBolus ? gramValue != nil : true
        }
        return timing != nil || photoId != nil || !trimmedNote.isEmpty
    }

    // MARK: - Photo handling

    @MainActor
    private func handlePicked(_ image: UIImage) {
        photoPreview = image
        estimate = nil
        photoId = nil
        phase = .preparing
        Task { await uploadAndEstimate(image) }
    }

    @MainActor
    private func loadLibraryItem(_ item: PhotosPickerItem) async {
        phase = .preparing
        do {
            guard let data = try await item.loadTransferable(type: Data.self),
                  let image = UIImage(data: data) else {
                phase = .failed("Couldn't read that photo.")
                return
            }
            libraryItem = nil
            handlePicked(image)
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }

    @MainActor
    private func uploadAndEstimate(_ image: UIImage) async {
        guard let data = MealPhotoEncoder.encode(image) else {
            phase = .failed("Couldn't prepare that photo.")
            return
        }

        phase = .uploading
        do {
            let upload = try await scopedRequest { try await APIClient.shared.uploadMealPhoto(imageData: data, takenAt: Date(), childId: targetChildId) }
            photoId = upload.photoId
            phase = .estimating
            let result = try await scopedRequest { try await APIClient.shared.estimateNutrition(
                photoId: upload.photoId,
                description: replyText,
                childId: targetChildId
            ) }
            estimate = result
            if grams.isEmpty {
                grams = "\(result.suggestedGrams)"
            }
            phase = .idle
        } catch {
            // The photo itself may have uploaded; keep photoId so Confirm still
            // attaches it even when the estimate failed.
            phase = .failed(error.localizedDescription)
        }
    }

    @MainActor
    private func retry() {
        guard let photoPreview else { return }
        handlePicked(photoPreview)
    }

    private var targetChildId: String { route.context == nil ? childId : "patient" }

    private func scopedRequest<T>(_ action: () async throws -> T) async throws -> T {
        guard let accountKey, accountKey == AuthManager.shared.mealAccountKey else { throw APIError.notPatient }
        return try await MealRequestContext.$accountKey.withValue(accountKey, operation: action)
    }

    @MainActor
    private func reviseEstimate() async {
        guard !phase.isBusy, photoId != nil || !trimmedNote.isEmpty else { return }
        phase = .estimating
        do {
            let result = try await scopedRequest { try await APIClient.shared.estimateNutrition(
                photoId: photoId, description: replyText, childId: targetChildId,
                followUp: followUp, previousEstimate: estimate
            ) }
            estimate = result
            grams = "\(result.suggestedGrams)"
            followUp = ""
            phase = .idle
        } catch { phase = .failed(error.localizedDescription) }
    }

    // MARK: - Confirm / cancel

    @MainActor
    private func cancel() {
        MealNavigation.shared.clear()
        dismiss()
    }

    @MainActor
    private func confirm() {
        guard canConfirm else { return }
        isSaving = true
        let operations = buildOperations()
        guard !operations.isEmpty else {
            isSaving = false
            return
        }

        Task {
            for operation in operations {
                await MealOutbox.shared.enqueue(operation)
            }
        }
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        MealNavigation.shared.clear()
        dismiss()
    }

    /// The whole write plan for this sheet, in send order. A rise prompt
    /// answered "yes, no bolus" produces two: the reply (descriptive) and the
    /// carb log (the only thing that reaches Nightscout).
    private func buildOperations() -> [MealOutboxOperation] {
        guard let context = route.context else {
            guard let input = carbLogInput() else { return [] }
            return [.logMeal(input)]
        }

        if context.isGlucoseRise {
            guard let riseAnswer else { return [] }
            switch riseAnswer {
            case .didNotEat:
                return [.reply(MealReplyInput(
                    episodeId: context.episodeId,
                    kind: MealReplyInput.kindChip,
                    ateSomething: false
                ))]
            case .bolused:
                return [.reply(MealReplyInput(
                    episodeId: context.episodeId,
                    kind: replyKind,
                    ateSomething: true,
                    bolused: true,
                    text: replyText,
                    photoId: photoId,
                    nutrition: estimate,
                    childId: targetChildId
                ))]
            case .noBolus:
                var operations: [MealOutboxOperation] = [.reply(MealReplyInput(
                    episodeId: context.episodeId,
                    kind: replyKind,
                    ateSomething: true,
                    bolused: false,
                    text: replyText,
                    photoId: photoId,
                    nutrition: estimate,
                    childId: targetChildId
                ))]
                if let input = carbLogInput() {
                    operations.append(.logMeal(input))
                }
                return operations
            }
        }

        return [.reply(MealReplyInput(
            episodeId: context.episodeId,
            kind: replyKind,
            ateSomething: true,
            eatTiming: timing?.rawValue,
            text: replyText,
            photoId: photoId,
            nutrition: estimate,
            childId: targetChildId
        ))]
    }

    private var replyKind: String {
        if photoId != nil { return MealReplyInput.kindPhoto }
        if replyText != nil { return MealReplyInput.kindText }
        return MealReplyInput.kindChip
    }

    private func carbLogInput() -> MealLogInput? {
        guard let gramValue else { return nil }
        let now = Date()
        guard eatenAt >= now.addingTimeInterval(-24 * 60 * 60), eatenAt <= now.addingTimeInterval(300) else { return nil }
        let validEatenAt = eatenAt
        return MealLogInput(
            grams: gramValue,
            carbClass: carbClass.rawValue,
            reason: reason.rawValue,
            eatenAt: validEatenAt,
            description: replyText,
            photoId: photoId,
            nutrition: estimate,
            childId: targetChildId
        )
    }
}

// MARK: - Camera / library source

enum MealCameraSource: String, Identifiable {
    case camera
    case library

    var id: String { rawValue }

    var uiKitSource: UIImagePickerController.SourceType {
        self == .camera ? .camera : .photoLibrary
    }
}

/// `PhotosPicker` cannot capture, so live camera capture needs the UIKit
/// controller. Falls back to `.photoLibrary` when the device has no camera
/// (Simulator), which the caller decides via
/// `UIImagePickerController.isSourceTypeAvailable(.camera)`.
struct MealCameraPicker: UIViewControllerRepresentable {
    let sourceType: UIImagePickerController.SourceType
    /// Called once with the picked image, or nil on cancel. The caller is
    /// responsible for dismissing (it owns the presentation state).
    let onResult: (UIImage?) -> Void

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = UIImagePickerController.isSourceTypeAvailable(sourceType) ? sourceType : .photoLibrary
        picker.mediaTypes = ["public.image"]
        picker.allowsEditing = false
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ picker: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(onResult: onResult)
    }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        private let onResult: (UIImage?) -> Void
        private var hasReported = false

        init(onResult: @escaping (UIImage?) -> Void) {
            self.onResult = onResult
        }

        func imagePickerController(
            _ picker: UIImagePickerController,
            didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
        ) {
            report(info[.originalImage] as? UIImage)
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            report(nil)
        }

        private func report(_ image: UIImage?) {
            guard !hasReported else { return }
            hasReported = true
            onResult(image)
        }
    }
}

#Preview {
    MealSheet(route: .uncovered)
}
