import React from 'react';
import ReactDOM from 'react-dom/client';
import './fonts.css';
import App from './App';
import { initPwa } from './services/pwa';

// Before render, so the install prompt and connectivity events are never missed.
initPwa();

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
