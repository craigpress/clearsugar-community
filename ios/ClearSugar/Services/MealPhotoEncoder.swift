import UIKit

/// Turns a camera/library image into the exact bytes `POST /api/meals/photo`
/// accepts: JPEG, <= 1024 px on the long edge, <= 1.5 MB.
///
/// Re-drawing through `UIGraphicsImageRenderer` and re-encoding with
/// `jpegData(compressionQuality:)` is also what strips EXIF — the new JPEG
/// carries no APP1 block, so the GPS coordinates and capture device of a photo
/// of a child's dinner never leave the phone. (The server strips APP1..APP15
/// again; this is the first of the two passes, not the only one.)
enum MealPhotoEncoder {
    static let maxDimension: CGFloat = 1024
    static let maxBytes = 1_500_000

    /// Quality ladder. Starts at the contract's 0.85 and steps down only if the
    /// result is still over the server's cap — a 1024 px meal photo is normally
    /// 150-400 KB, so the lower rungs are for pathological inputs.
    private static let qualityLadder: [CGFloat] = [0.85, 0.7, 0.55, 0.4]

    static func encode(
        _ image: UIImage,
        maxDimension: CGFloat = MealPhotoEncoder.maxDimension,
        maxBytes: Int = MealPhotoEncoder.maxBytes
    ) -> Data? {
        let targetSize = fittedSize(for: image.size, maxDimension: maxDimension)
        guard targetSize.width >= 1, targetSize.height >= 1 else { return nil }

        let format = UIGraphicsImageRendererFormat.default()
        // scale 1 so the pixel size is exactly targetSize, not targetSize * 3.
        format.scale = 1
        format.opaque = true
        let renderer = UIGraphicsImageRenderer(size: targetSize, format: format)
        // draw(in:) applies imageOrientation, so a portrait photo is baked
        // upright instead of relying on an EXIF tag that is about to be dropped.
        let redrawn = renderer.image { _ in
            image.draw(in: CGRect(origin: .zero, size: targetSize))
        }

        var encoded: Data?
        for quality in qualityLadder {
            guard let data = redrawn.jpegData(compressionQuality: quality) else { continue }
            encoded = data
            if data.count <= maxBytes { return data }
        }
        return encoded
    }

    /// Scales down to fit `maxDimension` on the long edge; never scales up.
    static func fittedSize(for size: CGSize, maxDimension: CGFloat = MealPhotoEncoder.maxDimension) -> CGSize {
        let longEdge = max(size.width, size.height)
        guard longEdge > maxDimension, longEdge > 0 else { return size }
        let scale = maxDimension / longEdge
        return CGSize(
            width: (size.width * scale).rounded(),
            height: (size.height * scale).rounded()
        )
    }
}
