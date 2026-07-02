"use client";

import { useState, useEffect, useRef } from "react";
import QRCode from "qrcode";

export default function MobileSetupQR() {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!visible) return;

    async function generate() {
      try {
        const res = await fetch("/api/auth/qr");
        if (!res.ok) {
          setError("Could not load QR code");
          return;
        }
        const { qr_data } = await res.json();
        if (canvasRef.current) {
          await QRCode.toCanvas(canvasRef.current, qr_data, {
            width: 200,
            margin: 2,
            color: { dark: "#ffffffee", light: "#00000000" },
          });
        }
      } catch {
        setError("Failed to generate QR code");
      }
    }

    generate();
  }, [visible]);

  return (
    <div className="rounded-2xl border border-white/[0.06] bg-[#111] p-5">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium text-neutral-400">
            Mobile Setup
          </h3>
          <p className="mt-1 text-xs text-neutral-500">
            Scan with the ClearSugar iOS app
          </p>
        </div>
        <button
          onClick={() => setVisible(!visible)}
          className="rounded-full bg-[#7c4dff]/20 px-3 py-1.5 text-xs font-medium text-[#7c4dff] transition hover:bg-[#7c4dff]/30"
        >
          {visible ? "Hide" : "Show QR"}
        </button>
      </div>

      {visible && (
        <div className="mt-4 flex justify-center">
          {error ? (
            <p className="text-sm text-red-400">{error}</p>
          ) : (
            <canvas ref={canvasRef} />
          )}
        </div>
      )}
    </div>
  );
}
