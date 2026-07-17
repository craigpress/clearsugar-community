import SwiftUI
import AVFoundation

struct QRScannerView: UIViewControllerRepresentable {
    /// Called with the server URL parsed from the pairing QR
    /// (GET /api/auth/qr → qr_data = {"serverUrl": "..."}).
    let onScanned: (String) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> QRScannerViewController {
        let vc = QRScannerViewController()
        vc.onScanned = { serverUrl in
            onScanned(serverUrl)
        }
        return vc
    }

    func updateUIViewController(_ vc: QRScannerViewController, context: Context) {}
}

final class QRScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onScanned: ((String) -> Void)?

    private let captureSession = AVCaptureSession()
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private var hasScanned = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        setupCamera()
        setupOverlay()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            self?.captureSession.startRunning()
        }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        captureSession.stopRunning()
    }

    private func setupCamera() {
        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device) else { return }

        if captureSession.canAddInput(input) {
            captureSession.addInput(input)
        }

        let output = AVCaptureMetadataOutput()
        if captureSession.canAddOutput(output) {
            captureSession.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: .main)
            output.metadataObjectTypes = [.qr]
        }

        let layer = AVCaptureVideoPreviewLayer(session: captureSession)
        layer.frame = view.bounds
        layer.videoGravity = .resizeAspectFill
        view.layer.addSublayer(layer)
        previewLayer = layer
    }

    private func setupOverlay() {
        // Semi-transparent overlay with cutout
        let overlay = UIView(frame: view.bounds)
        overlay.backgroundColor = UIColor.black.withAlphaComponent(0.5)
        overlay.isUserInteractionEnabled = false
        view.addSubview(overlay)

        // Cutout for viewfinder
        let scanSize: CGFloat = 250
        let scanRect = CGRect(
            x: (view.bounds.width - scanSize) / 2,
            y: (view.bounds.height - scanSize) / 2 - 40,
            width: scanSize,
            height: scanSize
        )

        let path = UIBezierPath(rect: overlay.bounds)
        path.append(UIBezierPath(roundedRect: scanRect, cornerRadius: 20).reversing())
        let maskLayer = CAShapeLayer()
        maskLayer.path = path.cgPath
        overlay.layer.mask = maskLayer

        // Viewfinder border
        let border = UIView(frame: scanRect)
        border.backgroundColor = .clear
        border.layer.borderColor = UIColor(red: 0.486, green: 0.302, blue: 1.0, alpha: 1.0).cgColor
        border.layer.borderWidth = 2
        border.layer.cornerRadius = 20
        view.addSubview(border)

        // Label
        let label = UILabel()
        label.text = "Scan ClearSugar QR code"
        label.textColor = .white
        label.font = .systemFont(ofSize: 16, weight: .medium)
        label.textAlignment = .center
        label.frame = CGRect(
            x: 0,
            y: scanRect.maxY + 24,
            width: view.bounds.width,
            height: 24
        )
        view.addSubview(label)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.bounds
    }

    // MARK: - QR Detection

    func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        guard !hasScanned,
              let metadata = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
              let string = metadata.stringValue,
              let serverUrl = AuthManager.parseQRPayload(string) else { return }

        hasScanned = true
        captureSession.stopRunning()

        // Haptic feedback
        let generator = UINotificationFeedbackGenerator()
        generator.notificationOccurred(.success)

        onScanned?(serverUrl)
    }
}
