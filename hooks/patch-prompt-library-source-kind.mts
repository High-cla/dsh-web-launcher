// patch-prompt-library-source-kind.mts — 修 @sunjuntao/dsh-prompt-library 的 V4 非法 source kind
//
// 背景: DSH 0.1.7 的 V4 admission 拒绝"退役形状"的插件来源:
//   dsh-session-format-v3-to-v4/lib/index.js:124-127
//     if (... || value["kind"] === "plugin")
//       throw new SessionFormatError("format v4 message requires a producer-owned source kind")
//   合法 kind = 生产者自有名: user / model / tool / runtime-context / plugin:<name>。
//   旧的 { kind: "plugin", plugin: "xxx" } 包装已退役 —— 但它仍然通过 V3→V4 迁移被改成
//   plugin:<name>(worker.cjs:10710-10716 的映射表), 所以插件自己直接写裸 kind 时,
//   坏行会留在内存批次里, **下一轮读取时**才炸, 且毒行与错误文本都不落盘 ——
//   症状表现为"中途突然报错、找不到出处"。
//
// 命中点(唯一): profiles/web/node_modules/@sunjuntao/dsh-prompt-library/lib/index.js:4716
//   在 collectText() 构造 AI 润色/收录的内部调用消息:
//     source: { kind: "plugin", plugin: "prompt-library" }
//   这条消息一旦进入 V4 会话, 该会话下一次读取即失败。
//
// 做法: 纯字符串字面替换(不是语义改动), 改成生产者自有 kind:
//     source: { kind: "plugin:prompt-library" }
//   与 dsh-better-sidebar(lib/index.js:1913 → plugin:dsh-better-sidebar)及
//   billion-context-dsh(dist/index.js:4171/4949 → plugin:billion-context-dsh / plugin:acp-nudge)
//   已采用的写法一致。上游最新版(npm latest = 0.15.0, 2026-09-17)未修, 故本地补。
//
// 幂等: 已含合规标记则 exit 0 跳过。npm/手装覆盖后, 下次启动由本钩子恢复。
// 逃生舱: DSH_PROMPTLIB_SOURCE_KIND=off 时跳过。
// 备份: 首次改写前留一份 lib/index.js.prepatch-bak(已存在则不覆盖); 失败自动回滚。
// 用法: node patch-prompt-library-source-kind.mts [--check]
//       exit 0 = 已修/已是最新/未安装; exit 1 = 改写失败或校验不过
import { existsSync, readFileSync, writeFileSync, renameSync, copyFileSync, rmSync } from 'node:fs'

const home = process.env.USERPROFILE || process.env.HOME || ''
const TARGET = `${home}/.dsh/profiles/web/node_modules/@sunjuntao/dsh-prompt-library/lib/index.js`
const BACKUP = `${TARGET}.prepatch-bak`
const CHECK = process.argv.includes('--check')

// 退役形状(要消除) 与 合规标记(修好的证据)
const LEGACY = 'source: { kind: "plugin", plugin: "prompt-library" }'
const OWNED = 'source: { kind: "plugin:prompt-library" }'
const OWNED_MARKER = 'kind: "plugin:prompt-library"'

const log = (m) => console.log(`[promptlib-src] ${m}`)
const count = (hay, needle) => hay.split(needle).length - 1

if (String(process.env.DSH_PROMPTLIB_SOURCE_KIND ?? '').toLowerCase() === 'off') {
  log('DSH_PROMPTLIB_SOURCE_KIND=off，跳过')
  process.exit(0)
}

if (!existsSync(TARGET)) {
  log(`未安装 @sunjuntao/dsh-prompt-library（缺 ${TARGET}），跳过`)
  process.exit(0)
}

const before = readFileSync(TARGET, 'utf8')
const legacyHits = count(before, LEGACY)
const ownedHits = count(before, OWNED_MARKER)

if (legacyHits === 0 && ownedHits > 0) {
  log(`已是合规写法（${OWNED_MARKER} ×${ownedHits}），跳过`)
  process.exit(0)
}

if (legacyHits === 0) {
  // 上游改了形状：不猜、不硬改，只报告
  log('未找到目标字面量，也未找到合规标记 —— 上游形状已变，请人工核对，跳过')
  process.exit(0)
}

if (legacyHits !== 1) {
  log(`目标字面量出现 ${legacyHits} 次（预期 1 次），拒绝改写以免误伤`)
  process.exit(1)
}

log(`发现退役 source kind ×${legacyHits} @ lib/index.js（对应 :4716 的 collectText）`)
if (CHECK) {
  log('--check：只报告不写入')
  process.exit(0)
}

// 单份稳定备份（不随每次启动堆积）
if (!existsSync(BACKUP)) {
  copyFileSync(TARGET, BACKUP)
  log(`已备份 → ${BACKUP}`)
} else {
  log(`备份已存在，沿用 → ${BACKUP}`)
}

const after = before.split(LEGACY).join(OWNED)
const tmp = `${TARGET}.patch-tmp`
try {
  writeFileSync(tmp, after, 'utf8')
  renameSync(tmp, TARGET) // 原子替换
} catch (e) {
  log(`写入失败：${String(e?.message ?? e)}`)
  if (existsSync(tmp)) rmSync(tmp, { force: true })
  process.exit(1)
}

// 校验：坏形状清零 且 好标记到位；否则从备份回滚
const now = readFileSync(TARGET, 'utf8')
const badLeft = count(now, LEGACY)
const goodNow = count(now, OWNED_MARKER)
if (badLeft !== 0 || goodNow !== legacyHits + ownedHits) {
  log(`校验失败（残留 ${badLeft}，合规 ${goodNow}）—— 回滚`)
  try { copyFileSync(BACKUP, TARGET) } catch (e) { log(`回滚也失败：${String(e?.message ?? e)}`) }
  process.exit(1)
}

log(`已改写：${LEGACY} → ${OWNED}（合规标记 ×${goodNow}）`)
log('生效范围：下次加载该插件时读取新产物；已存在的坏会话历史需另行处理(见 tmp-inspect/session.full.jsonl)')
process.exit(0)
