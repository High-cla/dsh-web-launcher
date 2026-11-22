// dsh-web-boot.mts — 启动 dsh web，转发日志到控制台，捕获带 token 的登录 URL 并用默认浏览器打开。
// 为什么需要: dsh 打印的 `dsh web: http://127.0.0.1:3080/?token=...` 才是唯一能通过认证的入口;
// 直接开裸 http://127.0.0.1:3080 会得到 401 "dsh web authentication required"。
// 用 --no-open 让 dsh 不开浏览器，由本脚本开正确的 token URL(唯一开者，避免重复/错开)。
// 用法: node dsh-web-boot.mts   (由 DSH-Web-Launcher.cmd 调用)
import { spawn } from 'node:child_process'

/**
 * 传给 dsh 子进程的环境：保留原样，仅追加抑制 Node 实验性 API 警告的开关。
 * 该警告来自 DSH 自身 dsh-code-runtime-worker-thread 的显式 stripTypeScriptTypes() 调用
 * （run_code/worker 路径），与本机 .mts 脚本无关（实测 node a.mts 不触发）。
 * 只在未设置时追加，避免覆盖用户已有的 NODE_OPTIONS；NODE_OPTIONS 对 worker_threads 同样生效（已实测）。
 */
function childEnv(base = process.env) {
  const flag = '--disable-warning=ExperimentalWarning'
  const current = base.NODE_OPTIONS ?? ''
  return { ...base, NODE_OPTIONS: current.includes(flag) ? current : `${current} ${flag}`.trim() }
}

const bash = process.env.DSH_BASH || 'C:\\Program Files\\Git\\bin\\bash.exe'
const urlPattern = /https?:\/\/[^\s"']*\?token=[A-Za-z0-9_-]+/

const child = spawn(bash, ['-lc', 'dsh --profile web --no-open'], {
  cwd: process.env.USERPROFILE || process.cwd(),
  env: childEnv(),
  stdio: ['inherit', 'pipe', 'pipe'],
})

let opened = false
let tail = ''

function handle(chunk) {
  process.stdout.write(chunk)
  tail = (tail + chunk).slice(-8192)
  if (opened) return
  const match = tail.match(urlPattern)
  if (!match) return
  opened = true
  const url = match[0]
  try {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
    process.stdout.write('\n[dsh-web-boot] 已用默认浏览器打开登录 URL\n')
  } catch (error) {
    process.stdout.write(`\n[dsh-web-boot] 打开浏览器失败: ${error.message}\n请手动打开上面打印的 dsh web URL\n`)
  }
}

/**
 * dsh 非正常退出时不要立刻关掉窗口：启动器用 `start "DSH-Web" node ...` 开这个窗口，
 * 脚本一 exit 窗口就关，用户只看到「闪退」且看不到任何错误。这里（仅当挂在真实控制台时）
 * 打印提示并等一次按键，把 dsh 的输出留在屏幕上。
 */
function exitHoldingOpen(code) {
  if (code === 0 || !process.stdin.isTTY) process.exit(code)
  process.stdout.write('\n[dsh-web-boot] 启动失败 —— 按任意键关闭此窗口（上面是 dsh 的输出）\n')
  try {
    process.stdin.setRawMode(true)
  } catch {
    // 非 TTY 已在上面挡掉；这里仅兜底
  }
  process.stdin.resume()
  process.stdin.once('data', () => process.exit(code))
}

child.stdout.on('data', handle)
child.stderr.on('data', handle)
child.on('error', (error) => {
  process.stdout.write(`\n[dsh-web-boot] 启动 dsh 失败: ${error.message}\n`)
  exitHoldingOpen(1)
})
child.on('exit', (code) => {
  process.stdout.write(`\n[dsh-web-boot] dsh 退出 (code ${code})\n`)
  exitHoldingOpen(typeof code === 'number' ? code : 1)
})
