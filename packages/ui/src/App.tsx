/**
 * App shell placeholder (M1-T3). Layout rules that already apply:
 *  - one bundle for desktop renderer, browser, PWA
 *  - safe areas via env(); keyboard inset via visualViewport (M7-T2), never `+` with safe-area
 *  - everything rendered from agent output is escaped (AGENTS.md invariant 9)
 */
export function App() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 24 }}>
      <h1>piorbit</h1>
      <p>UI scaffold. See PLAN.md M1.</p>
    </main>
  );
}
