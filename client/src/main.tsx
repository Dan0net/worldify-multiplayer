import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import App from './App';
import { MaterialViewer } from './ui/MaterialViewer';
import { hideNetlifyPreviewBar } from './hideNetlifyPreviewBar';
import './index.css';

// Hide the Netlify deploy-preview bar it injects on preview URLs (no-op elsewhere).
hideNetlifyPreviewBar();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<App />} />
        <Route path="/materials" element={<MaterialViewer />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
);
