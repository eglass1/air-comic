import React from 'react';
import ReactDOM from 'react-dom/client';
import './fonts.css';
import App from './App';
import { initPwa } from './services/pwa';
import { preloadComicFonts } from './comic/fontLoader';

// Early initialization for PWA and comic fonts needed by canvas
initPwa();
preloadComicFonts();

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
