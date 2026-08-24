import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5273, strictPort: true, host: '127.0.0.1' },
  preview: { port: 5274, strictPort: true, host: '127.0.0.1' },
  build: { target: 'esnext', sourcemap: true },
  base: '/sakura-idle/',
  // GLSL kept as JS template strings so no plugin is needed.
});
