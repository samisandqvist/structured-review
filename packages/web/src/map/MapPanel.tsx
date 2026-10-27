// Detail panel of the component map: the opened level (meaning, coverage,
// undeclared uses, hidden utilities, unclaimed files, index gaps), a selected
// component (files, interfaces, type-only dependencies) or a selected
// interface (bound functions or evidence, call sites by requirer). In a
// review the panels add the change: what it adds and removes, and the
// changed items of a part, which open in the review.
import type { Node } from "../api/client.js";
import type { CallSite, MapChange, ResolvedComponent, ResolvedInterface, ResolvedMap } from "./types.js";
import { requirersOf, undeclaredFindings, visibleChildren, type Selection } from "./levels.js";

/** A review's change and its changed items by component ("" for none). */
export interface PanelReview {
  change: MapChange;
  placed: Map<string, Node[]>;
  onReview: (nodeId: string) => void;
}

export interface PanelProps {
  map: ResolvedMap;
  level: string | null;
  connections: number;
  selection: Selection;
  review?: PanelReview;
  onSelect: (selection: Selection) => void;
  onOpen: (level: string | null, selection?: Selection) => void;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const nameOf = (map: ResolvedMap, id: string) => map.components.find((c) => c.id === id)!.name;

function Chip({ label, bad, onClick }: { label: string; bad?: boolean; onClick: () => void }) {
  return (
    <button type="button" className={bad ? "chip bad" : "chip"} onClick={onClick}>
      {label}
    </button>
  );
}

function ComponentChip({
  map,
  id,
  bad,
  onSelect,
}: {
  map: ResolvedMap;
  id: string;
  bad?: boolean;
  onSelect: PanelProps["onSelect"];
}) {
  const name = nameOf(map, id);
  return <Chip label={name} {...(bad ? { bad } : {})} onClick={() => onSelect({ type: "node", id })} />;
}

function InterfaceChips({ list, onSelect }: { list: ResolvedInterface[]; onSelect: PanelProps["onSelect"] }) {
  if (list.length === 0) return <p className="muted">Nothing at this level.</p>;
  return (
    <div className="chips">
      {list.map((i) => (
        <Chip key={i.id} label={i.name} onClick={() => onSelect({ type: "iface", id: i.id })} />
      ))}
    </div>
  );
}

function Findings({ map, onOpen }: Pick<PanelProps, "map" | "onOpen">) {
  const name = (id: string) => nameOf(map, id);
  const parentOf = (id: string) => map.components.find((c) => c.id === id)!.parent;
  const findings = undeclaredFindings(map);
  if (findings.length === 0) return null;
  return (
    <>
      <h3>Undeclared uses</h3>
      {findings.map((f) => (
        <button
          type="button"
          key={`${f.iface.id}:${f.requirer}`}
          className="finding"
          onClick={() => onOpen(parentOf(f.iface.provider), { type: "iface", id: f.iface.id })}
        >
          <b>{name(f.requirer)}</b> uses <b>{f.iface.name}</b> of {name(f.iface.provider)}
          {f.iface.requirers.length ? `, which the model reserves for ${f.iface.requirers.map(name).join(", ")}` : ""}.
          {f.iface.reasons
            .filter((r) => r.requirer === f.requirer)
            .map((r) => (
              <span key={r.requirer} className="reason">
                {r.reason}
              </span>
            ))}
          {f.sites.map((s) => (
            <code key={`${s.file}:${s.line}`}>
              {s.file}:{s.line} {s.symbol}
            </code>
          ))}
        </button>
      ))}
    </>
  );
}

function Items({ items, onReview }: { items: Node[]; onReview: PanelReview["onReview"] }) {
  return (
    <ul className="items">
      {items.map((n) => (
        <li key={n.id}>
          <button type="button" onClick={() => onReview(n.id)}>
            <span className="sym">{n.label}</span>{" "}
            <span className={n.reviewStatus === "unreviewed" ? "state todo" : "state"}>
              {n.reviewStatus === "unreviewed" ? "to review" : "reviewed"}
            </span>{" "}
            <span className="loc">
              {n.file}:{n.startLine}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The level a change line belongs to: where its interface's provider is a part. */
function changeLevels(map: ResolvedMap, level: string | null) {
  const parentOf = (id: string) => map.components.find((c) => c.id === id)!.parent;
  const providerOf = (iface: string) => map.interfaces.find((i) => i.id === iface)!.provider;
  const inside = (id: string) => {
    for (let at = parentOf(id); at !== null; at = parentOf(at)) if (at === level) return true;
    return level === null;
  };
  return {
    own: (iface: string) => parentOf(providerOf(iface)) === level,
    below: (iface: string) => parentOf(providerOf(iface)) !== level && inside(providerOf(iface)),
    ownPart: (id: string) => parentOf(id) === level,
  };
}

function PartLines({
  map,
  level,
  review,
  onSelect,
}: Pick<PanelProps, "map" | "level" | "onSelect"> & { review: PanelReview }) {
  const { ownPart } = changeLevels(map, level);
  const lines = [
    ...review.change.addedComponents.map((id) => ({ id, label: "New part", removed: false })),
    ...review.change.removedComponents.map((id) => ({ id, label: "Removed part", removed: true })),
  ].filter((l) => ownPart(l.id));
  return (
    <>
      {lines.map((l) => (
        <button
          type="button"
          key={l.id}
          className={l.removed ? "change-line removed" : "change-line"}
          onClick={() => onSelect({ type: "node", id: l.id })}
        >
          {l.label}: <b>{nameOf(map, l.id)}</b>
        </button>
      ))}
    </>
  );
}

function ChangeLines({
  map,
  level,
  review,
  onOpen,
}: Pick<PanelProps, "map" | "level" | "onOpen"> & { review: PanelReview }) {
  const name = (id: string) => nameOf(map, id);
  const iface = (id: string) => map.interfaces.find((i) => i.id === id)!;
  const go = (id: string) =>
    onOpen(map.components.find((c) => c.id === iface(id).provider)!.parent, { type: "iface", id });
  const { own, below } = changeLevels(map, level);
  const { change } = review;
  const verb = { new: "New dependency", removed: "Removed", changed: "Changed" } as const;
  const ifaces = [
    ...change.crossings.map((c) => c.interface),
    ...change.surfaces.map((s) => s.id),
    ...change.touched.map((t) => t.interface),
  ];
  const more = ifaces.filter(below).length;
  return (
    <>
      {change.crossings
        .filter((c) => own(c.interface))
        .map((c) => (
          <button
            type="button"
            key={`${c.interface}:${c.requirer}`}
            className={c.status === "removed" ? "change-line removed" : "change-line"}
            onClick={() => go(c.interface)}
          >
            {verb[c.status]}: <b>{name(c.requirer)}</b> → {iface(c.interface).name} of{" "}
            {name(iface(c.interface).provider)}
            {c.status === "changed" && ` (+${c.added.length} / −${c.removed.length} call sites)`}
          </button>
        ))}
      {change.surfaces
        .filter((s) => own(s.id))
        .map((s) => (
          <button type="button" key={s.id} className="change-line" onClick={() => go(s.id)}>
            New surface: <b>{s.symbol}</b> of {name(s.provider)}, used by {s.requirers.map(name).join(", ")}
          </button>
        ))}
      {change.touched
        .filter((t) => own(t.interface))
        .map((t) => (
          <button type="button" key={t.interface} className="change-line" onClick={() => go(t.interface)}>
            Contract touched: <b>{iface(t.interface).name}</b> ({t.reasons.join(", ")}
            {t.symbols.length > 0 && `: ${t.symbols.join(", ")}`})
          </button>
        ))}
      {more > 0 && <p className="muted">{plural(more, "more change")} inside the parts.</p>}
    </>
  );
}

function ChangeSummary({
  map,
  level,
  review,
  onSelect,
  onOpen,
}: Pick<PanelProps, "map" | "level" | "onSelect" | "onOpen"> & { review: PanelReview }) {
  const all = [...review.placed.values()].flat();
  const here = review.placed.get(level ?? "") ?? [];
  const itemFiles = new Set(here.map((n) => n.file));
  const files = (review.change.unmapped.find((u) => u.component === level)?.files ?? []).filter(
    (f) => !itemFiles.has(f),
  );
  return (
    <>
      <h3>Change</h3>
      <p className="muted">
        Against base {review.change.baseSha.slice(0, 7)}: {plural(all.length, "changed item")},{" "}
        {all.filter((n) => n.reviewStatus !== "unreviewed").length} reviewed.
      </p>
      <PartLines map={map} level={level} review={review} onSelect={onSelect} />
      <ChangeLines map={map} level={level} review={review} onOpen={onOpen} />
      {here.length > 0 && (
        <>
          <h3>Changed here, outside the parts</h3>
          <Items items={here} onReview={review.onReview} />
        </>
      )}
      {files.length > 0 && (
        <>
          <h3>Changed files no part claims</h3>
          <ul className="list">
            {files.map((f) => (
              <li key={f}>
                <span className="sym">{f}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

function LevelPanel({ map, level, connections, review, onSelect, onOpen }: PanelProps) {
  const component = level === null ? undefined : map.components.find((c) => c.id === level);
  const { report } = map;
  const unclaimed = report.unclaimedFiles.reduce((n, u) => n + u.files.length, 0);
  return (
    <>
      <div className="kind">{component ? "Inside" : "System"}</div>
      <h2>{component ? component.name : `${map.title} and its neighbours`}</h2>
      <p>{component ? component.meaning : "The top-level components and the external systems they talk to."}</p>
      <p className="muted">
        {plural(visibleChildren(map, level).length, "part")}, {plural(connections, "connection")} at this level. Select
        a part, an interface symbol or a line. Double-click a part marked “open” to go inside.
      </p>
      <h3>Coverage</h3>
      <p>
        {report.coverage.covered}/{report.coverage.references} cross-component references are call sites of an
        interface; {report.coverage.undeclared} undeclared.
      </p>
      {review && <ChangeSummary map={map} level={level} review={review} onSelect={onSelect} onOpen={onOpen} />}
      <Findings map={map} onOpen={onOpen} />
      {report.utilities.length > 0 && <h3>Hidden utilities</h3>}
      {report.utilities.map((u) => (
        <p key={u.id} className="muted">
          {nameOf(map, u.id)}: {plural(u.references, "reference")} hidden
        </p>
      ))}
      {(unclaimed > 0 || report.unattributedReferences > 0) && (
        <>
          <h3>Outside the parts</h3>
          <p className="muted">
            {plural(unclaimed, "file")} belong to no part; {plural(report.unattributedReferences, "reference")} start in
            them.
          </p>
        </>
      )}
      {report.gaps.length > 0 && <h3>Index gaps</h3>}
      {report.gaps.map((g) => (
        <p key={g} className="gap">
          {g}
        </p>
      ))}
      <p className="note">
        Parts, interfaces and their names were proposed by an LLM from index references; bindings and call sites come
        from the index. Tell your agent what is wrong and it revises the model.
      </p>
    </>
  );
}

function ComponentPanel({
  map,
  component,
  review,
  onSelect,
  onOpen,
}: { map: ResolvedMap; component: ResolvedComponent } & Pick<PanelProps, "review" | "onSelect" | "onOpen">) {
  const parts = visibleChildren(map, component.id);
  const items = parts.length === 0 ? (review?.placed.get(component.id) ?? []) : [];
  const name = (id: string) => nameOf(map, id);
  const types = map.report.typeDependencies.filter((t) => t.from === component.id || t.to === component.id);
  return (
    <>
      <div className="kind">{component.external ? "External system" : "Component"}</div>
      <h2>{component.name}</h2>
      <p>{component.meaning}</p>
      {parts.length > 0 && (
        <p>
          <button type="button" className="btn" onClick={() => onOpen(component.id)}>
            Open {component.name} ({plural(parts.length, "part")})
          </button>
        </p>
      )}
      {items.length > 0 && (
        <>
          <h3>Changed items ({items.length})</h3>
          <Items items={items} onReview={review!.onReview} />
        </>
      )}
      {component.paths.length > 0 && (
        <>
          <h3>Files ({component.fileCount})</h3>
          <ul className="list">
            {component.paths.map((p) => (
              <li key={p}>
                <span className="sym">{p === "" ? "(whole repository)" : p}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <h3>Provides</h3>
      <InterfaceChips list={map.interfaces.filter((i) => i.provider === component.id)} onSelect={onSelect} />
      <h3>Requires</h3>
      <InterfaceChips list={map.interfaces.filter((i) => requirersOf(i).has(component.id))} onSelect={onSelect} />
      {types.length > 0 && <h3>Type-only dependencies</h3>}
      {types.map((t) => (
        <p key={`${t.from}>${t.to}`} className="muted">
          {name(t.from)} → {name(t.to)}: {plural(t.count, "reference")} ({t.symbols.join(", ")})
        </p>
      ))}
    </>
  );
}

function Sites({ map, iface }: { map: ResolvedMap; iface: ResolvedInterface }) {
  const groups = new Map<string, CallSite[]>();
  for (const s of iface.sites) groups.set(s.requirer, [...(groups.get(s.requirer) ?? []), s]);
  if (groups.size === 0) return <p className="muted">None in this codebase; the requirer is outside it.</p>;
  return (
    <>
      {[...groups].map(([requirer, sites]) => (
        <details key={requirer} open={sites.some((s) => s.undeclared)}>
          <summary>
            <span>{nameOf(map, requirer)}</span>
            <span className="n">{sites.length}</span>
          </summary>
          <ul className="list">
            {sites.map((s) => (
              <li key={`${s.file}:${s.line}:${s.symbol}`} className={s.undeclared ? "bad" : ""}>
                <span className="sym">
                  {s.caller} → {s.symbol}
                </span>
                <span className="loc">
                  {s.file}:{s.line}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ))}
    </>
  );
}

function Realization({ iface }: { iface: ResolvedInterface }) {
  const rows = iface.kind
    ? iface.evidenceFiles.map((e) => ({ key: e.file, sym: e.file, loc: e.component }))
    : iface.bindings.map((b) => ({ key: `${b.file}:${b.name}`, sym: b.name, loc: `${b.file}:${b.line}` }));
  return (
    <>
      <h3>{iface.kind ? `Evidence (${plural(rows.length, "file")})` : `Bound to ${plural(rows.length, "symbol")}`}</h3>
      <ul className="list">
        {rows.map((r) => (
          <li key={r.key}>
            <span className="sym">{r.sym}</span>
            <span className="loc">{r.loc}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

function SiteList({ sites }: { sites: CallSite[] }) {
  return (
    <ul className="list">
      {sites.map((s) => (
        <li key={`${s.file}:${s.line}:${s.symbol}`}>
          <span className="sym">
            {s.caller} → {s.symbol}
          </span>
          <span className="loc">
            {s.file}:{s.line}
          </span>
        </li>
      ))}
    </ul>
  );
}

function InterfaceChange({ iface, change }: { iface: ResolvedInterface; change: MapChange }) {
  const crossings = change.crossings.filter((c) => c.interface === iface.id);
  const added = crossings.flatMap((c) => c.added);
  const removed = crossings.flatMap((c) => c.removed);
  const touched = change.touched.find((t) => t.interface === iface.id);
  return (
    <>
      {touched && (
        <p className="reason">
          Contract touched in this change ({touched.reasons.join(", ")}
          {touched.symbols.length > 0 && `: ${touched.symbols.join(", ")}`}).
        </p>
      )}
      {added.length > 0 && <h3>New call sites</h3>}
      {added.length > 0 && <SiteList sites={added} />}
      {removed.length > 0 && <h3>Removed call sites</h3>}
      {removed.length > 0 && <SiteList sites={removed} />}
    </>
  );
}

function InterfacePanel({
  map,
  iface,
  change,
  onSelect,
}: { map: ResolvedMap; iface: ResolvedInterface; change?: MapChange } & Pick<PanelProps, "onSelect">) {
  const requirers = requirersOf(iface);
  return (
    <>
      <div className="kind">{iface.kind ? `Cross-process interface · ${iface.kind}` : "Interface"}</div>
      <h2>{iface.name}</h2>
      <p>{iface.meaning}</p>
      <h3>Provided by → required by</h3>
      <div className="chips">
        <ComponentChip map={map} id={iface.provider} onSelect={onSelect} />
        <span className="muted">→</span>
        {[...requirers].map(([r, bad]) => (
          <ComponentChip key={r} map={map} id={r} bad={bad} onSelect={onSelect} />
        ))}
      </div>
      {[...requirers.values()].some(Boolean) && (
        <p className="muted">Red: uses this interface, but the model does not list it as a requirer.</p>
      )}
      {iface.reasons.map((r) => (
        <p key={r.requirer} className="reason">
          {nameOf(map, r.requirer)}: {r.reason}
        </p>
      ))}
      {change && <InterfaceChange iface={iface} change={change} />}
      <Realization iface={iface} />
      <h3>Call sites</h3>
      <Sites map={map} iface={iface} />
    </>
  );
}

export function MapPanel(props: PanelProps) {
  const { map, selection } = props;
  const component = selection?.type === "node" ? map.components.find((c) => c.id === selection.id) : undefined;
  const iface = selection?.type === "iface" ? map.interfaces.find((i) => i.id === selection.id) : undefined;
  return (
    <aside className="cmap-panel" aria-live="polite" data-testid="map-panel">
      {component && (
        <ComponentPanel
          map={map}
          component={component}
          {...(props.review ? { review: props.review } : {})}
          onSelect={props.onSelect}
          onOpen={props.onOpen}
        />
      )}
      {iface && (
        <InterfacePanel
          map={map}
          iface={iface}
          {...(props.review ? { change: props.review.change } : {})}
          onSelect={props.onSelect}
        />
      )}
      {!component && !iface && <LevelPanel {...props} />}
    </aside>
  );
}
