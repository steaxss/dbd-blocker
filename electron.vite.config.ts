import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { BuildEnvironmentOptions } from 'vite'
import react from '@vitejs/plugin-react'
import obfuscator from 'rollup-plugin-obfuscator'

const isProd = process.env.OBFUSCATE === '1'

const rendererBuild: BuildEnvironmentOptions = isProd
  ? {
      minify: 'terser',
      terserOptions: {
        compress: { drop_console: false, passes: 2 },
        mangle: true,
      } as BuildEnvironmentOptions['terserOptions'],
    }
  : {}

const obfuscatorPlugin = () =>
  obfuscator({
    options: {
      compact: true,
      controlFlowFlattening: true,
      controlFlowFlatteningThreshold: 0.5,
      deadCodeInjection: true,
      deadCodeInjectionThreshold: 0.3,
      stringArray: true,
      stringArrayEncoding: ['base64'],
      stringArrayThreshold: 0.7,
      selfDefending: false,
      disableConsoleOutput: false,
    },
  })

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), ...(isProd ? [obfuscatorPlugin()] : [])],
    resolve: {
      alias: {
        '@main': resolve('src/main')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin(), ...(isProd ? [obfuscatorPlugin()] : [])]
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@': resolve('src/renderer/src')
      }
    },
    plugins: [react()],
    build: rendererBuild,
  }
})
