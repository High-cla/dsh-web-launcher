#!/usr/bin/env node
// patch-live-compact-gate.mts — 让 dsh-live-compact 的 gate 覆盖自建预设 mcp-opt
//
// 事实（2026-11-04 实测，dsh 0.2.1-rc.5 / dsh-live-compact 1.0.5）：
//   gate.js 的 PRESET_IDS 只有 standard/ptc/minimal/cordis（含 preset-* 前缀形态）。
//   本机 selectedDefault 与当前会话 agentPreset 都是 mcp-opt；该预设内部嵌套
//     - id: compaction / cordis:group / isolate:{compaction:true}
//         - id: compaction-basic / @deepseek-ai/dsh-compaction-basic / auto:true, thresholdRatio:0.85
//   → gate 不认 mcp-opt，嵌套原版引擎不被替换，Live Compact 在日常会话里不生效
//     （host 平面的 compaction-spine 被该 isolate 组遮住）。
//
// 做法：把 mcp-opt / preset-mcp-opt 追加进 PRESET_IDS。纯字符串补丁，不动逻辑：
//   rewriteEntry 只在 entry.name 恰为 @deepseek-ai/dsh-compaction-basic 时动手；
//   withEngineConfig = {...PRESET_ENGINE_CONFIG, ...previous} → 预设已有的 0.85 优先保留。
//
// 硬链接：pnpm 把包文件硬链到 store（C:\Users\11\AppData\Local\pnpm\store\v11，gate.js nlink=2）。
//   必须写临时文件再 rename 覆盖目录项；原地写会改到 store 里共享的那份。
//
// 幂等；dsh plugin --profile web add / pnpm install 重新解包 tgz 后补丁会丢，再跑一次即可。
// 用法：node C:\Users\11\.dsh\patch-live-compact-gate.mts [--check] [--profile <name>]
import { copyFileSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const WANT = ['mcp-opt', 'preset-mcp-opt']
const STOCK = '@deepseek-ai/dsh-compaction-basic'
const OUR_ENGINE = 'dsh-live-compact'
const argv = process.argv.slice(2)
const checkOnly = argv.includes('--check')
const at = argv.indexOf('--profile')
const profile = at >= 0 ? argv[at + 1] : 'web'
const home = process.env.DSH_HOME || join(homedir(), '.dsh')
const gatePath = join(home, 'profiles', profile, 'node_modules', 'dsh-live-compact', 'gate.js')

function die(msg) {
  console.error('FAIL ' + msg)
  process.exit(1)
}

if (!existsSync(gatePath)) die('missing ' + gatePath + ' (install dsh-live-compact into profile ' + profile + ' first)')
const source = readFileSync(gatePath, 'utf8')
const m = source.match(/const PRESET_IDS = new Set\(\[([^\]]*)\]\)/)
if (!m) die('PRESET_IDS literal not found in ' + gatePath)
const items = m[1].split(',').map((s) => s.trim()).filter(Boolean)
const vals = items.map((s) => s.replace(/^['"]|['"]$/g, ''))
const want = WANT.filter((id) => !vals.includes(id))

if (want.length === 0) {
  console.log('SKIP  PRESET_IDS already has ' + WANT.join(' / '))
  process.exit(0)
}
if (checkOnly) {
  console.error('NEED  PRESET_IDS lacks ' + want.join(' / ') + ' -> ' + gatePath)
  process.exit(1)
}

const next = source.slice(0, m.index)
  + 'const PRESET_IDS = new Set([' + items.concat(want.map((id) => JSON.stringify(id))).join(', ') + '])'
  + source.slice(m.index + m[0].length)
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const backup = join(home, 'launcher-backups', 'gate.js.pre-' + stamp)
copyFileSync(gatePath, backup)
writeFileSync(gatePath + '.patch-tmp', next, 'utf8')
renameSync(gatePath + '.patch-tmp', gatePath)
const nlink = statSync(gatePath).nlink

const gate = await import(pathToFileURL(gatePath).href + '?t=' + Date.now())
const preset = { id: 'mcp-opt', plugins: [{ id: 'compaction', name: 'cordis:group', config: [
  { id: 'compaction-basic', name: STOCK, config: { auto: true, thresholdRatio: 0.85 } },
  { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
] }] }
const rewritten = gate.rewritePresetConfig(preset)
const engine = rewritten.plugins[0].config[0]
const ok = engine.name === OUR_ENGINE
  && engine.config.thresholdRatio === 0.85
  && engine.config.headroomTokens === 65536
  && engine.config.retainTokens === 8192
  && engine.config.compactionRetries === 0
  && rewritten.plugins[0].config[1].name === '@deepseek-ai/dsh-command-compact'
  && gate.rewritePresetConfig({ id: 'not-a-preset', plugins: preset.plugins }).plugins[0].config[0].name === STOCK
if (!ok) die('self-check failed: ' + JSON.stringify(engine))
if (nlink > 1) console.warn('WARN  nlink=' + nlink + ' (hardlink not broken, verify store copy)')

console.log('PATCH ' + gatePath)
console.log('      PRESET_IDS += ' + want.join(', '))
console.log('      backup ' + backup)
console.log('      self-check OK: mcp-opt nested engine -> dsh-live-compact (thresholdRatio 0.85 kept)')
console.log('      takes effect after restarting the dsh gateway')
