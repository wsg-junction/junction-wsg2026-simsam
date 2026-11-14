import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { Button } from '@heroui/react';
import type { TopicGraph as Graph } from '../lib/wikipedia';
import { prefersReducedMotion } from '../lib/motion';

/** Horizontal distance between steps (columns), and vertical distance between rows, in world units. */
const COL = 210;
const ROW = 46;
/** Dot radius by depth, in screen pixels. */
const DOT = [9, 6, 4.5, 4, 3.5, 3.5];
const LABEL_SIZE = [16, 13, 12, 11.5, 11, 11];
/** Labels longer than this are shortened on the map (the full title is in the preview and for screen readers). */
const LABEL_CHARS = 26;
const MIN_K = 0.25;
const MAX_K = 3;
/** Crossing-reduction passes. */
const SWEEPS = 6;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const edgeKey = (a: string, b: string) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);
const shorten = (t: string) => (t.length > LABEL_CHARS ? `${t.slice(0, LABEL_CHARS - 1).trimEnd()}…` : t);

interface Placed {
  id: string;
  depth: number;
  x: number;
  y: number;
}

/**
 * A layered ("topological") layout: the center on the left, one column per
 * step outward. The map is a tree (each topic hangs off the one it was found
 * from) plus a few cross links. Children sit in a contiguous block centered on
 * their parent, so tree lines never cross; sibling order is then tuned so that
 * cross links bridge as little of the map as possible (a barycenter heuristic,
 * as in Sugiyama-style layouts, applied to whole subtrees).
 */
function layout(graph: Graph): { placed: Map<string, Placed>; height: number; columns: number } {
  const byId = new Map(graph.nodes.map((n) => [n.title, n]));
  const children = new Map<string, string[]>();
  for (const n of graph.nodes) {
    if (n.title === graph.center) continue;
    // A topic whose parent isn't on the map hangs off the center.
    const parent = n.parent && byId.has(n.parent) ? n.parent : graph.center;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent)!.push(n.title);
  }
  const cross = graph.edges.filter((e) => e.kind === 'cross');
  const partners = new Map<string, string[]>();
  for (const e of cross) {
    for (const [a, b] of [
      [e.source, e.target],
      [e.target, e.source],
    ]) {
      if (!partners.has(a)) partners.set(a, []);
      partners.get(a)!.push(b);
    }
  }

  const y = new Map<string, number>();
  const assign = () => {
    let slot = 0;
    const place = (id: string): number => {
      const kids = children.get(id) ?? [];
      if (kids.length === 0) {
        y.set(id, slot++ * ROW);
      } else {
        const ys = kids.map(place);
        y.set(id, (ys[0] + ys[ys.length - 1]) / 2);
      }
      return y.get(id)!;
    };
    place(graph.center);
  };

  const subtree = (id: string, into = new Set<string>()) => {
    into.add(id);
    for (const c of children.get(id) ?? []) subtree(c, into);
    return into;
  };

  for (let sweep = 0; sweep < SWEEPS; sweep++) {
    assign();
    for (const [parent, kids] of children) {
      if (kids.length < 2) continue;
      const bary = new Map<string, number>();
      for (const kid of kids) {
        const inside = subtree(kid);
        const outside = [...inside].flatMap((id) => (partners.get(id) ?? []).filter((p) => !inside.has(p)));
        bary.set(kid, outside.length ? outside.reduce((s, p) => s + (y.get(p) ?? 0), 0) / outside.length : y.get(kid)!);
      }
      children.set(parent, [...kids].sort((a, b) => bary.get(a)! - bary.get(b)!));
    }
  }
  assign();

  const placed = new Map<string, Placed>();
  let maxY = 0;
  let columns = 0;
  for (const n of graph.nodes) {
    const ny = y.get(n.title);
    if (ny === undefined) continue;
    placed.set(n.title, { id: n.title, depth: n.depth, x: n.depth * COL, y: ny });
    maxY = Math.max(maxY, ny);
    columns = Math.max(columns, n.depth);
  }
  return { placed, height: maxY, columns };
}

/** A tree edge: a horizontal S-curve from parent to child. */
const treePath = (a: Placed, b: Placed) => {
  const mid = (a.x + b.x) / 2;
  return `M${a.x},${a.y} C${mid},${a.y} ${mid},${b.y} ${b.x},${b.y}`;
};

/** A cross edge: bows out to the right of both ends, away from the tree lines between columns. */
const crossPath = (a: Placed, b: Placed) => {
  const bulge = Math.max(a.x, b.x) + COL * 0.35;
  return `M${a.x},${a.y} C${bulge},${a.y} ${bulge},${b.y} ${b.x},${b.y}`;
};

function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ width, height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, size] as const;
}

interface Props {
  graph: Graph;
  selected: string;
  onSelect: (title: string) => void;
}

interface View {
  x: number;
  y: number;
  k: number;
  /** Ease into the new view (buttons, fitting) rather than following the pointer. */
  animate: boolean;
}

