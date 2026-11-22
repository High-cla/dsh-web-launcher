// patch-bili-allow-dsh-compaction.mts — 让 billion-context 的加载期 overlay 认 `dsh.allowDshCompaction`
//
// 症状: 在 preset-mcp-opt（以及任何 agent preset）下，DSH 内置压缩整条链被关死：
//   dev_plugin_status 里 compaction-basic / command-compact / tool-result-pruner 全是
//   [no-fiber] ... [disabled]，于是手动 /compact 命令根本不存在。
//
// 根因 (2026-10-20 实测, billion-context@0.1.202):
//   profiles/web/node_modules/billion-context/dist/agent/dsh-native.js
//     function disableBasicCompaction(rows){ ... if(r.name===DSH_COMPACTION_BASIC_PACKAGE
//        ||r.name===DSH_COMMAND_COMPACT_PACKAGE) return {...r, disabled:true}; ... }
//     function registerCompactionDisable(ctx){
//       if(typeof ctx.on==="function"){ ctx.on("internal/config", function(_raw,next){
//         const resolved=next();
//         if(this?.entry?.options?.name!==DSH_AGENT_PRESET_PACKAGE) return resolved;
//         ... return {...config, plugins: disableBasicCompaction(config.plugins)} }, {global:true}) }
//       ctx.reflect?.provide?.(BILI_COMPACTION_DISABLE_SERVICE, ...) }
//     function apply(ctx){ const plan=planNativeDsh(process.env); if(plan.mode==="off") return;
//       ...; registerCompactionDisable(ctx); ... }
//   → 无条件（#3354，无用户开关）。CONFIGURATION.zh-CN.md:2200 明确写了「无需任何用户操作即关闭」。
//
// 为什么 `dsh.allowDshCompaction: true` 之前没用:
//   那个开关只解 bili 的 **wire 级 422 闸门**（#1729/#2360），管不到这个 config overlay。
//   文档 :2196 说 `auto: false` 只关自动触发、手动 /compact 仍会触发 —— 但前提是插件没被 disabled。
//
// 补丁（唯一改动，一处条件）:
//   registerCompactionDisable 注册 overlay 前先问一句「用户显式 opt-in 了吗」：
//     BILI_ALLOW_DSH_COMPACTION 环境变量（≠ "0"/空 即开），或
//     ~/.config/billion-context/billion-context.json 的 dsh.allowDshCompaction === true
//   是 → 不注册剥离钩子（compaction-basic / command-compact 保持启用）；
//   否 → 行为与上游完全一致。
//   ctx.reflect.provide(BILI_COMPACTION_DISABLE_SERVICE) 仍然无条件执行 ——
//   Web preset 的 inject 门控行依赖这个服务，缺了会让 preset 一直等待。
//
// 风险与回滚:
//   DSH 内置压缩的 checkpoint 会永久覆盖原始历史（不可逆）。本机 billion-context.json 里
//   dsh.allowDshCompaction 早已是 true，等于用户已接受该前提。想整体还原：
//     DSH_BILI_COMPACTION_GATE=off  → 本脚本跳过（等于上游行为）
//     或删掉 .dsh-native.js.preprepatch-bak 之外的改动用备份覆盖回来
//
// 幂等: 含标记则跳过。billion-context 升级/重装会覆盖 dist，故每次启动重放。
// pnpm 硬链接: node_modules 里的文件与内容寻址 store 是硬链接（link count 2），
//   直接 writeFileSync 会**穿透**改掉 store 副本，波及其它 profile —— 所以先 unlink 再写。
// 用法: node patch-bili-allow-dsh-compaction.mts [--check]
//       exit 0 = 已修/无需修/未安装; exit 1 = 改写失败或校验不过
import { existsSync, readFileSync, writeFileSync, unlinkSync, copyFileSync, readdirSync, statSync } from 'node:fs'

const home = process.env.USERPROFILE || process.env.HOME || ''
const PROFILES = home + '/.dsh/profiles'
const MARK = 'DSH-PATCH:bili-compaction-optin'
const CHECK = process.argv.includes('--check')
const log = (m) => console.log('[bili-compaction] ' + m)

