// The component map view: one level at a time, a breadcrumb back up and a
// detail panel for the level or the selected element. It draws a stored map
// and needs no hub, so the hub's map page and an exported page share it.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ELK from "elkjs/lib/elk.bundled.js";
import type { ElkNode } from "elkjs/lib/elk-api.js";
import { mapUrl, sessionUrl } from "../navigation.js";
import {
  buildLevel,
  defaultLevel,
  highlighted,
  levelTrail,
  visibleChildren,
  type Level,
  type Selection,
} from "./levels.js";
import { layoutLevel } from "./layout.js";
import { Legend, MapDiagram, type DiagramMarks } from "./MapDiagram.js";
import { MapPanel, type PanelReview } from "./MapPanel.js";
import { recalledPlace, rememberPlace, type MapPlace } from "./place.js";
import { drawnMap, edgeChanges, itemCounts } from "./review.js";
import { usePanZoom } from "./usePanZoom.js";
import type { ResolvedMap, StoredMapResponse } from "./types.js";

const SYSTEM = "system";
/** Remembered-place key of an exported page, which has no session. */
const EXPORTED = "exported";
const elk = new ELK();

/** The level a URL asks for: a component with visible parts, the system level, or the map's default. */
export function levelFromUrl(map: ResolvedMap, search: string): string | null {
  const asked = new URLSearchParams(search).get("level");
  if (asked === SYSTEM) return null;
  if (asked && visibleChildren(map, asked).length > 0) return asked;
  return defaultLevel(map);
}

/** Where the map opens: the remembered place when the URL names no level or
 *  the remembered one, otherwise the URL's level at its default view. */
export function startingPlace(map: ResolvedMap, sessionId: string, search: string): MapPlace & { recalled: boolean } {
  const level = levelFromUrl(map, search);
  const asked = new URLSearchParams(search).get("level");
  const recalled = recalledPlace(sessionId);
  const fresh = (at: string | null) => ({ level: at, selection: null, transform: null, recalled: false });
  if (recalled && asked === null) {
    const valid = levelFromUrl(map, `?level=${encodeURIComponent(recalled.level ?? SYSTEM)}`);
    return valid === recalled.level ? { ...recalled, recalled: true } : fresh(valid);
  }
  if (recalled && recalled.level === level) return { ...recalled, recalled: true };
  return fresh(level);
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
  sessionId: string | undefined;
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
      {sessionId !== undefined && (
        <a className="btn" href={sessionUrl(sessionId)}>
          Review
        </a>
      )}
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

function marksFor(map: ResolvedMap, level: Level, review: PanelReview | undefined): DiagramMarks | undefined {
  if (!map.change) return undefined;
  return {
    edges: edgeChanges(map, level),
    counts: review ? itemCounts(map, review.placed) : new Map<string, { changed: number; reviewed: number }>(),
    parts: new Map([
      ...map.change.addedComponents.map((id) => [id, "added"] as const),
      ...map.change.removedComponents.map((id) => [id, "removed"] as const),
    ]),
    touched: new Set(map.change.touched.map((t) => t.interface)),
    surfaces: new Set(map.change.surfaces.map((s) => s.id)),
  };
}

/** The opened level and selection. On the hub each level has a URL and the
 *  back button walks the levels; without a session they stay in memory. */
function useLevelNavigation(map: ResolvedMap, sessionId: string | undefined, start: ReturnType<typeof startingPlace>) {
  const [levelId, setLevelId] = useState(start.level);
  const [selection, setSelection] = useState<Selection>(start.selection);

  useEffect(() => {
    if (start.recalled && sessionId !== undefined)
      window.history.replaceState(null, "", mapUrl(sessionId, start.level ?? SYSTEM));
  }, [sessionId, start]);

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
      if (sessionId !== undefined) window.history.pushState(null, "", mapUrl(sessionId, id ?? SYSTEM));
      setLevelId(id);
      setSelection(select);
    },
    [sessionId],
  );
  return { levelId, selection, setSelection, open };
}

/** The map drawing, panel and navigation. On the hub (`sessionId` set) every level
 *  has a URL; an exported page (no session) keeps its level in memory. */
export function MapView({
  stored,
  sessionId,
  review,
}: {
  stored: StoredMapResponse;
  sessionId?: string;
  review?: PanelReview;
}) {
  const map = useMemo(() => drawnMap(stored.map), [stored.map]);
  const placeKey = sessionId ?? EXPORTED;
  const [start] = useState(() => startingPlace(map, placeKey, window.location.search));
  const { levelId, selection, setSelection, open } = useLevelNavigation(map, sessionId, start);
  const { level, layout, error } = useLevelLayout(map, levelId);
  const canvas = useRef<HTMLDivElement>(null);
  const size = useMemo(() => (layout ? { width: layout.width!, height: layout.height! } : null), [layout]);
  const view = usePanZoom(canvas, size, () => setSelection(null), start.transform);
  const { hl, keep } = useMemo(() => highlighted(level, selection), [level, selection]);
  const marks = useMemo(() => marksFor(map, level, review), [map, level, review]);

  useEffect(() => {
    rememberPlace(placeKey, { level: levelId, selection, transform: view.tf });
  }, [placeKey, levelId, selection, view.tf]);

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
                  {...(marks ? { marks } : {})}
                  onSelectNode={(id) => setSelection({ type: "node", id })}
                  onSelectIface={(id) => setSelection({ type: "iface", id })}
                  onOpen={(id) => open(id)}
                />
              )}
            </g>
          </svg>
          <Legend review={map.change !== undefined} />
        </div>
        <MapPanel
          map={map}
          level={levelId}
          connections={level.edges.size}
          selection={selection}
          {...(review ? { review } : {})}
          onSelect={setSelection}
          onOpen={open}
        />
      </div>
    </div>
  );
}
