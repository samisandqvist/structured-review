import { useShape } from "../api/hooks.js";
import type { ChangeShape, Criticality, ShapeFile } from "../api/client.js";

type ShapeComponent = ChangeShape["components"][number];

/** Orientation before the walk: which components the change touches, which of
 *  their contracts changed, and which consumers of those contracts the change
 *  leaves untouched. Shown while no node is selected. Tool-derived; no model text. */
export function ChangeShapeView({ sessionId }: { sessionId: string }) {
  const { data: shape } = useShape(sessionId);
  return (
    <div className="shape" data-testid="change-shape">
      {shape && <ShapeBody shape={shape} />}
      <div className="shape__start">
        <h2 className="shape__start-title">Pick a node to start the walk</h2>
        <p className="shape__hint">Pick a unit&apos;s node to read its diff and leave a comment.</p>
      </div>
    </div>
  );
}

function ShapeBody({ shape }: { shape: ChangeShape }) {
  const files = shape.components.reduce((n, c) => n + c.files.length, 0) + shape.unassigned.length;
  const contracts = shape.components.reduce((n, c) => n + c.changedContracts.length, 0);
  return (
    <>
      <header className="shape__head">
        <h2 className="shape__title">Shape of the change</h2>
        <span className="shape__badge" title={sourceTitle(shape.source)}>
          {shape.source === "manifest" ? "component manifest" : "inferred components"}
        </span>
      </header>
      <p className="shape__summary" data-testid="shape-summary">
        {plural(files, "file")} in {plural(shape.components.length, "component")}
        {contracts > 0 && ` · ${plural(contracts, "contract")} changed`}
        {shape.outsideConsumers.length > 0 &&
          ` · ${plural(shape.outsideConsumers.length, "consumer")} outside the change`}
      </p>
      {shape.warnings.map((w) => (
        <div key={w} className="shape__warning">
          ⚠ {w}
        </div>
      ))}
      <ul className="shape__list">
        {shape.components.map((c) => (
          <ComponentCard key={c.id} component={c} />
        ))}
      </ul>
      {shape.outsideConsumers.length > 0 && (
        <section data-testid="shape-outside">
          <h3 className="shape__section">Outside the change</h3>
          <p className="shape__hint">
            These components consume a contract the change modifies. Their code is unchanged; check that it still
            matches.
          </p>
          <ul className="shape__list">
            {shape.outsideConsumers.map((o) => (
              <li key={o.id} className="shape__card shape__card--outside">
                <CardTitle id={o.id} criticality={o.criticality} description={o.description} />
                <div className="shape__line">
                  uses {o.via.map((v) => `${v.contracts.join(", ")} of ${v.component}`).join("; ")}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      {shape.unassigned.length > 0 && (
        <section data-testid="shape-unassigned">
          <h3 className="shape__section">Not in any component</h3>
          <FileList files={shape.unassigned} />
        </section>
      )}
    </>
  );
}

function ComponentCard({ component: c }: { component: ShapeComponent }) {
  return (
    <li className="shape__card" data-testid="shape-component">
      <CardTitle id={c.id} criticality={c.criticality} description={c.description} />
      <div className="shape__line">{statusCounts(c.files)}</div>
      {c.changedContracts.length > 0 && (
        <div className="shape__line">
          contracts changed:{" "}
          {c.changedContracts.map((k) => (
            <span key={k} className="shape__tag shape__tag--contract">
              {k}
            </span>
          ))}
        </div>
      )}
      {c.newDirectories.length > 0 && <div className="shape__line">new directories: {c.newDirectories.join(", ")}</div>}
      {c.consumers.length > 0 && (
        <div className="shape__line">
          consumers:{" "}
          {c.consumers.map((x) => (
            <span key={x.id} className={`shape__tag${x.inChange ? "" : " shape__tag--outside"}`}>
              {x.id} {x.inChange ? "(in change)" : "(outside)"}
            </span>
          ))}
        </div>
      )}
      <details className="shape__files">
        <summary>files</summary>
        <FileList files={c.files} />
      </details>
    </li>
  );
}

function CardTitle({
  id,
  criticality,
  description,
}: {
  id: string;
  criticality: Criticality;
  description?: string | undefined;
}) {
  return (
    <div className="shape__card-title">
      <span className="shape__id">{id}</span>
      <span className={`shape__crit shape__crit--${criticality}`}>{criticality}</span>
      {description && <span className="shape__desc">{description}</span>}
    </div>
  );
}

const STATUS_MARK: Record<ShapeFile["status"], string> = { added: "A", modified: "M", deleted: "D", renamed: "R" };

function FileList({ files }: { files: ShapeFile[] }) {
  return (
    <ul className="shape__file-list">
      {files.map((f) => (
        <li key={f.path} className={`shape__file shape__file--${f.status}`}>
          <span className="shape__file-mark" title={f.status}>
            {STATUS_MARK[f.status]}
          </span>
          {f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
          {f.contract && <span className="shape__tag shape__tag--contract">{f.contract}</span>}
        </li>
      ))}
    </ul>
  );
}

function statusCounts(files: ShapeFile[]): string {
  const counts = new Map<string, number>();
  for (const f of files) counts.set(f.status, (counts.get(f.status) ?? 0) + 1);
  return [...counts].map(([status, n]) => `${n} ${status}`).join(", ");
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function sourceTitle(source: ChangeShape["source"]): string {
  return source === "manifest"
    ? "Components, contracts and consumers come from .review-components.json"
    : "Components are project roots and top-level directories. Add .review-components.json to name components, contracts and consumers.";
}
