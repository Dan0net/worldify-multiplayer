import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    watch: {
      // Watch the shared package dist for changes (rebuilt by tsc --watch)
      ignored: ['!**/node_modules/@worldify/shared/**'],
    },
  },
  optimizeDeps: {
    // Don't pre-bundle the shared package so changes are picked up immediately
    exclude: ['@worldify/shared'],
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  define: {
    'import.meta.env.VITE_API_BASE': JSON.stringify(process.env.VITE_API_BASE || 'http://localhost:8080'),
    'import.meta.env.VITE_WS_URL': JSON.stringify(process.env.VITE_WS_URL || 'ws://localhost:8080/ws'),
  },
});
