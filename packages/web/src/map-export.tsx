// Entry of an exported component map: a self-contained page that draws the
// map embedded in it (`<script type="application/json" id="srev-map">`)
// without a hub. `srev map export` writes the page; the hub builds this
// bundle into dist/export/.
import { createRoot } from "react-dom/client";
import { MapView } from "./map/MapView.js";
import type { StoredMapResponse } from "./map/types.js";
import "./styles.css";

/** The stored map embedded in the page, or null when the page carries none. */
export function embeddedMap(doc: Document): StoredMapResponse | null {
  const text = doc.getElementById("srev-map")?.textContent;
  if (!text) return null;
  try {
    return JSON.parse(text) as StoredMapResponse;
  } catch {
    return null;
  }
}

const root = document.getElementById("root");
const stored = embeddedMap(document);
if (root) {
  createRoot(root).render(
    stored ? <MapView stored={stored} /> : <p className="session-picker">This page carries no component map.</p>,
  );
}
