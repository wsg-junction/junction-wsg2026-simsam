export interface Health {
  status: 'ok';
  timestamp: string;
}

export interface Item {
  id: number;
  name: string;
  createdAt: string;
}

export interface NewItem {
  name: string;
}
