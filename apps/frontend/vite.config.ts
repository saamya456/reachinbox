/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the frontend and the API share one origin through this proxy,
// so the HttpOnly session cookie is sent with every request and no token ever
// has to live in JavaScript. The OAuth redirects (/auth/google, /slack/connect)
// go through the proxy as well.
const backend = process.env.BACKEND_URL ?? 'http://localhost:4000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Read VITE_* variables from the shared root .env.
  envDir: '../../',
  server: {
    port: 5173,
    proxy: {
      '/api': backend,
      '/auth': backend,
      '/slack': backend,
      '/admin': backend,
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
});
