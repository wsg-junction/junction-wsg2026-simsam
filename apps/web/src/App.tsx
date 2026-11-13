import { useEffect, useState, type FormEvent } from 'react';
import type { Health, Item, NewItem } from '@simsam/models';

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [name, setName] = useState('');

  useEffect(() => {
    fetch('/api/health').then((r) => r.json()).then(setHealth);
    fetch('/api/items').then((r) => r.json()).then(setItems);
  }, []);

  async function addItem(e: FormEvent) {
    e.preventDefault();
    const body: NewItem = { name };
    const res = await fetch('/api/items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) return;
    const item: Item = await res.json();
    setItems((prev) => [...prev, item]);
    setName('');
  }

  return (
    <main style={{ fontFamily: 'system-ui', padding: 24 }}>
      <h1>simsam</h1>
      <p>API: {health ? `${health.status} (${health.timestamp})` : 'loading…'}</p>
      <form onSubmit={addItem}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New item" />
        <button type="submit" disabled={!name.trim()}>
          Add
        </button>
      </form>
      <ul>
        {items.map((item) => (
          <li key={item.id}>{item.name}</li>
        ))}
      </ul>
    </main>
  );
}
