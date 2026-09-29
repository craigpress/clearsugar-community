/**
 * ClearSugar — pure-JS JPEG metadata stripping
 *
 * Phase 3 of docs/MEAL_LOGGING_PLAN_2026-09-04.md, section 4c: a meal photo of a
 * minor lands on a box with no encryption at rest (risk 6), so every scrap of
 * metadata that could say *where* it was taken is removed before the bytes ever
 * reach disk. The client already downscales and re-encodes (which drops EXIF),
 * but that is the client's word for it — the server strips again and does not
 * trust the upload.
 *
 * No native dependency: `sharp` and friends are a build-time liability on small servers
 * and would re-encode pixels we have no reason to touch. Instead this walks the
 * JPEG marker stream and drops whole segments, leaving the entropy-coded scan
 * data byte-identical. That means:
 *   - the image is not re-compressed, so no quality is lost;
 *   - APP1 (EXIF, XMP), APP2..APP15 (ICC, Photoshop, MPF, ...) and COM comments
 *     are removed, which covers GPS, camera serial, timestamps and thumbnails;
 *   - APP0/JFIF is kept because it is pixel-density metadata, not provenance,
 *     and some decoders are happier with it.
 *
 * Structure being walked (ITU-T T.81):
 *   FFD8 SOI, then a sequence of markers. A marker is FF followed by a non-zero,
 *   non-FF byte. Most markers carry a big-endian 2-byte length that includes the
 *   length bytes themselves. A handful are standalone (no payload). FFDA (SOS)
 *   is followed by entropy-coded data with no length, which runs to EOI.
 */

/** Standalone markers: no length field, no payload. */
const STANDALONE = new Set<number>([
  0x01, // TEM
  0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, // RSTn
  0xd8, // SOI
  0xd9, // EOI
]);

/** Markers whose whole segment is dropped: APP1..APP15 and COM. */
function isMetadataMarker(marker: number): boolean {
  return (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe;
}

/**
 * Start-of-frame markers. FFC0..FFCF *except* C4 (DHT), C8 (JPG) and CC (DAC),
 * which are not frame headers and carry no dimensions.
 */
function isSofMarker(marker: number): boolean {
  if (marker < 0xc0 || marker > 0xcf) return false;
  return marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/** True when the buffer starts with the JPEG magic FF D8 FF. */
export function isJpeg(buf: Uint8Array): boolean {
  return (
    buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff
  );
}

/** Raised when the marker stream is malformed; callers answer 400. */
export class JpegParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JpegParseError";
  }
}

export interface JpegDimensions {
  width: number;
  height: number;
}

/**
 * Read width and height from the first SOF marker.
 *
 * SOF payload: length(2) precision(1) height(2) width(2) components(1) ...
 *
 * @throws JpegParseError when there is no SOF marker or it is truncated.
 */
export function readJpegDimensions(buf: Uint8Array): JpegDimensions {
  if (!isJpeg(buf)) throw new JpegParseError("not a JPEG");
  let i = 2;
  while (i < buf.length) {
    // Skip fill bytes: a marker may be preceded by any number of FFs.
    if (buf[i] !== 0xff) {
      throw new JpegParseError(`expected a marker at offset ${i}`);
    }
    while (i < buf.length && buf[i] === 0xff) i++;
    if (i >= buf.length) throw new JpegParseError("truncated marker");
    const marker = buf[i];
    i++;

    if (marker === 0x00) continue; // stuffed byte; not a marker
    if (STANDALONE.has(marker)) {
      if (marker === 0xd9) break; // EOI before any SOF
      continue;
    }
    if (i + 1 >= buf.length) throw new JpegParseError("truncated segment length");
    const length = (buf[i] << 8) | buf[i + 1];
    if (length < 2) throw new JpegParseError(`invalid segment length ${length}`);

    if (isSofMarker(marker)) {
      // length(2) precision(1) height(2) width(2)
      if (i + 6 >= buf.length) throw new JpegParseError("truncated SOF segment");
      const height = (buf[i + 3] << 8) | buf[i + 4];
      const width = (buf[i + 5] << 8) | buf[i + 6];
      if (width <= 0 || height <= 0) {
        throw new JpegParseError("SOF reports a zero dimension");
      }
      return { width, height };
    }
    if (marker === 0xda) break; // SOS: scan data begins, no SOF will follow
    i += length;
  }
  throw new JpegParseError("no SOF marker found");
}

/**
 * Remove every APP1..APP15 and COM segment, keeping everything else verbatim.
 *
 * SOI, APP0/JFIF, DQT, DHT, SOF, SOS and the entire entropy-coded scan through
 * EOI are copied byte for byte, so the decoded pixels are unchanged.
 *
 * @throws JpegParseError when the marker stream is malformed.
 */
export function stripJpegMetadata(buf: Uint8Array): Buffer {
  if (!isJpeg(buf)) throw new JpegParseError("not a JPEG");
  const out: Uint8Array[] = [buf.subarray(0, 2)]; // SOI
  let i = 2;

  while (i < buf.length) {
    if (buf[i] !== 0xff) {
      throw new JpegParseError(`expected a marker at offset ${i}`);
    }
    const markerStart = i;
    while (i < buf.length && buf[i] === 0xff) i++;
    if (i >= buf.length) throw new JpegParseError("truncated marker");
    const marker = buf[i];
    i++;

    if (marker === 0x00) {
      // A stuffed FF00 outside a scan should not happen; keep it rather than
      // guess, so a decoder sees exactly what it saw before.
      out.push(buf.subarray(markerStart, i));
      continue;
    }

    if (STANDALONE.has(marker)) {
      out.push(buf.subarray(markerStart, i));
      if (marker === 0xd9) {
        // EOI. Anything trailing it is not JPEG; drop it (some cameras append
        // proprietary blobs after EOI, which is exactly what we are removing).
        return Buffer.concat(out);
      }
      continue;
    }

    if (i + 1 >= buf.length) throw new JpegParseError("truncated segment length");
    const length = (buf[i] << 8) | buf[i + 1];
    if (length < 2) throw new JpegParseError(`invalid segment length ${length}`);
    const segmentEnd = i + length;
    if (segmentEnd > buf.length) throw new JpegParseError("segment runs past the end");

    if (marker === 0xda) {
      // SOS: the entropy-coded scan has no length, and FF bytes inside it are
      // not markers — so copy from here to the final EOI verbatim. Anything
      // *after* EOI is not JPEG (some cameras append proprietary blobs, e.g.
      // MPF trailers), and that is exactly what this function exists to remove.
      const eoi = buf.lastIndexOf(0xd9);
      const end = eoi > markerStart && buf[eoi - 1] === 0xff ? eoi + 1 : buf.length;
      out.push(buf.subarray(markerStart, end));
      return Buffer.concat(out);
    }

    if (isMetadataMarker(marker)) {
      i = segmentEnd; // drop the marker and its payload entirely
      continue;
    }

    out.push(buf.subarray(markerStart, segmentEnd));
    i = segmentEnd;
  }

  return Buffer.concat(out);
}
