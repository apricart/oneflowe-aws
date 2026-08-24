
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const configDirectory = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
    plugins: [react()],
    test: {
        environment: 'jsdom',
        globals: true,
        // password-hasher.test.ts hashes with real bcrypt at cost 10 and 12.
        // That is ~2s of actual work, but under full-suite parallelism on a
        // 2-core CI runner it overruns the 5s default and times out.
        testTimeout: 30000,
        setupFiles: [],
        exclude: ['tests/e2e/**', 'node_modules/**', '.next/**'],
        alias: {
            '@': path.resolve(configDirectory, './'),
        },
    },
})
