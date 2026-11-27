#!/usr/bin/env node
/**
 * patch-live-compact-auto-off.mts — 关掉 compaction spine 的「自动大压缩」（幂等）
 *
 * 背景（2026-11-27 实测：dsh 0.2.2-rc.5 / dsh-live-compact 1.1.12 / billion-context 0.1.216）：
 *   spine 引擎默认 auto:true、thresholdRatio:0.8（dsh-live-compact/lib/settings.js），本地历史超窗时
 *   交棒官方大压缩（@deepseek-ai/dsh-compaction-basic 在 lib/index.js 声明 purpose:"compaction"），
 *   而 bili 无条件拒绝该 purpose，每次打一行 warn「REFUSED, not forwarded」→ 噪音 + 一次注定的失败调用。
 *
 * 做法：把 profile 的 compaction-spine 条目幂等改成 config: { takeoverPresets: true, auto: false }。
 *   id-targeted patch 会**整份替换** config，所以必须同时重述 takeoverPresets: true，
 *   否则 spine 不再接管 preset 的压缩引擎（见 PATCHES.md 第 6 条）。
 *   spine 的「轮后本地小切」不依赖 auto，ACP 压缩仍由 bili 负责；只是不再有官方大压缩兜底。
 *
 * 幂等：已含 auto:false 且 takeoverPresets:true 时直接 SKIP，exit 0。
 *   改前备份到 launcher-backups/，写临时文件后 rename 原子替换，写完回读自检，失败回滚。
 *
 * 用法：node patch-live-compact-auto-off.mts [--check] [--profile <name>]
 *   --check            只报告不修改（未应用时 exit 1）
 *   DSH_SPINE_AUTO=on  完全跳过本钩子（想恢复上游 auto 行为时用）
 *   DSH_PROFILE        覆盖 profile 名（默认 web，与启动器一致）
 *   DSH_CORDIS_PATCH   覆盖目标文件路径
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const CHECK = process.argv.includes('--check')
const KEEP_AUTO = ['on', '1', 'true', 'yes'].includes((process.env.DSH_SPINE_AUTO ?? '').trim().toLowerCase())
const at = process.argv.indexOf('--profile')
const PROFILE = at >= 0 ? (process.argv[at + 1] ?? 'web') : (process.env.DSH_PROFILE ?? 'web')
const HOME = process.env.USERPROFILE ?? process.env.HOME ?? ''
const FILE =
  process.env.DSH_CORDIS_PATCH ??
  join(HOME, '.dsh', 'profiles', PROFILE, 'cordis.patch.yml')
const BACKUP_DIR = join(HOME, '.dsh', 'launcher-backups')
const ID = 'compaction-spine'
const NAME = 'dsh-live-compact'

function die(msg) {
  console.error('[spine-auto] ' + msg)
  process.exit(1)
}

if (!existsSync(FILE)) die('profile patch not found: ' + FILE)

/** 切成不带幽灵空行的行数组，同时记住换行风格与是否以换行结尾 */
function split(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const trailing = /\r?\n$/.test(text) || text === ''
  const body = text.replace(/\r?\n$/, '')
  const lines = body === '' ? [] : body.split(/\r?\n/)
  return { eol, trailing, lines }
}

/** 在顶层数组里定位这一项的行区间 [start, end) */
function findBlock(lines) {
  const idRe = new RegExp('^-\\s*id:\\s*[\'"]?' + ID + '[\'"]?\\s*$')
  let start = -1
  for (let i = 0; i < lines.length; i += 1) {
    if (idRe.test(lines[i].trim())) {
      start = i
      break
    }
  }
  if (start < 0) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^-\s/.test(lines[i])) {
      end = i
      break
    }
  }
  return { start, end }
}

/** 读一块的状态：找到没有、auto 是否 false、takeoverPresets 是否 true、锚点行号 */
function inspect(lines) {
  const block = findBlock(lines)
  if (block === null) return { found: false, autoOk: false, takeoverOk: false }
  let autoIdx = -1
  let autoVal = ''
  let takeIdx = -1
  let takeVal = ''
  let configIdx = -1
  for (let i = block.start; i < block.end; i += 1) {
    const auto = /^(\s+)auto\s*:\s*(\S*)\s*$/.exec(lines[i])
    if (auto !== null) {
      autoIdx = i
      autoVal = auto[2].toLowerCase()
    }
    const take = /^(\s+)takeoverPresets\s*:\s*(\S*)\s*$/.exec(lines[i])
    if (take !== null) {
      takeIdx = i
      takeVal = take[2].toLowerCase()
    }
    if (/^(\s*)config\s*:\s*$/.test(lines[i])) configIdx = i
  }
  return {
    found: true,
    block,
    autoIdx,
    autoVal,
    takeIdx,
    takeVal,
    configIdx,
    autoOk: autoIdx >= 0 && autoVal === 'false',
    takeoverOk: takeIdx >= 0 && takeVal === 'true',
  }
}

