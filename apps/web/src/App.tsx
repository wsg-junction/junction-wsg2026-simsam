import { useEffect, useState } from 'react';
import type { Health, Item } from '@simsam/models';

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [items, setItems] = useState<Item[]>([]);

  useEffect(() => {
    fetch('/api/health').then((r) => r.json()).then(setHealth);
    fetch('/api/items').then((r) => r.json()).then(setItems);
  }, []);

  return (
    <main style={{ fontFamily: 'system-ui', padding: 24 }}>
      <h1>simsam</h1>
      <p>API: {health ? `${health.status} (${health.timestamp})` : 'loading…'}</p>
      <ul>
        {items.map((item) => (
          <li key={item.id}>{item.name}</li>
        ))}
      </ul>
    </main>
  );
}
