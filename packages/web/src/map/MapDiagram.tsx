// SVG drawing of one laid-out level: the opened component as a frame with
// boundary ports, its parts and neighbours as UML component boxes, provided
// interfaces as lollipops on the left, required ones as sockets on the right,
// and the connectors between them.
import type { ElkExtendedEdge, ElkNode, ElkPort } from "elkjs/lib/elk-api.js";
import type { Level, LevelPort } from "./levels.js";
import { visibleChildren } from "./levels.js";
import { subtitle } from "./layout.js";
import type { ChangeStatus, ResolvedMap } from "./types.js";

/** A review's change on the drawn level (see review.ts). */
export interface DiagramMarks {
  edges: Map<string, ChangeStatus>;
  counts: Map<string, { changed: number; reviewed: number }>;
  touched: Set<string>;
  surfaces: Set<string>;
}

export interface DiagramProps {
  map: ResolvedMap;
  level: Level;
  layout: ElkNode;
  hl: Set<string>;
  keep: Set<string>;
  marks?: DiagramMarks;
  onSelectNode: (id: string) => void;
  onSelectIface: (id: string) => void;
  onOpen: (id: string) => void;
}

const cls = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(" ");
const truncate = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 2)}…` : text);

function Glyph({ x, y }: { x: number; y: number }) {
  return (
    <g className="glyph" aria-hidden>
      <rect x={x} y={y} width={14} height={11} />
      <rect x={x - 3} y={y + 2} width={6} height={3} />
      <rect x={x - 3} y={y + 6.5} width={6} height={3} />
    </g>
  );
}

function PortShape({
  port,
  meta,
  ox,
  oy,
  name,
}: {
  port: ElkPort;
  meta: LevelPort;
  ox: number;
  oy: number;
  name: string;
}) {
  const x = ox + port.x!;
  const cy = oy + port.y! + port.height! / 2;
  if (meta.boundary && meta.role === "provide") {
    return (
      <>
        <line className="stem" x1={x - 6} y1={cy} x2={x} y2={cy} />
        <circle className="ball" cx={x - 11} cy={cy} r={5} />
        <rect className="box" x={x} y={cy - 6} width={12} height={12} />
        <text x={x - 20} y={cy - 8} textAnchor="end">
          {name}
        </text>
      </>
    );
  }
  if (meta.boundary) {
    return (
      <>
        <line className="stem" x1={x + 12} y1={cy} x2={x + 18} y2={cy} />
        <path className="cup" d={`M${x + 25} ${cy - 7} A7 7 0 0 0 ${x + 25} ${cy + 7}`} />
        <rect className="box" x={x} y={cy - 6} width={12} height={12} />
        <text x={x + 34} y={cy - 8}>
          {name}
        </text>
      </>
    );
  }
  if (meta.role === "provide") {
    return (
      <>
        <line className="stem" x1={x + 10} y1={cy} x2={x + 16} y2={cy} />
        <circle className="ball" cx={x + 5} cy={cy} r={5} />
        <text x={x + 22} y={cy + 4}>
          {name}
        </text>
      </>
    );
  }
  return (
    <>
      <line className="stem" x1={x} y1={cy} x2={x + 5} y2={cy} />
      <path className="cup" d={`M${x + 12} ${cy - 7} A7 7 0 0 0 ${x + 12} ${cy + 7}`} />
      <text x={x - 6} y={cy + 4} textAnchor="end">
        {name}
      </text>
    </>
  );
}

function Ports({ node, ox, oy, props }: { node: ElkNode; ox: number; oy: number; props: DiagramProps }) {
  const names = new Map(props.map.interfaces.map((i) => [i.id, i.name]));
  return (
    <>
      {node.ports!.map((port) => {
        const meta = props.level.ports.get(port.id)!;
        return (
          <g
            key={port.id}
            className={cls(
              "d-port",
              props.hl.has(port.id) && "hl",
              props.marks?.touched.has(meta.iface) && "touched",
              props.marks?.surfaces.has(meta.iface) && "surface",
            )}
            data-port={port.id}
            data-iface={meta.iface}
            onClick={(e) => {
              e.stopPropagation();
              props.onSelectIface(meta.iface);
            }}
          >
            <PortShape port={port} meta={meta} ox={ox} oy={oy} name={names.get(meta.iface)!} />
          </g>
        );
      })}
    </>
  );
}

function Leaf({
  node,
  ox,
  oy,
  role,
  props,
}: {
  node: ElkNode;
  ox: number;
  oy: number;
  role: string;
  props: DiagramProps;
}) {
  const component = props.map.components.find((c) => c.id === node.id)!;
  const x = ox + node.x!;
  const y = oy + node.y!;
  const sub = subtitle(props.map, node.id);
  const parts = visibleChildren(props.map, node.id).length;
  const count = props.marks?.counts.get(node.id);
  return (
    <g
      className={cls(
        "d-node",
        role,
        component.external && "external",
        count && "changed",
        props.hl.has(node.id) && "hl",
        props.keep.has(node.id) && "keep",
      )}
      data-node={node.id}
      onClick={(e) => {
        e.stopPropagation();
        props.onSelectNode(node.id);
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (parts) props.onOpen(node.id);
      }}
    >
      <rect className="body" x={x} y={y} width={node.width} height={node.height} rx={3} />
      {count && (
        <text className="chg" x={x + 2} y={y - 6}>
          {`${count.changed} changed · ${count.reviewed} reviewed`}
        </text>
      )}
      <Glyph x={x + node.width! - 22} y={y + 9} />
      <text className="name" x={x + node.width! / 2} y={y + 24} textAnchor="middle">
        {component.name}
      </text>
      {sub && (
        <text className={cls("sub", parts > 0 && "open")} x={x + node.width! / 2} y={y + 39} textAnchor="middle">
          {sub}
        </text>
      )}
      <Ports node={node} ox={x} oy={y} props={props} />
    </g>
  );
}

function Edges({ edges, ox, oy, props }: { edges: ElkExtendedEdge[]; ox: number; oy: number; props: DiagramProps }) {
  const names = new Map(props.map.interfaces.map((i) => [i.id, i.name]));
  return (
    <>
      {edges.map((e) => {
        const meta = props.level.edges.get(e.id)!;
        const change = props.marks?.edges.get(e.id);
        const paths = e.sections!.map((s) =>
          [
            "M",
            ...[s.startPoint, ...(s.bendPoints ?? []), s.endPoint].map((p) => `${p.x + ox},${p.y + oy}`).join(" L"),
          ].join(""),
        );
        return (
          <g
            key={e.id}
            className={cls(
              "d-edge",
              meta.kind,
              meta.crossProcess && "cross",
              change && `chg-${change}`,
              props.hl.has(e.id) && "hl",
            )}
            data-edge={e.id}
            data-iface={meta.iface}
            onClick={(ev) => {
              ev.stopPropagation();
              props.onSelectIface(meta.iface);
            }}
          >
            <title>{`${names.get(meta.iface)} (${meta.kind}${meta.crossProcess ? ", cross-process" : ""}${change ? `, ${change} in this change` : ""})`}</title>
            {paths.map((d, i) => (
              <g key={i}>
                <path className="vis" d={d} />
                <path className="hit" d={d} />
              </g>
            ))}
          </g>
        );
      })}
    </>
  );
}

function Frame({ node, props }: { node: ElkNode; props: DiagramProps }) {
  const component = props.map.components.find((c) => c.id === node.id)!;
  return (
    <>
      <g className="d-frame">
        <rect className="body" x={node.x} y={node.y} width={node.width} height={node.height} rx={6} />
        <text className="title" x={node.x! + 16} y={node.y! + 26}>
          {component.name}
        </text>
        <text className="meaning" x={node.x! + 16} y={node.y! + 42}>
          {truncate(component.meaning, 90)}
        </text>
      </g>
      <Edges edges={node.edges!} ox={node.x!} oy={node.y!} props={props} />
      {node.children!.map((c) => (
        <Leaf key={c.id} node={c} ox={node.x!} oy={node.y!} role="child" props={props} />
      ))}
      <Ports node={node} ox={node.x!} oy={node.y!} props={props} />
    </>
  );
}

export function MapDiagram(props: DiagramProps) {
  const P = props.level.id;
  const nodes = props.layout.children!;
  const frame = nodes.find((n) => n.id === P);
  return (
    <>
      {frame && <Frame node={frame} props={props} />}
      <Edges edges={props.layout.edges!} ox={0} oy={0} props={props} />
      {nodes
        .filter((n) => n !== frame)
        .map((n) => (
          <Leaf key={n.id} node={n} ox={0} oy={0} role={P === null ? "child" : "neighbor"} props={props} />
        ))}
    </>
  );
}

export function Legend({ review = false }: { review?: boolean }) {
  return (
    <div className="cmap-legend" aria-label="Legend">
      {review && (
        <>
          <span className="chg-new">
            <svg viewBox="0 0 34 14" aria-hidden>
              <line x1={0} y1={7} x2={34} y2={7} stroke="currentColor" strokeWidth={2.2} />
            </svg>
            new in this change
          </span>
          <span className="chg-removed">
            <svg viewBox="0 0 34 14" aria-hidden>
              <line x1={0} y1={7} x2={34} y2={7} stroke="currentColor" strokeDasharray="2 4" />
            </svg>
            removed
          </span>
        </>
      )}
      <span>
        <svg viewBox="0 0 34 14" aria-hidden>
          <circle cx={27} cy={7} r={5} fill="none" stroke="currentColor" />
          <line x1={6} y1={7} x2={22} y2={7} stroke="currentColor" />
        </svg>
        provides
      </span>
      <span>
        <svg viewBox="0 0 34 14" aria-hidden>
          <path d="M14 0 A7 7 0 0 0 14 14" fill="none" stroke="currentColor" />
        </svg>
        requires
      </span>
      <span>
        <svg viewBox="0 0 34 14" aria-hidden>
          <line x1={0} y1={7} x2={34} y2={7} stroke="currentColor" strokeDasharray="5 4" />
        </svg>
        delegates to a part
      </span>
      <span>
        <svg viewBox="0 0 34 14" aria-hidden>
          <line x1={0} y1={7} x2={34} y2={7} stroke="currentColor" strokeDasharray="1.5 3" strokeWidth={1.8} />
        </svg>
        cross-process
      </span>
      <span className="bad">
        <svg viewBox="0 0 34 14" aria-hidden>
          <line x1={0} y1={7} x2={34} y2={7} stroke="currentColor" strokeWidth={1.8} strokeDasharray="7 3" />
        </svg>
        undeclared use
      </span>
    </div>
  );
}
