import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { Button } from '@heroui/react';
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceRadial,
  forceSimulation,
  type ForceLink,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';
import type { GraphEdge, TopicGraph as Graph } from '../lib/wikipedia';
import { prefersReducedMotion } from '../lib/motion';

interface SimNode extends SimulationNodeDatum {
  id: string;
  depth: number;
  x: number;
  y: number;
}

interface SimLink extends SimulationLinkDatum<SimNode> {
  kind: GraphEdge['kind'];
}

/** Radius of each ring in world units; each ring is one step further from the center. */
const RING = [0, 150, 260, 350, 430, 500];
/** Dot radius by depth, in screen pixels. */
const DOT = [9, 6, 4.5, 4, 3.5, 3.5];
const LABEL_SIZE = [18, 13, 12, 11.5, 11, 11];
const MIN_K = 0.3;
const MAX_K = 3;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const edgeKey = (a: string, b: string) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);

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

type Gesture =
  | { kind: 'pan'; startX: number; startY: number; viewX: number; viewY: number; moved: boolean; node?: string }
  | { kind: 'node'; id: string; startX: number; startY: number; moved: boolean };

interface View {
  x: number;
  y: number;
  k: number;
  /** Ease into the new view (buttons, fitting) rather than following the pointer. */
  animate: boolean;
}

/**
 * The topic map: the center article with up to five rings of related topics
 * around it. Drag the map to pan, drag a topic to move it, scroll to zoom.
 */
