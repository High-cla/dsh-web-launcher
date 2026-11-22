// patch-redteam-toolfilter.mts — 移除 redteam 预设里 0.2.1-rc.2 已删除的 toolFilter 字段
//
// 背景：dsh-tool-subagent 在 0.2.1-rc.2 移除了 persona / toolFilter（lib/index.js:355 显式抛错），
// 而 dsh-purge 的 redteam 预设对 tool-subagent 用 toolFilter deny 子委派工具。结果是选中
// 「红队模式」新建会话直接失败：
//   tool-subagent (@deepseek-ai/dsh-tool-subagent): tool-subagent: toolFilter is no longer supported
// 叶子节点的硬保证本来就只有 maxDepth: 1，toolFilter 只是第二道保险，删掉不影响语义。
//
// 两个落点都要修：
//   1) $DSH_HOME/.agent-presets/redteam/agent.cordis.yml —— dsh-purge 首次运行从模板落盘、并
//      register() 进 agent-preset registry 的那份（**实际生效的是它**）；
//   2) profiles/web/node_modules/dsh-purge/presets/redteam/agent.cordis.yml —— 模板；dsh-purge
//      的 needsCompositionRepair 会用它重新落盘，不改模板就会被还原。
//
// 幂等：已无 toolFilter 则跳过。缺文件（未装 dsh-purge）也跳过并 exit 0。
// 用法: node patch-redteam-toolfilter.mts
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const home = process.env.USERPROFILE || ''
const targets = [
  join(home, '.dsh', '.agent-presets', 'redteam', 'agent.cordis.yml'),
  join(home, '.dsh', 'profiles', 'web', 'node_modules', 'dsh-purge', 'presets', 'redteam', 'agent.cordis.yml'),
]

/** 删掉 `toolFilter:` 及其全部更深缩进的子行；返回是否改动。 */
function stripToolFilter(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  const at = lines.findIndex((line) => /^\s*toolFilter:\s*$/.test(line))
  if (at < 0) return { changed: false, text }
  const indent = lines[at].length - lines[at].trimStart().length
  let end = at + 1
  while (end < lines.length) {
    const line = lines[end]
    if (line.trim() === '') { end += 1; continue }
    const deeper = line.length - line.trimStart().length
    if (deeper <= indent) break
    end += 1
  }
  lines.splice(at, end - at)
  return { changed: true, text: lines.join(eol) }
}

let touched = 0
let missing = 0
for (const target of targets) {
  const label = target.includes('node_modules') ? 'template' : 'deployed'
  if (!existsSync(target)) { missing += 1; continue }
  const before = readFileSync(target, 'utf8')
  const after = stripToolFilter(before)
  if (!after.changed) {
    console.log(`[redteam-toolfilter] ${label}: 无 toolFilter，跳过`)
    continue
  }
  writeFileSync(target, after.text, 'utf8')
  touched += 1
  console.log(`[redteam-toolfilter] ${label}: 已移除 toolFilter`)
}

if (touched === 0 && missing === targets.length) console.log('[redteam-toolfilter] dsh-purge 未安装，跳过')
else if (touched === 0) console.log('[redteam-toolfilter] 全部已是合规写法')
process.exit(0)
