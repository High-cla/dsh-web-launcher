// patch-context-compression-selector.mts — dsh-context-compression-selector@0.1.0 的两处缺陷修复
//
// ═══ 补丁 1: publish-race — 并发发布撞 EPERM，导致整个 resume 失败 ═══
// 背景: PresetOverlayStore.overlay() 为每个 preset 重新生成 composition 并原子发布:
//     const path = join(root, `${preset.id}-${identity}.agent.cordis.yml`);
//     ... write staging -> chmod 600 -> disambiguateStamp(改 mtime 做 standing stamp)
//     await rename(staging, path);                        // 无重试、无回退
//   目标路径按 **preset** 命名 (mcp-opt / ptc / cordis), 不含 session —— 所有用同一 preset
//   的会话共享同一目标文件。于是任意两个并发 overlay() 会并发 rename 同一目标; Windows 上
//   rename 覆盖已存在文件时, 只要有其他发布者或读者持有句柄, 就返回 EPERM, 而该错误直接把
//   整个 resume 打成失败:
//       EPERM: operation not permitted, rename '...\<id>.tmp' -> '...agent.cordis.yml'
// 复现: 40 路并发 mount 同一 preset -> ok=18 / EPERM=22; 顺序 20 次 -> 20/20。结构性竞态。
// 做法: ① publish() 按目标路径去重并发发布; ② swap() 对 EPERM/EACCES/EBUSY/EEXIST 退避重试
//   (约 2s 上限), 目标内容已与本次 rendered 逐字节相同则直接视为成功 (同 identity => 同
//   rendered, 正是 resume 重入的常见情形); ③ 去重入口 promise 永不 reject (错误经 entry.error
//   传递), 避免无人 await 时 unhandledRejection 打崩 host。
//
// ═══ 补丁 2: relative-entry-anchor — 生成物搬家后相对 loader entry 断裂 ═══
// 背景: overlay 把改写后的 composition 落到自己的 owner-only temp 根目录, 但配方里的相对
//   说明符被原样带过去:
//       - id: mcp-guidance
//         name: ./plugins/mcp-guidance.js
//   相对说明符按**生成文件所在目录**解析 -> 变成 <tempRoot>/plugins/mcp-guidance.js -> 不存在:
//       preset "mcp-opt" failed to mount: failed to import loader entry mcp-guidance
//       (./plugins/mcp-guidance.js): Cannot find module '...\presets-XXXX\plugins\mcp-guidance.js'
//   本机 3 个 preset 中 2 个中招 (mcp-opt 的 ./plugins/mcp-guidance.js、router-standard 的
//   ./router-bootstrap-v1.mjs)。**此缺陷与平台无关**(Linux 上同样解析到 temp 目录), 只是被
//   补丁 1 修掉的 EPERM 掩盖着 —— 发布一旦成功, 挂载就走到 import 这一步才暴露。
// 做法: 渲染前把以 ./ 或 ../ 开头的 entry name 按**源 preset 所在目录**重锚为绝对路径
//   (递归进 group 的 config 数组)。绝对路径正是本插件自己注入模块 entry 用的形状
//   (见生成物里的 `name: C:\...\dsh-compaction-basic\lib\index.js`), 故 loader 接受。
//   ⚠ query-aware: 带缓存戳的相对入口 (router-standard v34 的 `./router-bootstrap-v34.mjs?v=88`)
//   不能重锚成裸盘符路径 —— dsh-agent-presets 的 classifyRowSpecifier 对 isAbsolute(name) 走
//   pathToFileURL(name), 会把 "?" 编码成 %3F 当成文件名的一部分, 于是找不到文件。故带 "?" 的
//   入口改输出 `file:///C:/.../x.mjs?v=88`: kind=file -> new URL -> fileURLToPath 丢掉 query,
//   isFile 判定与 import 都成立, 且保留作者的破缓存语义。
//
// 安全性: lib/invariant.js 的 install 是空实现 (注释明写 "No runtime invariant"), 改 lib 不会触发自校验。
// 幂等: 每个补丁各自判标记, 已打则跳过。pnpm 更新/重装该包会覆盖 lib, 需重打 (启动器钩子负责)。
// 用法: node patch-context-compression-selector.mts   (exit 0 = 成功/已打/上游已修/锚点漂移跳过)
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'

