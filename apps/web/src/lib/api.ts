import type { Exploration, NewExploration } from '@simsam/models';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path} failed with ${res.status}`);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export const listExplorations = () => request<Exploration[]>('/api/explorations');

export const saveExploration = (body: NewExploration) =>
  request<Exploration>('/api/explorations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

export const deleteExploration = (id: number) =>
  request<void>(`/api/explorations/${id}`, { method: 'DELETE' });

export const updateExploration = (id: number, body: NewExploration) =>
  request<Exploration>(`/api/explorations/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
