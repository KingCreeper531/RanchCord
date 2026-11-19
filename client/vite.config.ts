import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const target = process.env.RANCHCORD_SERVER ?? 'http://localhost:6420';

export default defineConfig({
  plugins: [react()],
  base: '/',
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': target,
      '/files': target,
      '/downloads': target,
      '/socket.io': { target, ws: true },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 2000,
  },
});