const home = process.env.USERPROFILE || ''
const target = join(home, '.dsh', 'profiles', 'web', 'node_modules',
  'dsh-context-compression-selector', 'lib', 'index.js')

const PUBLISH_IMPL = [
  '\t/** In-flight publications per destination path (local patch: Windows EPERM race guard). */',
  '\tpublications = /* @__PURE__ */ new Map();',
  '\t/**',
  '\t* Publish one generation, serializing concurrent callers that share a path.',
  '\t* Every session using one preset shares one destination, so concurrent mounts',
  '\t* raced on the same rename and lost with EPERM.',
  '\t*/',
  '\tasync publish(staging, path, rendered) {',
  '\t\tconst inFlight = this.publications.get(path);',
  '\t\tif (inFlight !== void 0) {',
  '\t\t\tawait inFlight.promise;',
  '\t\t\tif (inFlight.error !== void 0) throw inFlight.error;',
  '\t\t\tawait rm(staging, { force: true });',
  '\t\t\treturn;',
  '\t\t}',
  '\t\tconst entry = { error: void 0, promise: void 0, settle: void 0 };',
  '\t\tentry.promise = new Promise((resolve) => {',
  '\t\t\tentry.settle = resolve;',
  '\t\t});',
  '\t\tthis.publications.set(path, entry);',
  '\t\ttry {',
  '\t\t\tawait this.swap(staging, path, rendered);',
  '\t\t} catch (error) {',
  '\t\t\tentry.error = error;',
  '\t\t\tthrow error;',
  '\t\t} finally {',
  '\t\t\tthis.publications.delete(path);',
  '\t\t\tentry.settle();',
  '\t\t}',
  '\t}',
  '\t/** Swap staging into place, surviving the Windows rename contention window. */',
  '\tasync swap(staging, path, rendered) {',
  '\t\tfor (let attempt = 0; attempt < 12; attempt += 1) {',
  '\t\t\ttry {',
  '\t\t\t\tawait rename(staging, path);',
  '\t\t\t\treturn;',
  '\t\t\t} catch (error) {',
  '\t\t\t\tconst code = error?.code;',
  '\t\t\t\tif (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY" && code !== "EEXIST") throw error;',
  '\t\t\t\tif (await this.isCurrent(path, rendered)) {',
  '\t\t\t\t\tawait rm(staging, { force: true });',
  '\t\t\t\t\treturn;',
  '\t\t\t\t}',
  '\t\t\t\tawait new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));',
  '\t\t\t}',
  '\t\t}',
  '\t\tawait writeFile(path, rendered, {',
  '\t\t\tencoding: "utf8",',
  '\t\t\tmode: 384',
  '\t\t});',
  '\t\tawait rm(staging, { force: true });',
  '\t}',
  '\t/** Whether the published file already carries exactly this generation. */',
  '\tasync isCurrent(path, rendered) {',
  '\t\ttry {',
  '\t\t\treturn await readFile(path, "utf8") === rendered;',
  '\t\t} catch {',
  '\t\t\treturn false;',
  '\t\t}',
  '\t}',
].join('\n')

const ENTRY_IMPL = [
  '/**',
  '* Resolve one preset-relative specifier, keeping a cache-busting query.',
  '* The harness classifies a bare drive-letter path with pathToFileURL(), which',
  '* percent-encodes "?" into the file name and loses the file; a file: URL keeps',
  '* the query in the URL, where Node ignores it for the lookup and still folds it',
  '* into the module cache key (the author writes "./x.mjs?v=88" exactly for that).',
  '*/',
  'function absolutizeSpecifier(base, name) {',
  '\tconst at = name.indexOf("?");',
  '\tif (at === -1) return resolve(base, name);',
  '\treturn pathToFileURL(resolve(base, name.slice(0, at))).href + name.slice(at);',
  '}',
  '',
  '/**',
  '* Re-anchor relative loader entry specifiers onto the source preset directory.',
  '* The overlay relocates a preset into an owner-only temp root, so a specifier',
  '* like "./plugins/mcp-guidance.js" would otherwise resolve against the generated',
  '* composition and fail to import with "Cannot find module".',
  '*/',
  'function absolutizeEntryPaths(rows, presetPath) {',
  '\tconst base = dirname(presetPath);',
  '\tconst visit = (list) => list.map((row) => {',
  '\t\tif (row === null || typeof row !== "object") return row;',
  '\t\tconst name = row.name;',
  '\t\tlet next = row;',
  '\t\tif (typeof name === "string" && (name.startsWith("./") || name.startsWith("../"))) next = {',
  '\t\t\t...row,',
  '\t\t\tname: absolutizeSpecifier(base, name)',
  '\t\t};',
  '\t\tif (Array.isArray(next.config)) next = {',
  '\t\t\t...next,',
  '\t\t\tconfig: visit(next.config)',
  '\t\t};',
  '\t\treturn next;',
  '\t});',
  '\treturn visit(rows);',
  '}',
  '',
  '',
].join('\n')

