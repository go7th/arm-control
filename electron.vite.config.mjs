import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        external: ['sherpa-onnx-node']
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    // 固定冷门端口 5321（避开 5173：Memora/workflow editor 在用）；
    // strictPort + 127.0.0.1：ServiceMonitor 按 IPv4 端口探测状态
    server: {
      host: '127.0.0.1',
      port: 5321,
      strictPort: true
    },
    build: {
      rollupOptions: {
        input: {
          main: 'src/renderer/index.html'
        }
      }
    }
  }
})