export function TopicGraph({ graph, selected, onSelect }: Props) {
  const [box, { width, height }] = useSize<HTMLDivElement>();
  const svgRef = useRef<SVGSVGElement>(null);
  const reduced = useMemo(prefersReducedMotion, []);
  const simRef = useRef<Simulation<SimNode, SimLink> | null>(null);
  const nodesRef = useRef(new Map<string, SimNode>());
  const [links, setLinks] = useState<SimLink[]>([]);
  const [, setFrame] = useState(0);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1, animate: false });
  const viewTouched = useRef(false);
  const gesture = useRef<Gesture | null>(null);
  const [dragging, setDragging] = useState(false);
  const [hovered, setHovered] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);

  const byTitle = useMemo(() => new Map(graph.nodes.map((n) => [n.title, n])), [graph]);

  // One simulation per map; nodes keep their positions as new rings arrive.
  useEffect(() => {
    const sim = forceSimulation<SimNode, SimLink>()
      .force(
        'link',
        forceLink<SimNode, SimLink>()
          .id((d) => d.id)
          .distance((l) => {
            const s = l.source as SimNode;
            const t = l.target as SimNode;
            return l.kind === 'tree' ? Math.abs(RING[t.depth] - RING[s.depth]) * 1.1 : 140;
          })
          .strength((l) => (l.kind === 'tree' ? 0.35 : 0.02)),
      )
      .force('charge', forceManyBody<SimNode>().strength((d) => (d.depth <= 1 ? -320 : -110)).distanceMax(420))
      .force('collide', forceCollide<SimNode>((d) => (d.depth <= 1 ? 34 : d.depth === 2 ? 22 : 14)))
      .force('radial', forceRadial<SimNode>((d) => RING[d.depth], 0, 0).strength(0.9))
      .alphaDecay(0.03)
      .on('tick', () => setFrame((f) => f + 1));
    sim.stop();
    simRef.current = sim;
    return () => {
      sim.stop();
    };
  }, []);

  // Feed new nodes in, each placed on its ring beside the topic it came from.
  useEffect(() => {
    const sim = simRef.current;
    if (!sim) return;
    const map = nodesRef.current;
    const firstRing = graph.nodes.filter((n) => n.depth === 1);
    const siblings = new Map<string, number>();

    for (const n of graph.nodes) {
      if (map.has(n.title)) continue;
      let angle = 0;
      if (n.depth === 1) {
        angle = -Math.PI / 2 + (firstRing.indexOf(n) / firstRing.length) * Math.PI * 2;
      } else if (n.parent) {
        const p = map.get(n.parent);
        const i = siblings.get(n.parent) ?? 0;
        siblings.set(n.parent, i + 1);
        angle = (p ? Math.atan2(p.y, p.x) : 0) + (i - 0.5) * (0.5 / n.depth);
      }
      const node: SimNode = {
        id: n.title,
        depth: n.depth,
        x: Math.cos(angle) * RING[n.depth],
        y: Math.sin(angle) * RING[n.depth],
      };
      if (n.depth === 0) {
        node.fx = 0;
        node.fy = 0;
      }
      map.set(n.title, node);
    }

    const nextLinks: SimLink[] = graph.edges.map((e) => ({ source: e.source, target: e.target, kind: e.kind }));
    sim.nodes([...map.values()]);
    (sim.force('link') as ForceLink<SimNode, SimLink>).links(nextLinks);
    setLinks(nextLinks);

    if (reduced) {
      sim.alpha(1);
      sim.tick(300);
      setFrame((f) => f + 1);
    } else {
      sim.alpha(0.7).restart();
    }
  }, [graph, reduced]);

  // Fit the loaded rings into the canvas until the reader takes over the view.
  const fit = (animate: boolean) => {
    if (!width || !height) return;
    // On phones, frame the inner rings so labels stay readable; the rest is a pan away.
    const phone = window.matchMedia('(max-width: 639px)').matches;
    const extent = RING[phone ? Math.min(graph.depth, 2) : graph.depth] + 90;
    const k = clamp(Math.min(width, height) / (2 * extent), MIN_K, 1.2);
    setView({ x: width / 2, y: height / 2, k, animate: animate && !reduced });
  };
  useEffect(() => {
    if (!viewTouched.current) fit(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width, height, graph.depth]);

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
    // The center stays anchored: dragging it pans the map instead.
    gesture.current =
      id && id !== graph.center
        ? { kind: 'node', id, ...start }
        : { kind: 'pan', viewX: view.x, viewY: view.y, node: id, ...start };
  }

  function onPointerMove(e: PointerEvent<SVGSVGElement>) {
    const g = gesture.current;
    if (!g) return;
    if (!g.moved) {
      if (Math.hypot(e.clientX - g.startX, e.clientY - g.startY) < 4) return;
      g.moved = true;
      setDragging(true);
      if (g.kind === 'node' && !reduced) simRef.current?.alphaTarget(0.25).restart();
    }
    if (g.kind === 'pan') {
      viewTouched.current = true;
      setView((v) => ({ ...v, x: g.viewX + e.clientX - g.startX, y: g.viewY + e.clientY - g.startY, animate: false }));
    } else {
      const node = nodesRef.current.get(g.id);
      if (!node) return;
      const p = toWorld(e.clientX, e.clientY);
      node.fx = p.x;
      node.fy = p.y;
      if (reduced) {
        node.x = p.x;
        node.y = p.y;
        setFrame((f) => f + 1);
      }
    }
  }

  function onPointerUp() {
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    setDragging(false);
    simRef.current?.alphaTarget(0);
    // A press without movement is a click. Dropped topics stay where they were put.
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

  // Keep dots and labels a constant on-screen size; zooming spreads topics apart.
  const s = 1 / view.k;
  const labelVisible = (id: string, depth: number) =>
    depth <= 1 ||
    route.nodes.has(id) ||
    id === hovered ||
    id === focused ||
    (depth === 2 && view.k >= 0.85) ||
    view.k >= 1.3;

  const nodes = [...nodesRef.current.values()].sort(
    (a, b) => Number(route.nodes.has(a.id)) - Number(route.nodes.has(b.id)) || b.depth - a.depth,
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
          {RING.slice(1, graph.depth + 1).map((r) => (
            <circle key={r} r={r} className="graph-ring" vectorEffect="non-scaling-stroke" />
          ))}

          {links.map((l) => {
            const a = l.source as SimNode;
            const b = l.target as SimNode;
            if (typeof a !== 'object' || typeof b !== 'object') return null;
            const onRoute = route.edges.has(edgeKey(a.id, b.id));
            return (
              <line
                key={edgeKey(a.id, b.id)}
                className={`survey-line graph-edge ${l.kind === 'cross' ? 'graph-edge--cross' : ''} ${
                  onRoute ? 'survey-line--active' : ''
                }`}
                vectorEffect="non-scaling-stroke"
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
              />
            );
          })}

          {nodes.map((n) => {
            const isCenter = n.depth === 0;
            const isSelected = n.id === selected;
            const r = DOT[n.depth] * s;
            const size = LABEL_SIZE[n.depth] * s;
            const len = Math.hypot(n.x, n.y) || 1;
            const cos = n.x / len;
            const label: { anchor: 'start' | 'middle' | 'end'; dx: number; dy: number } = isCenter
              ? { anchor: 'middle', dx: 0, dy: r + size * 1.1 }
              : cos > 0.3
                ? { anchor: 'start', dx: r + 6 * s, dy: size * 0.35 }
                : cos < -0.3
                  ? { anchor: 'end', dx: -(r + 6 * s), dy: size * 0.35 }
                  : n.y > 0
                    ? { anchor: 'middle', dx: 0, dy: r + size * 1.1 }
                    : { anchor: 'middle', dx: 0, dy: -(r + size * 0.5) };
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
                  <text
                    x={label.dx}
                    y={label.dy}
                    textAnchor={label.anchor}
                    fontSize={size}
                    strokeWidth={4 * s}
                    className={`graph-label ${isCenter ? 'graph-label--center' : ''} ${
                      isSelected || n.id === hovered ? 'graph-label--strong' : ''
                    }`}
                  >
                    {n.id}
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
