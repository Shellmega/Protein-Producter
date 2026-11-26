import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// PTG-1 spatial scene prototype. The app is intentionally a single browser entry
// (no router yet); PTG-2/3 extend this entry rather than starting a new one.
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    watch: {
      // The editor backend writes through hidden temporary directories; ignore
      // them so the dev server never tries to watch a transient locked file.
      ignored: ['**/*.tmpdir/**', '**/.*.tmpdir/**', '**/*.tmp', '**/.graph-runs/**'],
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
  },
  build: {
    target: 'es2022',
    sourcemap: false,
  },
});
