import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { HandsFreeProvider } from './lib/handsfree';
import '@fontsource-variable/newsreader';
import '@fontsource-variable/public-sans';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HandsFreeProvider>
      <App />
    </HandsFreeProvider>
  </StrictMode>,
);
