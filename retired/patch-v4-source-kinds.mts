// patch-v4-source-kinds.mts — 修 V4 非法 source kind（退役形状 { kind: "plugin", plugin: "<名>" }）
//
// 背景: DSH 0.1.7 的 V4 admission 拒绝"退役形状"的插件来源:
//   dsh-session-persistence-jsonl/lib/worker.cjs:10720-10723
//     function source(message) {
//       const value = message["source"]
//       if (!isSessionFormatJsonObject(value) || typeof value["kind"] !== "string"
//           || value["kind"].length === 0 || value["kind"] === "plugin")
//         throw new SessionFormatError("format v4 message requires a producer-owned source kind")
//     }
//   合法 kind = 生产者自有名: user / model / tool / runtime-context / plugin:<name>。
//   镜子副本: dsh-session-format-v3-to-v4/lib/index.js:126（同一谓词）。
//
// 症状: 坏行被整批拒收、滞留内存写队列, **下一轮**才炸; 毒行与错误文本都不落盘,
//   表现为"中途突然报错、找不到出处", 必须重启（admission 读的是持久历史）。
//
// 本脚本修唯一仍在运行的发射点（另一处已随包卸载, 见下; vendored 副本见文末 WARN）:
//   A. @dsh-external/dsh-graded-mode  (loader 里 [active]) —— 8 处
//      lib/index.js:66  userMsg() 帮助函数
//      lib/tools.js:323 / :361 / :486  三个 agent.steer({...}) 注入
//        (:323 lock_stage(L1) 小类分化引导 / :361 lock_stage(L2) 审核提示 /
//         :486 60ms 延迟引导定时器)
//      src/* 为同源副本（随包一起发布,保持同步）
//   B. dsh-context-compression-selector-runtime@0.1.1 —— 2 处
//      [2026-10-20 移除] 该包随 dsh-context-compression-selector 在 2026-09-30 一并卸掉,
//      目标文件已不存在, 每次启动白打一行"未安装（缺文件），跳过"。若该包回归, 需成对改两处
//      （只改发射侧不改回读断言, 插件会认不出自己发布的 TailTrim 记录而静默降级）:
//        lib/tail-trim.js:47-58  tailTrimMessage() 用 createUserMessage() 写 TailTrim 桩
//        lib/tail-trim.js:65     validatePublishedTailTrim() 里的回读断言
//          replacement.data.source.kind !== "plugin"
//            || replacement.data.source.plugin !== "dsh-context-compression-selector-runtime"
//        等价改写为
//          replacement.data.source.kind !== "plugin:dsh-context-compression-selector-runtime"
//
// 做法: 纯字符串字面替换（不是语义改动、不动逻辑）, 统一改成生产者自有 kind:
//   { kind: "plugin", plugin: "<名>" }  ->  { kind: "plugin:<名>" }
// 与生态既有写法一致: dsh-better-sidebar -> plugin:dsh-better-sidebar,
//   billion-context-dsh -> plugin:billion-context-dsh / plugin:acp-nudge。
//
// 幂等: 已含合规标记则 exit 0 跳过; npm/手装覆盖后下次启动由本钩子恢复。
// 逃生舱: DSH_V4_SOURCE_KINDS=off 时跳过。
// 备份: 首次改写前留 <file>.prepatch-bak（已存在则不覆盖）; 校验不过自动回滚。
// 用法: node patch-v4-source-kinds.mts [--check]
//       exit 0 = 已修/已是最新/未安装; exit 1 = 改写失败或校验不过
import { existsSync, readFileSync, writeFileSync, renameSync, copyFileSync, rmSync, readdirSync } from 'node:fs'

const home = process.env.USERPROFILE || process.env.HOME || ''
const NM = `${home}/.dsh/profiles/web/node_modules`
const CHECK = process.argv.includes('--check')

