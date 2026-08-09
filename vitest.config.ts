
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'
import { fileURLToPath } from 'url'

const configDirectory = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
    plugins: [react()],
    test: {
        environment: 'jsdom',
        globals: true,
        setupFiles: [],
        exclude: ['tests/e2e/**', 'node_modules/**', '.next/**'],
        alias: {
            '@': path.resolve(configDirectory, './'),
        },
    },
})
