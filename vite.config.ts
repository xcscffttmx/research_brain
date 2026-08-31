import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8788',
        changeOrigin: true
      }
    }
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'server/**/*.test.js'],
    coverage: {
      provider: 'v8',
      include: ['src/services/**', 'src/composables/**', 'server/lib/**', 'server/services/**'],
      reporter: ['text', 'html']
    }
  }
});
