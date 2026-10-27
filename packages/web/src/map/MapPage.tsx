// The component map page: one level at a time, a breadcrumb back up, a URL
// per level, and a detail panel for the level or the selected element.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ELK from "elkjs/lib/elk.bundled.js";
import type { ElkNode } from "elkjs/lib/elk-api.js";
import { useMap } from "../api/hooks.js";
import { ApiError } from "../api/client.js";
import { mapUrl, sessionUrl } from "../navigation.js";
import { buildLevel, defaultLevel, highlighted, levelTrail, visibleChildren, type Selection } from "./levels.js";
import { layoutLevel } from "./layout.js";
import { Legend, MapDiagram } from "./MapDiagram.js";
import { MapPanel } from "./MapPanel.js";
import { usePanZoom } from "./usePanZoom.js";
import type { ResolvedMap, StoredMapResponse } from "./types.js";

const SYSTEM = "system";
const elk = new ELK();

/** The level a URL asks for: a component with visible parts, the system level, or the map's default. */
export function levelFromUrl(map: ResolvedMap, search: string): string | null {
  const asked = new URLSearchParams(search).get("level");
  if (asked === SYSTEM) return null;
  if (asked && visibleChildren(map, asked).length > 0) return asked;
  return defaultLevel(map);
}

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
  return <MapView sessionId={sessionId} stored={data} />;
}

function Crumbs({
  map,
  level,
  onOpen,
}: {
  map: ResolvedMap;
  level: string | null;
  onOpen: (id: string | null) => void;
}) {
  const trail = levelTrail(map, level);
  const name = (id: string) => map.components.find((c) => c.id === id)!.name;
  return (
    <nav className="crumbs" aria-label="Level">
      {level === null ? (
        <span className="here">System</span>
      ) : (
        <button type="button" onClick={() => onOpen(null)}>
          System
        </button>
      )}
      {trail.map((id, i) => (
        <span key={id} className="crumb">
          <span aria-hidden="true">›</span>
          {i === trail.length - 1 ? (
            <span className="here">{name(id)}</span>
          ) : (
            <button type="button" onClick={() => onOpen(id)}>
              {name(id)}
            </button>
          )}
        </span>
      ))}
    </nav>
  );
}

function useLevelLayout(map: ResolvedMap, levelId: string | null) {
  const level = useMemo(() => buildLevel(map, levelId), [map, levelId]);
  const [result, setResult] = useState<{ level: typeof level; layout?: ElkNode; error?: string } | null>(null);
  useEffect(() => {
    let live = true;
    layoutLevel(map, level, elk).then(
      (layout) => live && setResult({ level, layout }),
      (e: Error) => live && setResult({ level, error: e.message }),
    );
    return () => {
      live = false;
    };
  }, [map, level]);
  return {
    level,
    layout: result?.level === level ? result.layout : undefined,
    error: result?.level === level ? result.error : undefined,
  };
}

function Toolbar({
  sessionId,
  stored,
  level,
  onOpen,
  view,
}: {
  sessionId: string;
  stored: StoredMapResponse;
  level: string | null;
  onOpen: (id: string | null) => void;
  view: { zoomIn: () => void; zoomOut: () => void; fit: () => void };
}) {
  const { map } = stored;
  return (
    <div className="cmap-bar">
      <h1>Component map</h1>
      <Crumbs map={map} level={level} onOpen={onOpen} />
      <span
        className="tag"
        title="Components and interfaces were inferred by an LLM from index references and checked against them"
      >
        inferred draft
      </span>
      {stored.stale && (
        <span className="stale" data-testid="map-stale">
          ⚠ the code changed since this map was built (
          {stored.staleReason === "head-moved" ? "new commits" : "working tree edits"})
        </span>
      )}
      <span className="spacer" />
      <a className="btn" href={sessionUrl(sessionId)}>
        Review
      </a>
      <div className="tools">
        <button type="button" aria-label="Zoom out" onClick={view.zoomOut}>
          −
        </button>
        <button type="button" onClick={view.fit}>
          Fit
        </button>
        <button type="button" aria-label="Zoom in" onClick={view.zoomIn}>
          +
        </button>
      </div>
    </div>
  );
}

function MapView({ sessionId, stored }: { sessionId: string; stored: StoredMapResponse }) {
  const { map } = stored;
  const [levelId, setLevelId] = useState(() => levelFromUrl(map, window.location.search));
  const [selection, setSelection] = useState<Selection>(null);
  const { level, layout, error } = useLevelLayout(map, levelId);
  const canvas = useRef<HTMLDivElement>(null);
  const size = useMemo(() => (layout ? { width: layout.width!, height: layout.height! } : null), [layout]);
  const view = usePanZoom(canvas, size, () => setSelection(null));
  const { hl, keep } = useMemo(() => highlighted(level, selection), [level, selection]);

  useEffect(() => {
    const onPop = () => {
      setLevelId(levelFromUrl(map, window.location.search));
      setSelection(null);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [map]);

  const open = useCallback(
    (id: string | null, select: Selection = null) => {
      window.history.pushState(null, "", mapUrl(sessionId, id ?? SYSTEM));
      setLevelId(id);
      setSelection(select);
    },
    [sessionId],
  );

  return (
    <div className="cmap">
      <Toolbar sessionId={sessionId} stored={stored} level={levelId} onOpen={open} view={view} />
      <div className="cmap-main">
        <div className="cmap-canvas" ref={canvas} {...view.pointer}>
          {!layout && <div className="cmap-status">{error ? `Layout failed: ${error}` : "Laying out…"}</div>}
          <svg className={selection ? "cmap-svg dimmed" : "cmap-svg"} role="img" aria-label="Component diagram">
            <g transform={view.transform}>
              {layout && (
                <MapDiagram
                  map={map}
                  level={level}
                  layout={layout}
                  hl={hl}
                  keep={keep}
                  onSelectNode={(id) => setSelection({ type: "node", id })}
                  onSelectIface={(id) => setSelection({ type: "iface", id })}
                  onOpen={(id) => open(id)}
                />
              )}
            </g>
          </svg>
          <Legend />
        </div>
        <MapPanel
          map={map}
          level={levelId}
          connections={level.edges.size}
          selection={selection}
          onSelect={setSelection}
          onOpen={open}
        />
      </div>
    </div>
  );
}
