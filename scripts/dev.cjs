// WorkBuddy 沙箱启动器：剥离 ELECTRON_RUN_AS_NODE=1 与禁用 GPU 开关环境变量，
// 再 spawn `npm run dev`（vite-plugin-electron 会自动 spawn electron）。
// 必须在 vite 启动前执行，否则 vite 进程会把这个变量原样传给 spawn 的 electron，
// 导致 electron 以纯 Node 模式运行、require('electron') 返回二进制路径字符串而崩溃。
//
// 用法：npm run dev:wb
// 退出：Ctrl-C

const { spawn } = require('node:child_process')

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
// 不再强制 WORKBUDDY_SANDBOX / disable-gpu：用户桌面有显卡，禁用它会导致视频无法硬解播放。
// 仅当确实运行在无 GPU 的沙箱时才需要设置 env.ELECTRON_DISABLE_GPU = '1'。
// NODE_OPTIONS（含 genie-safe-delete）保留：vite 启动时会 rmSync('dist-electron')，
// 走 trash 而不是真删，更安全。

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const child = spawn(npmCmd, ['run', 'dev'], {
  env,
  stdio: 'inherit',
  // Node 22 在 Windows 上 spawn .cmd 需要 shell，否则 EINVAL
  shell: process.platform === 'win32',
})

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    child.kill(sig)
  })
}

child.on('close', (code) => {
  process.exit(code ?? 0)
})