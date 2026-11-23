import { ImageResponse } from "next/og";

export const alt = "bizinvoX.com - create professional invoices in under a minute";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "center", padding: 80, background: "linear-gradient(135deg, #2E3A8C 0%, #1B2353 100%)", color: "white", fontFamily: "sans-serif" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
          <svg width="96" height="96" viewBox="0 0 64 64">
            <path d="M14 4h26l14 14v38a4 4 0 0 1-4 4H14a4 4 0 0 1-4-4V8a4 4 0 0 1 4-4z" fill="#E6E9FB" />
            <path d="M40 4v10a4 4 0 0 0 4 4h10z" fill="#A8B1F2" />
            <path d="M20 44.5l6.5 6.5L42 35.5" fill="none" stroke="#10B981" strokeWidth="5.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <div style={{ fontSize: 64, fontWeight: 800 }}>bizinvoX.com</div>
        </div>
        <div style={{ marginTop: 48, fontSize: 68, fontWeight: 800, lineHeight: 1.1, maxWidth: 950 }}>Professional invoices in under a minute.</div>
        <div style={{ marginTop: 24, fontSize: 30, color: "#C7CCF5" }}>Free invoice generator · Custom templates · PDF download</div>
      </div>
    ),
    size,
  );
}
