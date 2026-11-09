// The hub's component map page: loads the session's stored map and, in a
// review, places the change's items on it so a part's changed items open in
// the review view. The drawing itself is MapView.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useMap } from "../api/hooks.js";
import { api, ApiError } from "../api/client.js";
import { navigateToSession, sessionUrl } from "../navigation.js";
import { useUIStore } from "../store/ui.js";
import type { PanelReview } from "./MapPanel.js";
import { MapView } from "./MapView.js";
import { drawnMap, placeItems } from "./review.js";
import type { ResolvedMap, StoredMapResponse } from "./types.js";

export { levelFromUrl, startingPlace } from "./MapView.js";

export function MapPage({ sessionId }: { sessionId: string }) {
  const { data, error } = useMap(sessionId);
  if (error) {
    const missing = error instanceof ApiError && error.status === 404;
    return (
      <div className="session-picker" data-testid="map-empty">
        <h1 className="session-picker__title">
          {missing ? "No component map for this session" : "Couldn't load the map"}
        </h1>
        <p className="session-picker__hint">
          {missing
            ? "Ask your agent to map the codebase. For example:"
            : "The review server didn't answer. Is it still running?"}
        </p>
        {missing && <pre className="cmap-prompt">Use component-map to map this codebase and open the map.</pre>}
        <a className="session-picker__hint" href={sessionUrl(sessionId)}>
          Back to the review
        </a>
      </div>
    );
  }
  if (!data) return <div className="session-picker session-picker--loading">Loading the component map…</div>;
  return <HubMapView sessionId={sessionId} stored={data} />;
}

/** The review's changed items placed on the map; undefined outside a review or while loading. */
function useReview(sessionId: string, map: ResolvedMap): PanelReview | undefined {
  const enabled = map.change !== undefined;
  const nodes = useQuery({ queryKey: ["nodes", sessionId], queryFn: () => api.getNodes(sessionId), enabled });
  const session = useQuery({ queryKey: ["session", sessionId], queryFn: () => api.getSession(sessionId), enabled });
  const flows = useQuery({ queryKey: ["flows", sessionId], queryFn: () => api.getFlows(sessionId), enabled });
  return useMemo(() => {
    if (!map.change || !nodes.data) return undefined;
    return {
      change: map.change,
      placed: placeItems(map, map.change, nodes.data.nodes, session.data?.units ?? [], flows.data?.flows ?? []),
      onReview: (nodeId: string) => {
        useUIStore.getState().setCurrentNode(nodeId, "walk");
        navigateToSession(sessionId);
      },
    };
  }, [map.change, nodes.data, session.data, flows.data, sessionId]);
}

function HubMapView({ sessionId, stored }: { sessionId: string; stored: StoredMapResponse }) {
  const review = useReview(
    sessionId,
    useMemo(() => drawnMap(stored.map), [stored.map]),
  );
  return <MapView stored={stored} sessionId={sessionId} {...(review ? { review } : {})} />;
}
