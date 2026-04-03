import { defineConfig } from 'vite';

export default defineConfig({
  base: '/jsvba-app/',
  build: {
    target: 'es2022',
  },
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});
