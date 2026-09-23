import { defineConfig } from 'vitest/config'

/**
 * The browser lane: component tests that need a DOM.
 *
 * Kept separate from `vitest.config.ts` (node) because these tests render React
 * components, and mixing the two environments in one lane would make every unit
 * test pay for a DOM it does not use. The include pattern is deliberately
 * `*.web.spec.tsx` -- the node lane matches `*.spec.ts`, so a file belongs to
 * exactly one lane.
 */
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['packages/*/tests/**/*.web.spec.tsx'],
    // React renders asynchronously; a component that defers one microtask needs
    // the same budget a browser would give it.
    testTimeout: 30_000,
  },
})