type Gesture = { startX: number; startY: number; viewX: number; viewY: number; moved: boolean; node?: string };

/**
 * The topic map: the center article on the left and up to five steps of
 * related topics expanding to the right. Drag to pan, scroll to zoom.
 */
export function TopicGraph({ graph, selected, onSelect }: Props) {
  const [box, { width, height }] = useSize<HTMLDivElement>();
  const svgRef = useRef<SVGSVGElement>(null);
  const reduced = useMemo(prefersReducedMotion, []);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1, animate: false });
  const viewTouched = useRef(false);
  const gesture = useRef<Gesture | null>(null);
  const [dragging, setDragging] = useState(false);
  const [hovered, setHovered] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);

  const byTitle = useMemo(() => new Map(graph.nodes.map((n) => [n.title, n])), [graph]);
  const { placed, height: treeHeight, columns } = useMemo(() => layout(graph), [graph]);

  // The opening view reads like a page: the full height at a readable size,
  // the center's label in view on the left, further steps a pan to the right.
  // "Fit map" shows everything.
  const centerLabel = Math.min(graph.center.length * LABEL_SIZE[0] * 0.55, 220) + DOT[0] + 16;
  const fit = (whole: boolean, animate: boolean) => {
    if (!width || !height) return;
    const center = placed.get(graph.center);
    if (whole) {
      const k = clamp(
        Math.min((width - centerLabel - 90) / Math.max(columns * COL, 1), (height - 60) / Math.max(treeHeight + 60, 1)),
        MIN_K,
        1.1,
      );
      setView({ x: centerLabel, y: (height - treeHeight * k) / 2, k, animate: animate && !reduced });
      return;
    }
    const k = clamp((height - 120) / Math.max(treeHeight + 60, 1), 0.6, 1);
    setView({ x: centerLabel, y: height / 2 - (center?.y ?? 0) * k, k, animate: animate && !reduced });
  };
  useEffect(() => {
    if (!viewTouched.current) fit(false, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width, height, placed]);

  const zoomAt = (px: number, py: number, factor: number, animate: boolean) => {
    viewTouched.current = true;
    setView((v) => {
      const k = clamp(v.k * factor, MIN_K, MAX_K);
      const f = k / v.k;
      return { k, x: px - (px - v.x) * f, y: py - (py - v.y) * f, animate: animate && !reduced };
    });
  };

  // Wheel zoom needs a non-passive listener so the page doesn't scroll as well.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = svg.getBoundingClientRect();
      zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015), false);
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onPointerDown(e: PointerEvent<SVGSVGElement>) {
    if (e.button !== 0) return;
    const node = (e.target as Element).closest('[data-node]')?.getAttribute('data-node') ?? undefined;
    e.currentTarget.setPointerCapture(e.pointerId);
    gesture.current = { startX: e.clientX, startY: e.clientY, viewX: view.x, viewY: view.y, moved: false, node };
  }

  function onPointerMove(e: PointerEvent<SVGSVGElement>) {
    const g = gesture.current;
    if (!g) return;
    if (!g.moved) {
      if (Math.hypot(e.clientX - g.startX, e.clientY - g.startY) < 4) return;
      g.moved = true;
      setDragging(true);
    }
    viewTouched.current = true;
    setView((v) => ({ ...v, x: g.viewX + e.clientX - g.startX, y: g.viewY + e.clientY - g.startY, animate: false }));
  }

  function onPointerUp() {
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    setDragging(false);
    // A press without movement is a click.
    if (!g.moved && g.node) onSelect(g.node);
  }

  function onNodeKey(e: KeyboardEvent<SVGGElement>, id: string) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect(id);
    }
  }

  // The route from the center to the selected topic is drawn in brass.
  const route = useMemo(() => {
    const nodes = new Set<string>();
    const edges = new Set<string>();
    let cur = byTitle.get(selected);
    while (cur) {
      nodes.add(cur.title);
      if (!cur.parent) break;
      edges.add(edgeKey(cur.title, cur.parent));
      cur = byTitle.get(cur.parent);
    }
    return { nodes, edges };
  }, [byTitle, selected]);

  // Dots and labels keep a constant on-screen size; zooming spreads topics apart.
  const s = 1 / view.k;
  const labelVisible = (id: string, depth: number) =>
    // Zoomed out, columns are too close for every label on the route: the route stays brass, the selected topic keeps its label.
    depth <= 1 || id === selected || id === hovered || id === focused || view.k >= 0.6;
  // Cross links are secondary ("also related to"): drawn for the topic in hand only, so they never clutter the map.
  const inHand = new Set([selected, hovered, focused].filter((t): t is string => Boolean(t) && t !== graph.center));

  const nodes = [...placed.values()].sort(
    (a, b) => Number(route.nodes.has(a.id)) - Number(route.nodes.has(b.id)) || b.depth - a.depth,
  );
  const edges = graph.edges
    .map((e) => ({ ...e, a: placed.get(e.source), b: placed.get(e.target) }))
    .filter((e): e is typeof e & { a: Placed; b: Placed } => Boolean(e.a && e.b))
    .filter((e) => e.kind === 'tree' || inHand.has(e.source) || inHand.has(e.target))
    // Cross links first, so tree lines draw over them.
    .sort((p, q) => Number(p.kind === 'tree') - Number(q.kind === 'tree'));

  const groupStyle: CSSProperties = {
    transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`,
    transition: view.animate ? 'transform 500ms cubic-bezier(0.3, 0.7, 0.2, 1)' : 'none',
  };

  return (
    <div ref={box} className="relative h-full min-h-[28rem] w-full">
      <svg
        ref={svgRef}
        role="group"
        aria-label={`Topic map around ${graph.center}`}
        className={`absolute inset-0 h-full w-full touch-none select-none ${dragging ? 'cursor-grabbing' : 'cursor-grab'}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <g style={groupStyle}>
          {/* One faint guide per step outward. */}
          {Array.from({ length: columns }, (_, i) => (
            <line
              key={i}
              className="graph-ring"
              vectorEffect="non-scaling-stroke"
              x1={(i + 1) * COL}
              x2={(i + 1) * COL}
              y1={-ROW}
              y2={treeHeight + ROW}
            />
          ))}

          {edges.map((e) => {
            const onRoute = e.kind === 'tree' && route.edges.has(edgeKey(e.source, e.target));
            // Draw left to right regardless of how the edge was found.
            const [a, b] = e.a.x <= e.b.x ? [e.a, e.b] : [e.b, e.a];
            return (
              <path
                key={edgeKey(e.source, e.target)}
                d={e.kind === 'tree' ? treePath(a, b) : crossPath(a, b)}
                className={`survey-line graph-edge ${e.kind === 'cross' ? 'graph-edge--cross' : ''} ${
                  onRoute ? 'survey-line--active' : ''
                }`}
                vectorEffect="non-scaling-stroke"
              />
            );
          })}

          {nodes.map((n) => {
            const isCenter = n.depth === 0;
            const isSelected = n.id === selected;
            const r = DOT[n.depth] * s;
            const size = LABEL_SIZE[n.depth] * s;
            const strong = isSelected || n.id === hovered || n.id === focused;
            return (
              <g
                key={n.id}
                data-node={n.id}
                role="button"
                tabIndex={0}
                aria-label={isCenter ? `${n.id}, center` : `${n.id}, ${n.depth} ${n.depth === 1 ? 'step' : 'steps'} from the center`}
                aria-current={isSelected ? 'true' : undefined}
                transform={`translate(${n.x} ${n.y})`}
                className="graph-node node-in cursor-pointer"
                onKeyDown={(e) => onNodeKey(e, n.id)}
                onPointerEnter={() => setHovered(n.id)}
                onPointerLeave={() => setHovered((h) => (h === n.id ? null : h))}
                onFocus={() => setFocused(n.id)}
                onBlur={() => setFocused((f) => (f === n.id ? null : f))}
              >
                <circle r={Math.max(r + 8 * s, 14 * s)} className="fill-transparent" />
                <circle
                  r={r}
                  vectorEffect="non-scaling-stroke"
                  className={`graph-dot ${isCenter ? 'graph-dot--center' : ''} ${
                    isSelected ? 'graph-dot--selected' : route.nodes.has(n.id) ? 'graph-dot--route' : ''
                  }`}
                />
                {labelVisible(n.id, n.depth) && (
                  // Labels sit above their dot, centered, clear of the lines that leave it sideways.
                  <text
                    x={isCenter ? -(r + 8 * s) : 0}
                    y={isCenter ? size * 0.35 : -(r + 5 * s)}
                    textAnchor={isCenter ? 'end' : 'middle'}
                    fontSize={size}
                    strokeWidth={4 * s}
                    className={`graph-label ${isCenter ? 'graph-label--center' : ''} ${strong ? 'graph-label--strong' : ''}`}
                  >
                    {isCenter || strong ? n.id : shorten(n.id)}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>

      <div className="absolute right-3 bottom-3 flex gap-1">
        <Button isIconOnly size="sm" variant="secondary" aria-label="Zoom in" onPress={() => zoomAt(width / 2, height / 2, 1.4, true)}>
          <PlusIcon />
        </Button>
        <Button isIconOnly size="sm" variant="secondary" aria-label="Zoom out" onPress={() => zoomAt(width / 2, height / 2, 1 / 1.4, true)}>
          <MinusIcon />
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onPress={() => {
            viewTouched.current = true;
            fit(true, true);
          }}
        >
          Fit map
        </Button>
      </div>
    </div>
  );
}

function PlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function MinusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <path d="M5 12h14" />
    </svg>
  );
}
