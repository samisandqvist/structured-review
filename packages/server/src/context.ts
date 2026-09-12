import type { DB } from "./db/connection.js";
import type { GraphProvider } from "./graph/provider.js";

export interface AppContext {
  db: DB;
  graphProvider: GraphProvider;
  /** Git root the hub reads diffs from. Defaults to the ambient repo; tests pin a fixture. */
  repoRoot?: string;
  /** Built web SPA dir. When set and it contains index.html, the app serves it after the API. */
  webDistPath?: string;
  /** Graph provider name reported on /health (scip | crg | stub). */
  providerName?: string;
  /** Called after POST /api/shutdown responds. index.ts exits the process;
   *  tests leave it unset and the endpoint reports shutdown unsupported. */
  onShutdown?: () => void;
}