const mode = (process.env.DSH_BILI_COMPACTION_GATE || '').trim().toLowerCase()
if (mode === 'off') {
  log('DSH_BILI_COMPACTION_GATE=off — 保持上游行为（加载期剥离），跳过')
  process.exit(0)
}

const ANCHOR = 'function registerCompactionDisable(ctx){if(typeof ctx.on==="function"){'
const HELPER = 'function biliDshCompactionOptIn(){/*' + MARK + '*/'
  + 'try{const e=process.env.BILI_ALLOW_DSH_COMPACTION;'
  + 'if(e!==void 0&&e!=="")return e!=="0";'
  + 'const c=loadConfigFile();'
  + 'return c?.dsh?.allowDshCompaction===true'
  + '}catch{return false}}'
const PATCHED = HELPER + 'function registerCompactionDisable(ctx){if(typeof ctx.on==="function"&&!biliDshCompactionOptIn()){'
const SERVICE_NEEDLE = 'ctx.reflect?.provide?.(BILI_COMPACTION_DISABLE_SERVICE'

const countOf = (hay, needle) => hay.split(needle).length - 1

function targets() {
  if (!existsSync(PROFILES)) return []
  const out = []
  for (const name of readdirSync(PROFILES)) {
    const p = PROFILES + '/' + name + '/node_modules/billion-context/dist/agent/dsh-native.js'
    if (existsSync(p) && statSync(p).isFile()) out.push(p)
  }
  return out
}

const files = targets()
if (files.length === 0) {
  log('未找到 billion-context/dist/agent/dsh-native.js — 跳过')
  process.exit(0)
}

let dirty = false
let failed = false

for (const target of files) {
  const tag = target.slice(PROFILES.length + 1).split('/')[0]
  const src = readFileSync(target, 'utf8')

  if (src.includes(MARK)) {
    log(tag + ': 已含补丁标记 — 跳过')
    continue
  }

  const nAnchor = countOf(src, ANCHOR)
  const nService = countOf(src, SERVICE_NEEDLE)
  if (nAnchor !== 1 || nService < 1) {
    log(tag + ': 锚点不唯一 (anchor=' + nAnchor + ', service=' + nService + ') — 上游结构已变，拒绝改写')
    failed = true
    continue
  }
  if (countOf(src, 'function loadConfigFile(){') !== 1) {
    log(tag + ': loadConfigFile 锚点异常 — 拒绝改写')
    failed = true
    continue
  }

  dirty = true
  if (CHECK) {
    log(tag + ': 需要补丁')
    failed = true
    continue
  }

  const out = src.split(ANCHOR).join(PATCHED)
  const ok = out.includes(MARK)
    && countOf(out, ANCHOR) === 0
    && countOf(out, SERVICE_NEEDLE) === nService
    && Math.abs(out.length - src.length) < 800
  if (!ok) {
    log(tag + ': 改写后自检不过 — 中止（未写入）')
    failed = true
    continue
  }

  const bak = target + '.preprepatch-bak'
  if (!existsSync(bak)) {
    try { copyFileSync(target, bak); log(tag + ': 备份 → ' + bak) } catch (e) { log(tag + ': 备份失败: ' + e.message) }
  }

  // 先 unlink 打断 pnpm 硬链接，再写新内容；否则会穿透改掉 store 里的共享副本。
  try {
    unlinkSync(target)
    writeFileSync(target, out)
  } catch (e) {
    log(tag + ': 写入失败: ' + e.message)
    failed = true
    continue
  }

  const back = readFileSync(target, 'utf8')
  if (!back.includes(MARK) || countOf(back, ANCHOR) !== 0) {
    log(tag + ': 回读校验失败')
    failed = true
    continue
  }
  log(tag + ': 已修补 dsh-native.js — 加载期 overlay 现在认 dsh.allowDshCompaction')
}

if (!dirty && !failed) log('无需改动（全部已修补）')
process.exit(failed ? 1 : 0)
