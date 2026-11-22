// dsh-agua-patch.mts — 让 ag provider 的显式 user-agent 不被 attributionHeaders() 覆盖
// v1 (<=0.2.1-rc.x) 打的是 `function requestHeaders(headers)` 的纯对象版本；
// 0.2.2-rc.1 改写成 `function requestHeaders(configured, options, baseURL, prepare)` + Headers，
// 并在 prepare 之后无条件用 attributionHeaders() 覆盖（dsh-llm 里它只返回 user-agent），
// v1 的整段文本锚点因此失效。v2 改为在 attribution 循环之后把 configured 里显式给的
// user-agent 重新 set 回去 —— 与 v1 语义等价。
// 幂等: 已打则跳过。npm install -g 更新 dsh 会整包覆盖 = 擦掉此补丁，需更新后重打。
// 用法: node dsh-agua-patch.mts   (exit 0 = 成功或已打; exit 1 = 失败)
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.env.APPDATA || join(process.env.USERPROFILE || '', 'AppData', 'Roaming')
const target = join(root, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules',
  '@deepseek-ai', 'dsh-llm-pi-ai', 'lib', 'index.js')

const FUNC = 'function requestHeaders(configured, options, baseURL, prepare) {'
const LOOP = 'for (const [name, value] of Object.entries(attributionHeaders())) headers.set(name, value);'
const MARK = 'if (name.toLowerCase() === "user-agent") headers.set(name, value);'
const TAIL = 'return Object.fromEntries(headers);'

if (!existsSync(target)) {
  console.error('[agua] 目标不存在: ' + target)
  process.exit(1)
}

const src = readFileSync(target, 'utf8')

if (src.includes(MARK)) {
  console.log('[agua] 补丁已存在，跳过')
  process.exit(0)
}

const fnAt = src.indexOf(FUNC)
if (fnAt < 0) {
  console.error('[agua] 未找到 requestHeaders(configured, options, baseURL, prepare)——dsh 结构又变了，需人工处理')
  process.exit(1)
}

const loopAt = src.indexOf(LOOP, fnAt)
if (loopAt < 0) {
  console.error('[agua] requestHeaders 内未找到 attributionHeaders 覆盖循环——需人工处理')
  process.exit(1)
}

const tailAt = src.indexOf(TAIL, loopAt)
if (tailAt < 0 || tailAt - loopAt > 400) {
  console.error('[agua] attribution 循环后未见 return Object.fromEntries(headers)——需人工处理')
  process.exit(1)
}

const lineStart = src.lastIndexOf('\n', loopAt) + 1
const indent = src.slice(lineStart, loopAt)
const insert = '\n' + indent + 'for (const [name, value] of Object.entries(configured ?? {})) ' + MARK
const out = src.slice(0, loopAt + LOOP.length) + insert + src.slice(loopAt + LOOP.length)

copyFileSync(target, target + '.bak-agua')
writeFileSync(target, out, 'utf8')
console.log('[agua] 补丁已重打 (v2: Headers 版 requestHeaders, UA 在 attribution 之后回写)')
process.exit(0)