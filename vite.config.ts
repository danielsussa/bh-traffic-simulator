import { defineConfig } from 'vite';

// No GitHub Pages o site fica em /bh-traffic-simulator/ (definido no workflow de deploy)
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
});
