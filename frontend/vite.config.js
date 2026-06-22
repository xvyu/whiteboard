import { defineConfig } from 'vite'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root: __dirname,
  build: {
    outDir: 'dist',
    minify: false,          // 关闭压缩，保留原始函数名
    sourcemap: true,
    modulePreload: false,
    rollupOptions: {
      input: {
        login: resolve(__dirname, 'login.html'),
        whiteboard: resolve(__dirname, 'whiteboard.html'),
      },
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name].[ext]',
        // 多入口时不能用 iife，用 es 格式，后处理脚本会转成普通 JS
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8000',
      '/ws': {
        target: 'ws://localhost:8000',
        ws: true,
      },
    },
  },
})
