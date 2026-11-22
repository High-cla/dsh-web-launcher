// patch-session-format-compat.mts — 让 dsh 的 v0 会话格式校验容忍 ACP 写入的扩展成员
//
// [acp-extra-members] ACP(billion-context) 会往 compaction/summary 事件 data 里写扩展成员
//   (tier / kernelBlockId / topic / parentBlockIds / directMessageIds / effectiveMessageIds)。
//   dsh 的 v0→v1 迁移器按『已发布 v0 冻结清单』严格校验，遇到清单外成员即拒绝整个会话：
//     refuses this format v0 Session: compaction/summary <seq> data has unexpected member "tier"
//   做法: 把这 6 个成员加入 compaction/summary 的允许清单。v2/v3 校验表由 v0 表派生
//   (dsh-session-format-v1-to-v2: const retained = ...RELEASED_V0_EVENT_DISPOSITIONS)，故单点补丁覆盖整条迁移链。
//
// [removed 2026-11-05] legacy-descriptor 子补丁已删除：上游 0.2.2-rc.1 自行修好了
//   (@deepseek-ai/dsh-session-format-v0-to-v1/lib/index.js:1608 改为 SUBAGENT_DESCRIPTOR_VERSIONS
//    白名单判定；:1294 literalValue(data.version, SUBAGENT_DESCRIPTOR_VERSIONS, ...)；:1302 起按 version === 1 分支)。
//   旧锚点已不存在，继续保留只会每次启动打一条假的 [warn]。
//
// 幂等: 已打的补丁自动跳过。npm install -g 更新 dsh 会整包覆盖 = 擦掉补丁，需更新后重打。
// 用法: node patch-session-format-compat.mts   (exit 0 = 成功或已打; exit 1 = 失败)
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.env.APPDATA || join(process.env.USERPROFILE || '', 'AppData', 'Roaming')
const target = join(root, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules',
  '@deepseek-ai', 'dsh-session-format-v0-to-v1', 'lib', 'index.js')

const EXTRA = ['tier', 'kernelBlockId', 'topic', 'parentBlockIds', 'directMessageIds', 'effectiveMessageIds']

const OLD = `\t"compaction/summary": disposition([
\t\t"compactionId",
\t\t"summary",
\t\t"shadowedRange",
\t\t"shadowedSeqs",
\t\t"shadowedTokenCount",
\t\t"provider",
\t\t"model"
\t], [
\t\t"sourceCommandId",
\t\t"maxTokens",
\t\t"usage",
\t\t"rawOutput",
\t\t"llmStreamCall"
\t]),`

const NEW = `\t"compaction/summary": disposition([
\t\t"compactionId",
\t\t"summary",
\t\t"shadowedRange",
\t\t"shadowedSeqs",
\t\t"shadowedTokenCount",
\t\t"provider",
\t\t"model"
\t], [
\t\t"sourceCommandId",
\t\t"maxTokens",
\t\t"usage",
\t\t"rawOutput",
\t\t"llmStreamCall",
${EXTRA.map((k) => '\t\t' + JSON.stringify(k)).join(',\n')}
\t]),`

if (!existsSync(target)) {
  console.error(`[session-format] 目标不存在: ${target}`)
  process.exit(1)
}

const src = readFileSync(target, 'utf8')

if (src.includes('"kernelBlockId"')) {
  console.log('[session-format] acp-extra-members: 已打，跳过')
  process.exit(0)
}

if (!src.includes(OLD)) {
  console.error('[session-format] acp-extra-members: 锚点未找到 —— dsh 版本结构可能已变化，需人工核对')
  process.exit(1)
}

const backup = target + '.patch-bak'
if (!existsSync(backup)) copyFileSync(target, backup)
writeFileSync(target, src.replace(OLD, NEW))

const check = readFileSync(target, 'utf8')
if (!check.includes('"kernelBlockId"')) {
  console.error('[session-format] 写入后校验失败')
  process.exit(1)
}
console.log(`[session-format] acp-extra-members: 已应用 (备份: ${backup})`)