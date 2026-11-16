import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { PatientProvider } from './contexts/PatientContext';
import './index.css';
import { registerServiceWorker } from './lib/pwa';

// PWA Service Worker の起動・オフラインアセット保護
registerServiceWorker();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <PatientProvider>
      <App />
    </PatientProvider>
  </React.StrictMode>
);
