// patch-pi-ai-output-clamp.mts — 修 @earendil-works/pi-ai 的输出预算塌缩（v2 · 0.2.2-rc.2 锚点）
//
// 症状: 模型回答中途被切断, 末尾 incomplete_details: { reason: "max_output_tokens" }。
//
// 根因: DSH 把**未压缩**的本地历史交给 pi-ai 估算输出余量；bili (billion-context) 在 DSH 下游压缩,
//   改的是线上 messages, 不改 max_output_tokens。本地历史一旦超窗, 剩余余量变负, 被
//   Math.max(MIN_MAX_TOKENS=1, ...) 兜到 1, 再被 Responses 的 16 地板抬起 -> 声明的 128000 输出预算塌成 16。
//
// 0.2.2-rc.2 的上游结构 (dist/api/simple-options.js:3-23):
//   const CONTEXT_SAFETY_TOKENS = 4096;
//   const CONTEXT_SAFETY_RATIO = 0.15;
//   const MIN_OUTPUT_WITH_RATIO_MARGIN = 32768;
//   const MIN_MAX_TOKENS = 1;
//   export function clampMaxTokensToContext(model, context, maxTokens) {
//       if (model.contextWindow <= 0) return Math.max(MIN_MAX_TOKENS, maxTokens);
//       const input = estimateContextTokens(context).tokens;
//       const margin = Math.max(CONTEXT_SAFETY_TOKENS, Math.ceil(input * CONTEXT_SAFETY_RATIO));
//       let room = model.contextWindow - input - margin;
//       if (room < MIN_OUTPUT_WITH_RATIO_MARGIN) {
//           room = Math.min(MIN_OUTPUT_WITH_RATIO_MARGIN, model.contextWindow - input - CONTEXT_SAFETY_TOKENS);
//       }
//       return Math.min(maxTokens, Math.max(MIN_MAX_TOKENS, room));
//   }
//   新增的 ratio margin 分支**没有**解决问题: 当 input > contextWindow - 4096 时
//   "model.contextWindow - input - CONTEXT_SAFETY_TOKENS" 为负 -> room 为负 -> 仍然兜到 1。塌缩路径原样存在。
//
// 补丁: 只在最后的兜底里加一个地板, 不改变其它任何语义:
//   return Math.min(maxTokens, Math.max(MIN_MAX_TOKENS, DSH_OUTPUT_CLAMP_FLOOR, room));
//   地板仍在 Math.min(maxTokens, ...) 之内, 所以小 cap (标题生成 1024) 不被抬高, 大 cap 也不会更早截断。
//
// 锚点策略 (v1 的两个固定字符串锚点已随上游改版失效: const=1, ret=0):
//   不再是"整行文本相等", 而是结构定位 —— 找到 function clampMaxTokensToContext 的函数体 (花括号配平),
//   在体内匹配 return Math.min(maxTokens, Math.max(MIN_MAX_TOKENS, <ident>)); 必须**恰好一处**,
//   与变量名叫 available 还是 room 无关。锚点失效即 exit 1 + 人话原因, 不再静默。
//
// 幂等: 已含标记则跳过。npm install -g @deepseek-ai/dsh 会整体替换该依赖, 故每次启动重放。
// 逃生舱: DSH_PI_OUTPUT_CLAMP=upstream 跳过补丁; DSH_PI_OUTPUT_CLAMP_FLOOR=<n> 覆盖地板 (默认 16384)
// 用法: node patch-pi-ai-output-clamp.mts [--check]
//       exit 0 = 已修/无需修/未安装; exit 1 = 改写失败或校验不过
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'

const home = process.env.USERPROFILE || process.env.HOME || ''
const TARGET = home
  + '/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules'
  + '/@earendil-works/pi-ai/dist/api/simple-options.js'

const MARK = 'DSH-PATCH:output-clamp-floor'
const CHECK = process.argv.includes('--check')
const log = (m) => console.log('[pi-ai-clamp] ' + m)

const mode = (process.env.DSH_PI_OUTPUT_CLAMP || '').trim().toLowerCase()
if (mode === 'upstream') {
  log('DSH_PI_OUTPUT_CLAMP=upstream — 保留上游原始行为, 跳过')
  process.exit(0)
}

