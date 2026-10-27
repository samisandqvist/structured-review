// Detail panel of the component map: the opened level (meaning, coverage,
// undeclared uses, hidden utilities, unclaimed files, index gaps), a selected
// component (files, interfaces, type-only dependencies) or a selected
// interface (bound functions or evidence, call sites by requirer).
import type { CallSite, ResolvedComponent, ResolvedInterface, ResolvedMap } from "./types.js";
import { requirersOf, undeclaredFindings, visibleChildren, type Selection } from "./levels.js";

export interface PanelProps {
  map: ResolvedMap;
  level: string | null;
  connections: number;
  selection: Selection;
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

function LevelPanel({ map, level, connections, onOpen }: PanelProps) {
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
  onSelect,
  onOpen,
}: { map: ResolvedMap; component: ResolvedComponent } & Pick<PanelProps, "onSelect" | "onOpen">) {
  const parts = visibleChildren(map, component.id);
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

function InterfacePanel({
  map,
  iface,
  onSelect,
}: { map: ResolvedMap; iface: ResolvedInterface } & Pick<PanelProps, "onSelect">) {
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
      {component && <ComponentPanel map={map} component={component} onSelect={props.onSelect} onOpen={props.onOpen} />}
      {iface && <InterfacePanel map={map} iface={iface} onSelect={props.onSelect} />}
      {!component && !iface && <LevelPanel {...props} />}
    </aside>
  );
}
