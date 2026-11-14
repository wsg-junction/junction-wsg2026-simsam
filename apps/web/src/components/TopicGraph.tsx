import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { Button } from '@heroui/react';
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';
import type { TopicGraph as Graph } from '../lib/wikipedia';
import { prefersReducedMotion } from '../lib/motion';

interface Node extends SimulationNodeDatum {
  id: string;
  depth: number;
  degree: number;
  x: number;
  y: number;
}

interface Link extends SimulationLinkDatum<Node> {
  kind: 'tree' | 'cross';
}

const LABEL_SIZE = [16, 13, 12, 11.5, 11, 11];
/** Labels longer than this are shortened on the map (the full title is in the preview and for screen readers). */
const LABEL_CHARS = 24;
const MIN_K = 0.25;
const MAX_K = 3;
const TICKS = 400;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const edgeKey = (a: string, b: string) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);
const shorten = (t: string) => (t.length > LABEL_CHARS ? `${t.slice(0, LABEL_CHARS - 1).trimEnd()}…` : t);
/** Dot radius in screen pixels: the center largest, then by how connected a topic is. */
const dotRadius = (n: { depth: number; degree: number }) => (n.depth === 0 ? 10 : clamp(3 + Math.sqrt(n.degree) * 1.7, 4, 9));

/**
 * A force-directed layout: topics repel each other, relations pull them
 * together, so the shape follows how the topics actually connect rather than
 * a fixed ring or tree. Every relation is a link, including the "also related"
 * ones between branches, which is what makes it a graph. Computed to rest in
 * one go (no jiggling); earlier positions are kept when the map grows.
 */
function layout(graph: Graph, previous: Map<string, { x: number; y: number }>) {
  const degree = new Map<string, number>();
  for (const e of graph.edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }
  const placedBefore = new Map(previous);
  const nodes: Node[] = graph.nodes.map((n, i) => {
    const before = placedBefore.get(n.title);
    const parent = n.parent ? placedBefore.get(n.parent) : undefined;
    // New topics start beside the topic they came from, on a small spiral so none coincide.
    const angle = i * 2.399963;
    const start = before ?? (parent ? { x: parent.x + Math.cos(angle) * 40, y: parent.y + Math.sin(angle) * 40 } : { x: Math.cos(angle) * 30 * Math.sqrt(i), y: Math.sin(angle) * 30 * Math.sqrt(i) });
    return { id: n.title, depth: n.depth, degree: degree.get(n.title) ?? 0, ...start };
  });
  const center = nodes.find((n) => n.id === graph.center);
  if (center) {
    center.fx = 0;
    center.fy = 0;
  }
  const ids = new Set(nodes.map((n) => n.id));
  const links: Link[] = graph.edges
    .filter((e) => ids.has(e.source) && ids.has(e.target))
    .map((e) => ({ source: e.source, target: e.target, kind: e.kind }));

  const sim = forceSimulation<Node, Link>(nodes)
    .force(
      'link',
      forceLink<Node, Link>(links)
        .id((d) => d.id)
        .distance((l) => (l.kind === 'tree' ? 95 + 15 * Math.min((l.target as Node).depth, 3) : 160))
        .strength((l) => (l.kind === 'tree' ? 0.6 : 0.08)),
    )
    .force('charge', forceManyBody<Node>().strength((d) => (d.depth === 0 ? -2200 : d.depth === 1 ? -1000 : -380)).distanceMax(700))
    // Topics that usually carry a label keep room for it.
    .force('collide', forceCollide<Node>((d) => dotRadius(d) + (d.depth <= 1 || d.degree >= 4 ? 44 : 22)).strength(0.9))
    // Pulled in harder sideways than up and down: the panel is tall and narrow.
    .force('x', forceX<Node>(0).strength(0.05))
    .force('y', forceY<Node>(0).strength(0.012))
    .stop();
  // Fewer ticks when most positions are already known.
  sim.alpha(previous.size ? 0.5 : 1).tick(previous.size ? TICKS / 2 : TICKS);
  return { nodes, links };
}

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

type Gesture =
  | { kind: 'pan'; startX: number; startY: number; viewX: number; viewY: number; moved: boolean; node?: string }
  | { kind: 'node'; id: string; startX: number; startY: number; moved: boolean };

