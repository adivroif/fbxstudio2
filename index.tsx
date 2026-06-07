
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

// Suppress noisy, harmless library warnings from THREE.FBXLoader about custom/unsupported material maps (e.g. Maya shaders)
const originalWarn = console.warn;
console.warn = (...args: any[]) => {
  if (
    typeof args[0] === 'string' &&
    (args[0].includes('THREE.FBXLoader') ||
     args[0].includes('unknown material type') ||
     args[0].includes('skipping texture'))
  ) {
    return;
  }
  originalWarn(...args);
};

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