const HEADER = [
  '# ── spine 自动大压缩已关闭（patch-live-compact-auto-off.mts，每次启动幂等重打）──────',
  '# bili 无条件拒绝 DSH 原生压缩（purpose=compaction），spine 交棒大压缩只会被拒并刷 warn。',
  '# auto:false 只关「自动大压缩」；轮后本地小切不受影响，ACP 压缩仍归 bili。',
  '# 想恢复：setx DSH_SPINE_AUTO on（钩子跳过），或删掉下面这一整项。',
]

const raw = readFileSync(FILE, 'utf8')
const { eol, trailing, lines } = split(raw)
const state = inspect(lines)

if (state.found && state.autoOk && state.takeoverOk) {
  console.log('SKIP  [spine-auto] auto:false already set, takeoverPresets:true kept -> ' + FILE)
  process.exit(0)
}
if (KEEP_AUTO) {
  console.log('SKIP  [spine-auto] DSH_SPINE_AUTO=on (upstream auto kept by user) -> ' + FILE)
  process.exit(0)
}
if (CHECK) {
  console.error('NEED  [spine-auto] spine auto not disabled -> ' + FILE)
  console.error(
    '      found block: ' + state.found +
    (state.found ? ' auto=' + (state.autoIdx >= 0 ? state.autoVal : '<absent>') +
      ' takeoverPresets=' + (state.takeIdx >= 0 ? state.takeVal : '<absent>') : ''),
  )
  process.exit(1)
}

const changes = []
let next
if (!state.found) {
  next = lines.concat([
    '',
    ...HEADER,
    '- id: ' + ID,
    '  name: ' + NAME,
    '  config:',
    '    takeoverPresets: true',
    '    auto: false',
  ])
  changes.push('append compaction-spine block (takeoverPresets: true, auto: false)')
} else {
  next = lines.slice()
  const cfgIdx = state.configIdx
  if (cfgIdx < 0) die('compaction-spine block has no config: line -> ' + FILE)
  const cfgIndent = /^(\s*)config\s*:/.exec(next[cfgIdx])?.[1] ?? '  '
  const childIndent = cfgIndent + '  '

  if (!state.takeoverOk) {
    if (state.takeIdx >= 0) {
      next[state.takeIdx] = childIndent + 'takeoverPresets: true'
      changes.push('restore takeoverPresets: true (id-targeted patch replaces the whole config)')
    } else {
      next.splice(cfgIdx + 1, 0, childIndent + 'takeoverPresets: true')
      changes.push('add takeoverPresets: true')
    }
  }

  const again = inspect(next)
  if (again.autoIdx >= 0) {
    if (again.autoVal !== 'false') {
      const ind = /^(\s*)auto\s*:/.exec(next[again.autoIdx])?.[1] ?? childIndent
      next[again.autoIdx] = ind + 'auto: false'
      changes.push('auto ' + again.autoVal + ' -> false')
    }
  } else {
    const blk = again.block
    let tail = blk.end - 1
    while (tail > blk.start && next[tail].trim() === '') tail -= 1
    next.splice(tail + 1, 0, childIndent + 'auto: false')
    changes.push('add auto: false')
  }
}

const after = inspect(next)
if (!(after.found && after.autoOk && after.takeoverOk)) die('composed block still invalid, refusing to write')

mkdirSync(BACKUP_DIR, { recursive: true })
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const backup = join(BACKUP_DIR, 'cordis.patch.yml.' + PROFILE + '.pre-spine-auto-' + stamp)
copyFileSync(FILE, backup)
const tmp = FILE + '.patch-tmp'
writeFileSync(tmp, next.join(eol) + (trailing ? eol : ''), 'utf8')
renameSync(tmp, FILE)

const verify = inspect(split(readFileSync(FILE, 'utf8')).lines)
if (!(verify.found && verify.autoOk && verify.takeoverOk)) {
  copyFileSync(backup, FILE)
  die('post-write self-check failed, restored from ' + backup)
}

console.log('PATCH [spine-auto] ' + FILE)
for (const c of changes) console.log('      + ' + c)
console.log('      backup ' + backup)
console.log('      self-check OK: compaction-spine has auto:false + takeoverPresets:true')
console.log('      takes effect after restarting the dsh gateway (new sessions / presets)')
