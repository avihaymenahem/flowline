import { defineConfig, loadEnv } from 'vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const defaultUploadTimeoutMs = 14_400_000

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, repoRoot, '')
  const uploadTimeoutMs = Number(process.env.API_UPLOAD_TIMEOUT_MS ?? env.API_UPLOAD_TIMEOUT_MS ?? defaultUploadTimeoutMs)
  if (!Number.isSafeInteger(uploadTimeoutMs) || uploadTimeoutMs < 60_000 || uploadTimeoutMs > 86_400_000) {
    throw new Error('API_UPLOAD_TIMEOUT_MS must be between 60000 and 86400000')
  }
  const apiPort = Number(process.env.API_PORT ?? env.API_PORT ?? 4100)
  if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65_535) {
    throw new Error('API_PORT must be between 1 and 65535')
  }
  const webPort = Number(process.env.WEB_PORT ?? env.WEB_PORT ?? 5173)
  if (!Number.isInteger(webPort) || webPort < 1 || webPort > 65_535) {
    throw new Error('WEB_PORT must be between 1 and 65535')
  }
  const apiProxyTarget = process.env.API_PROXY_TARGET ?? env.API_PROXY_TARGET ?? `http://127.0.0.1:${apiPort}`
  const allowedHosts = (process.env.WEB_ALLOWED_HOSTS ?? env.WEB_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean)

  return {
    plugins: [react(), tailwindcss()],
    resolve: { preserveSymlinks: true },
    server: {
      host: process.env.WEB_HOST ?? env.WEB_HOST ?? '0.0.0.0',
      allowedHosts,
      port: webPort,
      proxy: { '/api': { target: apiProxyTarget, changeOrigin: true, timeout: uploadTimeoutMs, proxyTimeout: uploadTimeoutMs } },
    },
  }
})
