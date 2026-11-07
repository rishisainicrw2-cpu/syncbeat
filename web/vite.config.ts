import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const target = process.env.VITE_API_TARGET || 'http://localhost:4000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': target,
      '/media': target,
      '/socket.io': { target, ws: true },
    },
  },
  build: { sourcemap: false, chunkSizeWarningLimit: 700 },
});
