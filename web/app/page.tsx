export default function Home() {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "80px 24px" }}>
      <p style={{ fontFamily: "ui-monospace, monospace", color: "#f7941e", letterSpacing: "0.2em", textTransform: "uppercase", fontSize: 12 }}>
        GameSpy Arcade, rebuilt
      </p>
      <h1 style={{ fontSize: 56, fontWeight: 800, margin: "12px 0 0" }}>
        Open<span style={{ color: "#f7941e" }}>Arcade</span>
      </h1>
      <p style={{ fontSize: 20, color: "#a7b8c3", maxWidth: "50ch" }}>
        Browse live servers for the classic games, launch straight into them, and hang out
        in the rooms — reborn and self-hosted.
      </p>
      <div style={{ display: "flex", gap: 12, marginTop: 28 }}>
        <a href="/signup" style={btn(true)}>Create account</a>
        <a href="/download" style={btn(false)}>Download the client</a>
      </div>
      {/* Phase 5: signup form, live server browser, and per-game connect guides. */}
    </main>
  );
}

function btn(primary: boolean): React.CSSProperties {
  return {
    padding: "12px 20px",
    borderRadius: 10,
    fontWeight: 600,
    textDecoration: "none",
    color: primary ? "#0d1216" : "#e7eef2",
    background: primary ? "#f7941e" : "transparent",
    border: primary ? "none" : "1px solid #243440",
  };
}