/**
 * The topic map: a network of the center article and the topics related to
 * it. Drag the background to pan, drag a topic to move it, scroll to zoom.
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
  const [, setFrame] = useState(0);

  const byTitle = useMemo(() => new Map(graph.nodes.map((n) => [n.title, n])), [graph]);
  const positions = useRef(new Map<string, { x: number; y: number }>());
  const { nodes, links } = useMemo(() => {
    const result = layout(graph, positions.current);
    positions.current = new Map(result.nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
    return result;
  }, [graph]);
  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  // Fit the whole network into the canvas until the reader takes over the view.
  const fit = (animate: boolean) => {
    if (!width || !height || nodes.length === 0) return;
    const xs = nodes.map((n) => n.x);
    const ys = nodes.map((n) => n.y);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    // Room for labels around the edge (labels that don't fit are left out, see shownLabels).
    const padX = 56;
    const padY = 40;
    const k = clamp(Math.min((width - 2 * padX) / Math.max(x1 - x0, 1), (height - 2 * padY) / Math.max(y1 - y0, 1)), MIN_K, 1.2);
    setView({ x: width / 2 - ((x0 + x1) / 2) * k, y: height / 2 - ((y0 + y1) / 2) * k, k, animate: animate && !reduced });
  };
  useEffect(() => {
    if (!viewTouched.current) fit(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width, height, nodes]);

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

  const toWorld = (clientX: number, clientY: number) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: (clientX - r.left - view.x) / view.k, y: (clientY - r.top - view.y) / view.k };
  };

  function onPointerDown(e: PointerEvent<SVGSVGElement>) {
    if (e.button !== 0) return;
    const id = (e.target as Element).closest('[data-node]')?.getAttribute('data-node') ?? undefined;
    e.currentTarget.setPointerCapture(e.pointerId);
    const start = { startX: e.clientX, startY: e.clientY, moved: false };
    gesture.current = id ? { kind: 'node', id, ...start } : { kind: 'pan', viewX: view.x, viewY: view.y, ...start };
  }

  function onPointerMove(e: PointerEvent<SVGSVGElement>) {
    const g = gesture.current;
    if (!g) return;
    if (!g.moved) {
      if (Math.hypot(e.clientX - g.startX, e.clientY - g.startY) < 4) return;
      g.moved = true;
      setDragging(true);
    }
    if (g.kind === 'pan') {
      viewTouched.current = true;
      setView((v) => ({ ...v, x: g.viewX + e.clientX - g.startX, y: g.viewY + e.clientY - g.startY, animate: false }));
    } else {
      // A dragged topic stays where it's put; its links follow.
      const node = nodeById.get(g.id);
      if (!node) return;
      const p = toWorld(e.clientX, e.clientY);
      node.x = p.x;
      node.y = p.y;
      positions.current.set(node.id, p);
      setFrame((f) => f + 1);
    }
  }

  function onPointerUp() {
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    setDragging(false);
    // A press without movement is a click.
    if (!g.moved) {
      const id = g.kind === 'node' ? g.id : g.node;
      if (id) onSelect(id);
    }
  }

  function onNodeKey(e: KeyboardEvent<SVGGElement>, id: string) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect(id);
    }
  }

  // The route from the center to the selected topic is drawn in brass.
  const route = useMemo(() => {
    const ids = new Set<string>();
    const edges = new Set<string>();
    let cur = byTitle.get(selected);
    while (cur) {
      ids.add(cur.title);
      if (!cur.parent) break;
      edges.add(edgeKey(cur.title, cur.parent));
      cur = byTitle.get(cur.parent);
    }
    return { ids, edges };
  }, [byTitle, selected]);

  // Topics next to the one in hand light up with their links.
  const inHand = hovered ?? focused ?? (selected !== graph.center ? selected : null);
  const neighbours = useMemo(() => {
    const set = new Set<string>();
    if (!inHand) return set;
    for (const l of links) {
      const a = (l.source as Node).id;
      const b = (l.target as Node).id;
      if (a === inHand) set.add(b);
      if (b === inHand) set.add(a);
    }
    return set;
  }, [links, inHand]);

  // Dots and labels keep a constant on-screen size; zooming spreads topics apart.
  const s = 1 / view.k;
  const labelText = (n: Node) => (n.depth === 0 || n.id === selected || n.id === inHand ? n.id : shorten(n.id));

  // Labels are placed most important first (the center, the topic in hand and
  // its neighbours, the first step, hubs), skipping any that would overlap one
  // already placed, so whatever shows is readable. Zooming in makes room for more.
  const shownLabels = useMemo(() => {
    const priority = (n: Node) =>
      n.depth === 0 ? 0 : n.id === selected || n.id === inHand ? 1 : neighbours.has(n.id) ? 2 : n.depth === 1 ? 3 : 4 + n.depth - n.degree / 10;
    // Every dot is an obstacle too, so no label sits on another topic.
    const boxes: [number, number, number, number][] = nodes.map((n) => {
      const r = (dotRadius(n) + 2) / view.k;
      return [n.x - r, n.y - r, n.x + r, n.y + r];
    });
    const shown = new Set<string>();
    for (const n of [...nodes].sort((a, b) => priority(a) - priority(b))) {
      const size = LABEL_SIZE[Math.min(n.depth, LABEL_SIZE.length - 1)];
      const w = (labelText(n).length * size * 0.56) / view.k;
      const h = (size * 1.25) / view.k;
      const top = n.y + (dotRadius(n) + 2) / view.k;
      const box: [number, number, number, number] = [n.x - w / 2, top, n.x + w / 2, top + h];
      const clash = boxes.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]);
      // Nor one that would run off the side of the panel.
      const off = width > 0 && (view.x + box[0] * view.k < 4 || view.x + box[2] * view.k > width - 4);
      if ((clash || off) && priority(n) > 1) continue;
      boxes.push(box);
      shown.add(n.id);
    }
    return shown;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, view.k, view.x, width, selected, inHand, neighbours]);
  const labelVisible = (n: Node) => shownLabels.has(n.id);

  const ordered = [...nodes].sort(
    (a, b) =>
      Number(route.ids.has(a.id) || a.id === inHand) - Number(route.ids.has(b.id) || b.id === inHand) || b.depth - a.depth,
  );

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
          {links.map((l) => {
            const a = l.source as Node;
            const b = l.target as Node;
            const key = edgeKey(a.id, b.id);
            const onRoute = route.edges.has(key);
            const lit = inHand !== null && (a.id === inHand || b.id === inHand);
            return (
              <line
                key={key}
                className={`survey-line graph-edge ${l.kind === 'cross' && !lit ? 'graph-edge--cross' : ''} ${
                  onRoute || lit ? 'survey-line--active' : ''
                }`}
                vectorEffect="non-scaling-stroke"
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
              />
            );
          })}

          {ordered.map((n) => {
            const isCenter = n.depth === 0;
            const isSelected = n.id === selected;
            const r = dotRadius(n) * s;
            const size = LABEL_SIZE[Math.min(n.depth, LABEL_SIZE.length - 1)] * s;
            const strong = isSelected || n.id === inHand;
            const dim = inHand !== null && n.id !== inHand && !neighbours.has(n.id) && !route.ids.has(n.id);
            return (
              <g
                key={n.id}
                data-node={n.id}
                role="button"
                tabIndex={0}
                aria-label={isCenter ? `${n.id}, center` : `${n.id}, ${n.depth} ${n.depth === 1 ? 'step' : 'steps'} from the center`}
                aria-current={isSelected ? 'true' : undefined}
                transform={`translate(${n.x} ${n.y})`}
                className={`graph-node node-in cursor-pointer transition-opacity motion-reduce:transition-none ${dim ? 'opacity-40' : ''}`}
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
                    isSelected ? 'graph-dot--selected' : route.ids.has(n.id) ? 'graph-dot--route' : ''
                  }`}
                />
                {labelVisible(n) && (
                  <text
                    x={0}
                    y={r + size * 1.05}
                    textAnchor="middle"
                    fontSize={size}
                    strokeWidth={4 * s}
                    className={`graph-label ${isCenter ? 'graph-label--center' : ''} ${strong ? 'graph-label--strong' : ''}`}
                  >
                    {labelText(n)}
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
            viewTouched.current = false;
            fit(true);
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
