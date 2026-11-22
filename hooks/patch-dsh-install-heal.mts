#!/usr/bin/env node
/**
 * patch-dsh-install-heal.mts — 保证全局 dsh 安装树完整（不缺包、不留空壳目录）
 *
 * 背景：`npm install -g @deepseek-ai/dsh@<ver>`（启动器切渠道/升级时跑的）**可能报成功却留下空壳**：
 *   实测 13 个 @deepseek-ai/* 包目录变成空目录（无 package.json），而 npm 退出码仍是 0、marker 照写。
 *   之后 dsh 启动即崩：
 *     Error: Cannot find package '...\@deepseek-ai\cordis\index.js'
 *            imported from ...\dsh-app-boot\lib\index.js
 *         code: 'ERR_MODULE_NOT_FOUND'
 *   启动器把这个崩溃转成一个 `start "DSH-Web" node dsh-web-boot.mts` 窗口，dsh 一退出窗口就关
 *   → 用户看到的是「双击就闪退」，且看不到任何错误。
 *
 * 做法：启动前核对全局 dsh 的每个 dependencies/optionalDependencies 都能解析到
 *   <dsh>/node_modules/<name>/package.json；缺失/为空壳则重装同一版本（--force）。
 *
 * 顺序要求：本钩子必须在启动器其余 patch-* 钩子**之前**跑 ——
 *   因为重装会整体替换全局目录、冲掉里面已打的补丁；先重装、后面的钩子再逐条重打。
 *
 * 幂等/开销：树完好时只做 ~N 次 existsSync，毫秒级，直接跳过。
 *
 * 用法：node C:\Users\11\.dsh\patch-dsh-install-heal.mts [--check]
 *   --check      只报告不修改（exit 1 = 需要修）
 *   DSH_HEAL=off 完全跳过（逃生开关）
 *   DSH_HEAL_DIR 覆盖全局 dsh 目录（dsh 换安装位置时用）
 */
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const CHECK = process.argv.includes('--check')
const DISABLED = (process.env.DSH_HEAL ?? '').toLowerCase() === 'off'

const DSH_DIR =
  process.env.DSH_HEAL_DIR ?? join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh')
const DSH_PKG = join(DSH_DIR, 'package.json')
const MARKER = join(process.env.USERPROFILE ?? '', '.dsh-web-version')

/** 读 JSON；不可读返回 null（= 文件缺失/损坏） */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** 已安装版本：优先 dsh/package.json，缺失时退回启动器 marker（格式 "<channel> <version>"） */
function installedVersion() {
  const pj = readJson(DSH_PKG)
  if (pj?.version) return pj.version
  try {
    const parts = readFileSync(MARKER, 'utf8').trim().split(/\s+/)
    return parts.length >= 2 ? parts[1] : null
  } catch {
    return null
  }
}

/** 返回缺失/空壳的依赖名列表；dsh/package.json 本身不可读时返回占位项 */
function findBroken() {
  const pj = readJson(DSH_PKG)
  if (!pj) return ['<dsh/package.json 不可读>']
  const names = [...Object.keys(pj.dependencies ?? {}), ...Object.keys(pj.optionalDependencies ?? {})]
  return names.filter((name) => !existsSync(join(DSH_DIR, 'node_modules', name, 'package.json')))
}

function describe(names) {
  return `${names.length} 个包缺失/为空壳: ${names.slice(0, 10).join(', ')}${names.length > 10 ? ' ...' : ''}`
}

if (DISABLED) {
  console.log('[dsh-heal] 已用 DSH_HEAL=off 跳过')
  process.exit(0)
}

let broken = findBroken()
if (broken.length === 0) {
  console.log('[dsh-heal] 全局树完好')
  process.exit(0)
}

if (CHECK) {
  console.error(`[dsh-heal] [需修] ${describe(broken)}`)
  process.exit(1)
}

const version = installedVersion()
console.error(`[dsh-heal] 检测到 ${describe(broken)}`)
if (!version) {
  console.error('[dsh-heal] [无法自愈] 无法确定 dsh 版本（package.json 与 marker 均不可读）')
  console.error('[dsh-heal] 请手动运行: npm install -g @deepseek-ai/dsh')
  process.exit(1)
}

console.error(`[dsh-heal] 正在重装 @deepseek-ai/dsh@${version} …（可能需要几分钟）`)
// 经 cmd.exe 调用 npm：Node 禁止不带 shell 直接 spawn .cmd/.bat
const result = spawnSync('cmd.exe', ['/c', `npm install -g @deepseek-ai/dsh@${version} --force`], {
  stdio: 'inherit',
  cwd: process.env.USERPROFILE || process.cwd(),
  timeout: 900000,
  windowsHide: true,
})
if (result.error) {
  console.error(`[dsh-heal] [失败] npm 无法启动: ${result.error.message}`)
  process.exit(1)
}

broken = findBroken()
if (broken.length === 0) {
  console.log(`[dsh-heal] 已修复 (重装 @deepseek-ai/dsh@${version})`)
  process.exit(0)
}
console.error(`[dsh-heal] [失败] 重装后仍有 ${describe(broken)}`)
process.exit(1)
