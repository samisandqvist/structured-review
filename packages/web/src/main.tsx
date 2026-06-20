import { createRoot } from "react-dom/client";

function App() {
  return <div>Code Review Walkthrough</div>;
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
