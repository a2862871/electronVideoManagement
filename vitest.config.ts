import { defineConfig } from 'vitest/config'

// Node < 22.13 中 node:sqlite 需显式开启实验性标志，否则 scanner/organize 测试报
// "No such built-in module: node:sqlite"。execArgv 会传给 spawn 出的 worker 进程。
export default defineConfig({
  test: {
    root: __dirname,
    include: ['test/**/*.{test,spec}.?(c|m)[jt]s?(x)'],
    exclude: ['test/e2e.spec.ts'],
    passWithNoTests: true,
    testTimeout: 1000 * 29,
    execArgv: ['--experimental-sqlite'],
  },
})
