import { memo } from 'react';

// A quiet, decorative network of real Wikipedia topics behind the canvas.
// Generated once from a fixed seed so it looks the same on every visit.

const LABELS = [
  'Silk Road',
  'Printing press',
  'Photosynthesis',
  'Byzantine Empire',
  'Plate tectonics',
  'Jazz',
  'Cartography',
  'Alan Turing',
  'Coral reef',
  'Renaissance',
  'Black hole',
  'Monsoon',
];

const WIDTH = 160;
const HEIGHT = 100;

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildNetwork() {
  const rand = mulberry32(7);
  const points = Array.from({ length: 38 }, () => ({
    x: 6 + rand() * (WIDTH - 12),
    y: 6 + rand() * (HEIGHT - 12),
  }));
  const seen = new Set<string>();
  const edges: [number, number][] = [];
  points.forEach((p, i) => {
    points
      .map((q, j) => ({ j, d: (p.x - q.x) ** 2 + (p.y - q.y) ** 2 }))
      .filter(({ j }) => j !== i)
      .sort((a, b) => a.d - b.d)
      .slice(0, 2)
      .forEach(({ j }) => {
        const key = i < j ? `${i}-${j}` : `${j}-${i}`;
        if (!seen.has(key)) {
          seen.add(key);
          edges.push([i, j]);
        }
      });
  });
  return { points, edges };
}

const { points, edges } = buildNetwork();

export const AtlasBackdrop = memo(function AtlasBackdrop({ dimmed }: { dimmed: boolean }) {
  return (
    <svg
      aria-hidden
      className={`backdrop pointer-events-none absolute inset-0 h-full w-full transition-opacity duration-500 motion-reduce:transition-none ${
        dimmed ? 'opacity-10' : 'backdrop--opening opacity-100'
      }`}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="xMidYMid slice"
    >
      <g>
        {edges.map(([a, b], i) => (
          <line
            key={i}
            className="survey-line draw-in"
            style={{ '--i': i % 24 } as React.CSSProperties}
            pathLength={1}
            x1={points[a].x}
            y1={points[a].y}
            x2={points[b].x}
            y2={points[b].y}
          />
        ))}
        {points.map((p, i) => (
          <circle key={i} className="survey-node" cx={p.x} cy={p.y} r={i < LABELS.length ? 0.9 : 0.55} />
        ))}
        {!dimmed && LABELS.map((label, i) => (
          <text
            key={label}
            className="survey-label max-sm:hidden"
            x={points[i].x + 1.6}
            y={points[i].y + 0.6}
            fontSize={1.7}
          >
            {label}
          </text>
        ))}
      </g>
    </svg>
  );
});