const PATCHES = [
  {
    name: 'publish-race',
    marker: 'await this.publish(staging, path, rendered);',
    steps: [
      { kind: 'replace', from: 'await rename(staging, path);', to: 'await this.publish(staging, path, rendered);', expect: 1 },
      { kind: 'append-after', anchor: 'standingKeys = /* @__PURE__ */ new Map();', text: PUBLISH_IMPL, expect: 1 },
    ],
    done: '按路径去重发布 + rename 退避重试 + 同内容直接接受',
  },
  {
    name: 'relative-entry-anchor',
    marker: 'absolutizeEntryPaths(parseRows(source, preset.path), preset.path)',
    steps: [
      { kind: 'replace', from: 'import { isAbsolute, join } from "node:path";', to: 'import { dirname, isAbsolute, join, resolve } from "node:path";', expect: 1 },
      { kind: 'replace', from: 'import { fileURLToPath } from "node:url";', to: 'import { fileURLToPath, pathToFileURL } from "node:url";', expect: 1 },
      { kind: 'replace', from: 'const rows = parseRows(source, preset.path);', to: 'const rows = absolutizeEntryPaths(parseRows(source, preset.path), preset.path);', expect: 1 },
      { kind: 'insert-before', anchor: '/** Remove any prior compression implementation before adding the canonical one. */', text: ENTRY_IMPL, expect: 1 },
    ],
    done: '相对 loader entry 说明符按源 preset 目录重锚为绝对路径',
  },
]

if (!existsSync(target)) {
  console.error(`[cc-selector] 目标不存在: ${target}`)
  process.exit(1)
}

const count = (haystack, needle) => haystack.split(needle).length - 1
let src = readFileSync(target, 'utf8')
const backup = target + '.patch-bak'
const applied = []
const skipped = []

for (const patch of PATCHES) {
  if (src.includes(patch.marker)) {
    skipped.push(`${patch.name}: 已打`)
    continue
  }
  // 先整体验锚点，任一不符则整块跳过（不半打，不阻塞启动）
  let anchorsOk = true
  for (const step of patch.steps) {
    const needle = step.kind === 'replace' ? step.from : step.anchor
    if (count(src, needle) !== step.expect) anchorsOk = false
  }
  if (!anchorsOk) {
    skipped.push(`${patch.name}: 锚点不符预期(上游可能已修复或结构已变)`)
    continue
  }
  if (!existsSync(backup)) copyFileSync(target, backup)
  for (const step of patch.steps) {
    if (step.kind === 'replace') src = src.split(step.from).join(step.to)
    else if (step.kind === 'append-after') src = src.replace(step.anchor, () => step.anchor + '\n' + step.text)
    else src = src.replace(step.anchor, () => step.text + step.anchor)
  }
  applied.push(patch.name)
}

if (applied.length > 0) {
  writeFileSync(target, src)
  // 写入后逐个校验标记
  const check = readFileSync(target, 'utf8')
  const broken = PATCHES.filter((p) => applied.includes(p.name) && !check.includes(p.marker))
  if (broken.length > 0) {
    console.error(`[cc-selector] 写入后校验失败: ${broken.map((p) => p.name).join(', ')}`)
    console.error(`[cc-selector] 备份保留待人工核对: ${backup}`)
    process.exit(1)
  }
}

for (const p of PATCHES) {
  if (applied.includes(p.name)) console.log(`[cc-selector] [应用] ${p.name} — ${p.done}`)
}
for (const s of skipped) console.log(`[cc-selector] [跳过] ${s}`)
if (applied.length === 0) console.log('[cc-selector] 无需改动 (全部补丁已在位或上游已修复)')
else {
  console.log(`[cc-selector] 备份: ${backup}`)
  console.log('[cc-selector] 提示: 运行中的 dsh 需重启该 bundle 后才生效')
}
