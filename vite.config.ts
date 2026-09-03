import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import AutoImport from 'unplugin-auto-import/vite';
import Components from 'unplugin-vue-components/vite';
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [
    vue(),
    // Element Plus 按需导入：组件与配套样式随用随打包，避免全量引入
    AutoImport({ resolvers: [ElementPlusResolver()], dts: 'src/types/auto-imports.d.ts' }),
    Components({ resolvers: [ElementPlusResolver()], dts: 'src/types/components.d.ts' })
  ],
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
    include: ['src/**/*.test.ts', 'server/**/*.test.ts', 'server/**/*.test.js'],
    coverage: {
      provider: 'v8',
      include: ['src/services/**', 'src/composables/**', 'src/stores/**', 'server/lib/**', 'server/services/**'],
      reporter: ['text', 'html']
    }
  }
});