const floorOf = () => {
  const raw = (process.env.DSH_PI_OUTPUT_CLAMP_FLOOR || '').trim()
  if (raw === '') return 16384
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : 16384
}
const FLOOR = floorOf()

if (!existsSync(TARGET)) {
  log('未安装 @earendil-works/pi-ai — 跳过')
  process.exit(0)
}

const src = readFileSync(TARGET, 'utf8')
if (src.includes(MARK)) {
  log('已含补丁标记 — 跳过')
  process.exit(0)
}

const FN = 'function clampMaxTokensToContext('
const RET_SRC = 'return Math\\.min\\(maxTokens, Math\\.max\\(MIN_MAX_TOKENS, ([A-Za-z_$][A-Za-z0-9_$]*)\\)\\);'

// 函数体定位: 从签名后的第一个 { 起做花括号配平 (该函数体内无字符串/模板/注释含花括号)
const fnAt = src.indexOf(FN)
if (fnAt < 0) {
  log('锚点失效: 未找到 ' + FN + ' — 上游结构已变, 拒绝改写')
  process.exit(1)
}
const bodyOpen = src.indexOf('{', fnAt)
if (bodyOpen < 0) {
  log('锚点失效: 函数签名后无函数体 — 拒绝改写')
  process.exit(1)
}
let depth = 0
let bodyEnd = -1
for (let i = bodyOpen; i < src.length; i += 1) {
  const ch = src[i]
  if (ch === '{') depth += 1
  else if (ch === '}') {
    depth -= 1
    if (depth === 0) { bodyEnd = i; break }
  }
}
if (bodyEnd < 0) {
  log('锚点失效: 函数体花括号未配平 — 拒绝改写')
  process.exit(1)
}

const body = src.slice(bodyOpen, bodyEnd + 1)
const hits = body.match(new RegExp(RET_SRC, 'g')) || []
if (hits.length !== 1) {
  log('锚点不唯一 (clamp 体内命中 ' + hits.length + ' 处兜底 return) — 上游结构已变, 拒绝改写')
  process.exit(1)
}

if (CHECK) {
  log('需要补丁 (地板=' + FLOOR + ')')
  process.exit(1)
}

const bodyPatched = body.replace(new RegExp(RET_SRC), 'return Math.min(maxTokens, Math.max(MIN_MAX_TOKENS, DSH_OUTPUT_CLAMP_FLOOR, $1));')
if (bodyPatched === body) {
  log('体内替换未生效 — 中止')
  process.exit(1)
}

const constDecl = '// ' + MARK + ' — 阻止输出预算塌到 1 (本地历史估算超窗而线上已被压缩代理缩小时)'
  + String.fromCharCode(10)
  + 'const DSH_OUTPUT_CLAMP_FLOOR = ' + FLOOR + ';'
  + String.fromCharCode(10)
const fnLineStart = src.lastIndexOf(String.fromCharCode(10), fnAt) + 1
const out = src.slice(0, fnLineStart)
  + constDecl
  + src.slice(fnLineStart, bodyOpen)
  + bodyPatched
  + src.slice(bodyEnd + 1)

if (!out.includes(MARK) || !out.includes('DSH_OUTPUT_CLAMP_FLOOR,')) {
  log('改写后校验失败 — 中止')
  process.exit(1)
}

const bak = TARGET + '.prepatch-bak'
if (!existsSync(bak)) {
  try { copyFileSync(TARGET, bak); log('备份 → ' + bak) } catch (e) { log('备份失败: ' + (e && e.message)) }
}

try {
  writeFileSync(TARGET, out)
} catch (e) {
  log('写入失败: ' + (e && e.message))
  process.exit(1)
}

const back = readFileSync(TARGET, 'utf8')
const ok = back.includes(MARK)
  && back.includes('Math.max(MIN_MAX_TOKENS, DSH_OUTPUT_CLAMP_FLOOR,')
  && !(new RegExp(RET_SRC).test(back))
  && Math.abs(back.length - src.length) < 500
log('已修补 simple-options.js (地板=' + FLOOR + ')')
process.exit(ok ? 0 : 1)