const log = (m) => console.log(`[v4-src] ${m}`)
const count = (hay, needle) => (needle === '' ? 0 : hay.split(needle).length - 1)

if (String(process.env.DSH_V4_SOURCE_KINDS ?? '').toLowerCase() === 'off') {
  log('DSH_V4_SOURCE_KINDS=off，跳过')
  process.exit(0)
}

// ---- 目标 A: dsh-graded-mode -------------------------------------------------
const G_LEGACY = "source: { kind: 'plugin', plugin: 'dsh-graded-mode' }"
const G_OWNED = "source: { kind: 'plugin:dsh-graded-mode' }"

/**
 * 每个目标: 读文本 -> 由 plan(text) 产出编辑项（取决于该文件的换行风格）-> 应用 -> 校验。
 * plan 必须产出「预期命中次数」, 上游一旦改形状就拒绝改写而不是猜。
 */
const TARGETS = [
  {
    label: 'dsh-graded-mode/lib/index.js',
    file: `${NM}/@dsh-external/dsh-graded-mode/lib/index.js`,
    plan: () => [{ from: G_LEGACY, to: G_OWNED, expect: 1 }],
    markers: [{ text: G_OWNED, expect: 1 }],
  },
  {
    label: 'dsh-graded-mode/lib/tools.js',
    file: `${NM}/@dsh-external/dsh-graded-mode/lib/tools.js`,
    plan: () => [{ from: G_LEGACY, to: G_OWNED, expect: 3 }],
    markers: [{ text: G_OWNED, expect: 3 }],
  },
  {
    label: 'dsh-graded-mode/src/index.js',
    file: `${NM}/@dsh-external/dsh-graded-mode/src/index.js`,
    plan: () => [{ from: G_LEGACY, to: G_OWNED, expect: 1 }],
    markers: [{ text: G_OWNED, expect: 1 }],
  },
  {
    label: 'dsh-graded-mode/src/tools.js',
    file: `${NM}/@dsh-external/dsh-graded-mode/src/tools.js`,
    plan: () => [{ from: G_LEGACY, to: G_OWNED, expect: 3 }],
    markers: [{ text: G_OWNED, expect: 3 }],
  },
]

let failed = false
let changed = 0
let skipped = 0

