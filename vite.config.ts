import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: path.resolve('client'),
  resolve: {
    alias: {
      '@shared': path.resolve('shared'),
    },
  },
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:5174',
    },
  },
  build: {
    outDir: path.resolve('dist'),
    emptyOutDir: true,
  },
});
