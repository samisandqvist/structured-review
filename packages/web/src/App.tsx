import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useUIStore } from "./store/ui.js";
import { SplitLayout } from "./components/SplitLayout.js";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 1000, refetchOnWindowFocus: false } },
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ReviewShell />
    </QueryClientProvider>
  );
}

function ReviewShell() {
  const currentNodeId = useUIStore((s) => s.currentNodeId);
  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <header style={{ padding: "8px 16px", borderBottom: "1px solid #333" }}>
        <h1 style={{ margin: 0, fontSize: "1rem" }}>Code Review Walkthrough</h1>
      </header>
      <SplitLayout sessionId="placeholder" currentNodeId={currentNodeId} />
    </div>
  );
}
