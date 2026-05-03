import { ImageResponse } from "next/og";

export const runtime = "edge";
export const alt = "ccremote — Your Claude. Your terminal. Anywhere.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "flex-start",
          padding: "80px",
          background: "linear-gradient(135deg, #1a0c0a 0%, #2a1410 60%, #3a1c14 100%)",
          color: "#fff5ee",
          fontFamily: "system-ui",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 20, marginBottom: 40 }}>
          <div
            style={{
              width: 72,
              height: 72,
              borderRadius: 18,
              background: "#e87958",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 44,
              color: "#fff5ee",
              fontWeight: 700,
            }}
          >
            ›
          </div>
          <div style={{ fontSize: 56, fontWeight: 700, letterSpacing: -1 }}>ccremote</div>
        </div>
        <div
          style={{
            fontSize: 72,
            fontWeight: 800,
            letterSpacing: -2,
            lineHeight: 1.05,
            marginBottom: 24,
            display: "flex",
            flexDirection: "column",
          }}
        >
          <span>Your Claude.</span>
          <span>Your terminal.</span>
          <span style={{ color: "#e87958" }}>Anywhere.</span>
        </div>
        <div style={{ fontSize: 28, color: "#d4b8a8", maxWidth: 900 }}>
          Self-hosted browser terminal for Claude Code. One npm install away.
        </div>
        <div
          style={{
            marginTop: 40,
            fontSize: 22,
            color: "#e87958",
            fontFamily: "monospace",
          }}
        >
          $ npm i -g ccremote
        </div>
      </div>
    ),
    { ...size },
  );
}
