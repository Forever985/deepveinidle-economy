import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// 相对 base：让产物能部署到 user.github.io/<repo>/ 这类子路径下
export default defineConfig({
  base: './',
  plugins: [vue()],
  build: {
    outDir: 'dist',
    // 静态站点：产物越小越利于 GitHub Pages 直出
    assetsInlineLimit: 8192,
  },
  server: {
    port: 5173,
    open: false,
  },
})
