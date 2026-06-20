export function SplitLayout({ sessionId: _sessionId, currentNodeId: _currentNodeId }: {
  sessionId: string;
  currentNodeId: string | null;
}) {
  return (
    <div style={{ flex: 1, display: "flex" }}>
      <div style={{ flex: 1, borderRight: "1px solid #333", padding: "8px" }}>Graph view</div>
      <div style={{ flex: 1, padding: "8px" }}>Diff view</div>
    </div>
  );
}
