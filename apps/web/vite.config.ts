import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Dev proxy so the dashboard reaches the control-plane API same-origin.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
  // Pre-bundle heavy deps at startup so dev doesn't re-optimize mid-flight (which leaves
  // the browser on a stale module hash and renders nothing).
  optimizeDeps: { include: ['@xyflow/react', 'react', 'react-dom', 'lucide-react', 'sonner'] },
  // Same proxy for dev (`vite`) and the prod-like static server (`vite preview`), so the dashboard
  // reaches the control-plane API same-origin either way.
  server: {
    proxy: {
      '/trpc': 'http://127.0.0.1:8787',
      '/api': 'http://127.0.0.1:8787',
    },
  },
  preview: {
    proxy: {
      '/trpc': 'http://127.0.0.1:8787',
      '/api': 'http://127.0.0.1:8787',
    },
  },
});
