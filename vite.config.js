import { defineConfig } from 'vite';

export default defineConfig({
  root: 'www',
  base: './',
  envPrefix: 'VITE_',
  css: { postcss: { plugins: [] } },
  build: { outDir: '../dist', emptyOutDir: true },
});
