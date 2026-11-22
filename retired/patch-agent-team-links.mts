#!/usr/bin/env node
/**
 * patch-agent-team-links.mts — 保证 Agent Teams 四个包指向全局 dsh 自带的 0.1.7 线
 *
 * 背景：profile 里这几条 bundle 原先被钉死在 0.1.5-alpha.2（npm 的 `latest` tag），
 *   而全局 dsh 已升到 0.1.7-alpha.2（`alpha` tag）→ 版本错配：
 *     - typert-loader 严格校验失败:
 *         @deepseek-ai/dsh-experimental-agent-team invocation
 *         "#agentTeams/createTask" parameter codec has no create() factory
 *       （requireStrictCodec @ dsh-typert-loader/lib/index.js:211）
 *     - client bundle 不激活: "web boot: 2 entries did not activate"
 *     - 且 0.1.7-alpha.2 的 peerDependencies **精确锁** 0.1.7-alpha.2
 *       （dsh-llm/dsh-agent/dsh-session/dsh-subagent/dsh-invariants/
 *         dsh-typert-protocol/dsh-session-projection/dsh-session-persistence/dsh-brand）
 *       所以必须在"全局 dsh 自己的 node_modules 内"被解析，随便装一份都不齐。
 *
 * 做法：把 profile 里的 4 个包变成 junction，指向全局 dsh 自带的那份（同源、版本天然一致、
 *   无需 pnpm install —— 避开 install 冲掉手写 link: 依赖与 EPERM 竞态）。
 *   symlinkSync(..., 'junction') 不要求管理员权限（node 在 Windows 上的 junction 语义）。
 *
 * 本脚本的自检/自愈职责：
 *   ① 链接缺失、或指向别处、或版本 ≠ 全局源版本 → 重建；
 *   ② 全局源缺失（上游改名/移除/换了 dsh 安装位置）→ 报错但不阻塞启动（exit 0 由启动器判定）；
 *   ③ package.json 里若缺 `link:` 声明（pnpm install 会把它们装回 0.1.5）→ 只警告，不改 package.json。
 *
 * 幂等：版本一致即跳过。npm install -g dsh 会整体替换全局目录，但 junction 的**目标路径**不变，
 *   故通常自动跟随；只有目标消失或 profile 侧被 pnpm 重装成 0.1.5 时才需要本脚本。
 *
 * 用法：node C:\Users\11\.dsh\patch-agent-team-links.mts [--check]
 *   --check 只报告不修改（exit 1 表示需要修）。
 */
import { existsSync, readFileSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'

const CHECK = process.argv.includes('--check')

const PROFILE_DIR = join(process.env.USERPROFILE ?? '', '.dsh', 'profiles', 'web', 'node_modules', '@deepseek-ai')
const PROFILE_PKG = join(process.env.USERPROFILE ?? '', '.dsh', 'profiles', 'web', 'package.json')
// 全局 dsh 自带的 node_modules；DSH_AGENT_TEAM_SOURCE 可覆盖（dsh 换安装位置时用）
const GLOBAL_DIR =
  process.env.DSH_AGENT_TEAM_SOURCE ??
  join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai')

const PKGS = [
  'dsh-experimental-agent-team',
  'dsh-experimental-agent-team-profile',
  'dsh-experimental-tool-agent-team',
  'dsh-experimental-client-ui-agent-team',
]

/** 读 package.json 的 version；不可读返回 null（= 目录缺失/损坏） */
function readVersion(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version ?? null
  } catch {
    return null
  }
}

if (!existsSync(GLOBAL_DIR)) {
  console.error(`[agent-team] 全局源目录不存在: ${GLOBAL_DIR}`)
  console.error('[agent-team] 若 dsh 已换安装位置，设置 DSH_AGENT_TEAM_SOURCE 指向其 node_modules/@deepseek-ai')
  process.exit(1)
}

let healthy = 0
let healed = 0
let broken = 0

for (const name of PKGS) {
  const link = join(PROFILE_DIR, name)
  const target = join(GLOBAL_DIR, name)
  const targetVersion = readVersion(target)
  if (targetVersion === null) {
    console.error(`[agent-team] [无法自愈] ${name}: 全局源缺失 (${target}) — 上游可能改名/移除该包`)
    broken += 1
    continue
  }

  const currentVersion = readVersion(link)
  if (currentVersion === targetVersion) {
    healthy += 1
    continue
  }

  if (CHECK) {
    console.error(`[agent-team] [需修] ${name}: 本地 ${currentVersion ?? '缺失'} ≠ 全局 ${targetVersion}`)
    broken += 1
    continue
  }

  try {
    // 旧内容（通常是 0.1.5 实目录）挪成备份；已有同名备份则丢弃旧的，保持一份
    if (existsSync(link)) {
      const backup = link + '.v015bak'
      if (existsSync(backup)) rmSync(backup, { recursive: true, force: true })
      renameSync(link, backup)
    }
    symlinkSync(target, link, 'junction')
  } catch (error) {
    console.error(`[agent-team] [失败] ${name}: ${error?.code ?? error?.message}`)
    broken += 1
    continue
  }

  const rebuiltVersion = readVersion(link)
  if (rebuiltVersion !== targetVersion) {
    console.error(`[agent-team] [失败] ${name}: 重建后读到 ${rebuiltVersion ?? '缺失'}，期望 ${targetVersion}`)
    broken += 1
    continue
  }
  console.log(`[agent-team] [重建] ${name} -> ${targetVersion}`)
  healed += 1
}

// package.json 是 pnpm 重装时的依据：缺 link: 就会被装回 0.1.5。只警告，不代改用户文件。
let pkgMissing = []
try {
  const deps = JSON.parse(readFileSync(PROFILE_PKG, 'utf8')).dependencies ?? {}
  pkgMissing = PKGS.filter((name) => !String(deps[`@deepseek-ai/${name}`] ?? '').startsWith('link:'))
} catch {
  pkgMissing = PKGS
}
if (pkgMissing.length > 0) {
  console.error(`[agent-team] [警告] package.json 缺 link: 声明: ${pkgMissing.join(', ')}`)
  console.error('[agent-team] 下次 pnpm install 会装回 0.1.5 并重现 typert codec 错误；本脚本会在启动时再重建。')
}

if (broken === 0) {
  console.log(`[agent-team] 链接就绪 (${healthy} 已正确${healed > 0 ? `, ${healed} 已重建` : ''})`)
  process.exit(0)
}
console.error(`[agent-team] ${broken} 个链接未能就绪 (已正确 ${healthy}${healed > 0 ? `, 已重建 ${healed}` : ''})`)
process.exit(1)