for (const t of TARGETS) {
  if (!existsSync(t.file)) {
    log(`${t.label}: 未安装（缺文件），跳过`)
    skipped++
    continue
  }

  let before
  try {
    before = readFileSync(t.file, 'utf8')
  } catch (e) {
    log(`${t.label}: 读取失败 ${String(e?.message ?? e)}`)
    failed = true
    continue
  }

  const edits = t.plan(before)
  const legacyHits = edits.reduce((n, e) => n + count(before, e.from), 0)
  // 规范化比较（去 CR）用于「已修」判定, 避免 CRLF/LF 误判
  const flat = (s) => s.split('\r\n').join('\n')
  const markerHits = (t.markers ?? []).reduce(
    (n, m) => n + count(m.normalize ? flat(before) : before, m.text),
    0,
  )
  const markerTotal = (t.markers ?? []).reduce((n, m) => n + m.expect, 0)

  if (legacyHits === 0 && markerHits === markerTotal) {
    log(`${t.label}: 已是合规写法（合规标记 ×${markerHits}），跳过`)
    skipped++
    continue
  }
  if (legacyHits === 0) {
    log(`${t.label}: 未找到退役字面量、也未达合规标记（${markerHits}/${markerTotal}）—— 上游形状已变，请人工核对，跳过`)
    skipped++
    continue
  }
  if (legacyHits !== edits.reduce((n, e) => n + e.expect, 0)) {
    log(`${t.label}: 退役字面量命中 ${legacyHits} 次（预期 ${edits.reduce((n, e) => n + e.expect, 0)} 次），拒绝改写以免误伤`)
    failed = true
    continue
  }

  log(`${t.label}: 发现退役 source kind ×${legacyHits}`)
  if (CHECK) continue

  const backup = `${t.file}.prepatch-bak`
  if (!existsSync(backup)) {
    try {
      copyFileSync(t.file, backup)
      log(`${t.label}: 已备份 → ${backup}`)
    } catch (e) {
      log(`${t.label}: 备份失败 ${String(e?.message ?? e)}`)
      failed = true
      continue
    }
  }

  let after = before
  for (const e of edits) after = after.split(e.from).join(e.to)

  const tmp = `${t.file}.patch-tmp`
  try {
    writeFileSync(tmp, after, 'utf8')
    renameSync(tmp, t.file) // 原子替换
  } catch (e) {
    log(`${t.label}: 写入失败 ${String(e?.message ?? e)}`)
    if (existsSync(tmp)) rmSync(tmp, { force: true })
    failed = true
    continue
  }

  // 校验: 坏形状清零 且 合规标记到位; 否则从备份回滚
  const now = readFileSync(t.file, 'utf8')
  const badLeft = edits.reduce((n, e) => n + count(now, e.from), 0)
  const goodNow = (t.markers ?? []).reduce(
    (n, m) => n + count(m.normalize ? flat(now) : now, m.text),
    0,
  )
  if (badLeft !== 0 || goodNow !== markerTotal) {
    log(`${t.label}: 校验失败（残留 ${badLeft}，合规 ${goodNow}/${markerTotal}）—— 回滚`)
    try {
      copyFileSync(backup, t.file)
    } catch (e) {
      log(`${t.label}: 回滚也失败：${String(e?.message ?? e)}`)
    }
    failed = true
    continue
  }

  log(`${t.label}: 已改写 ${legacyHits} 处 → plugin:<名>（合规标记 ×${goodNow}）`)
  changed++
}

// ---- 残余风险提示（只报不修） ------------------------------------------------
// billion-context-dsh/node_modules/@deepseek-ai/* 是一整套 0.1.5-rc.2 的 vendored 依赖
// (38 个 junction; ACP 的 peerDeps 钉死 >=0.1.5-alpha.1 <0.1.6-0)。其中的 dsh-agent-loop
// 仍写着 const SOURCE = "@deepseek-ai/dsh-system-prompt" + 裸 kind:"plugin"（与历史毒行
// 的 form:"snapshot" 形状一致）。只要这些副本被解析到, 就会写出非法 source。
// 不做字符串改写（那是依赖布局问题, 改 vendored 代码只会掩盖真实症状）——仅计数告警。
const NESTED = `${NM}/billion-context-dsh/node_modules/@deepseek-ai`

function countRetiredInNested() {
  const LEGACY_CODE = /kind:\s*["']plugin["']/g
  let files = 0
  let hits = 0
  const stack = [NESTED]
  while (stack.length) {
    const dir = stack.pop()
    let ents
    try {
      ents = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of ents) {
      const p = `${dir}/${e.name}`
      if (e.isDirectory()) {
        stack.push(p)
      } else if (e.name.endsWith('.js')) {
        let t
        try {
          t = readFileSync(p, 'utf8')
        } catch {
          continue
        }
        const n = (t.match(LEGACY_CODE) ?? []).length
        if (n > 0) {
          files++
          hits += n
        }
      }
    }
  }
  return { files, hits }
}

if (existsSync(NESTED)) {
  const { files, hits } = countRetiredInNested()
  if (hits > 0) {
    log(`提示: vendored 依赖树内仍有退役形状 ×${hits}（${files} 个文件）@ ${NESTED.replace(NM, '…')}`)
    log('      本脚本不修改它（依赖布局问题）。若该副本被解析到，仍会写出非法 source。')
  }
}

log(`完成：改写 ${changed} 个文件，跳过 ${skipped} 个${CHECK ? '（--check：未写入）' : ''}`)
process.exit(failed ? 1 : 0)
