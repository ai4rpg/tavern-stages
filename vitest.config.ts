import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
    // Anchor vitest's temp build cache inside this repo so it never writes
    // through the `node_modules` symlink into the sibling stage-switch checkout
    // (which may be read-only or get polluted). `.vitest` is gitignored.
    cacheDir: '.vitest',
  },
})
