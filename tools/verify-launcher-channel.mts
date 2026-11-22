// verify-launcher-channel.mts — 干跑验证启动器的「更新通道」改造（不真装、不真启动）
//
// 做法：读真实启动器 → 替换三处副作用（npm install / start node / 补丁钩子）→
// 写沙箱副本 → 用 cmd /c 真跑 → 断言分支走向与标记文件内容。
// 覆盖：
//   1) 无标记          → 走更新分支，标记写成 "<通道> <版本>"
//   2) 标记匹配        → 跳过更新（不再重复安装）
//   3) 标记通道不同    → 不跳过（通道感知，避免换通道被旧标记挡掉）
//   4) 沙箱内无真实副作用（副本里 install/start 已被替换成 echo）
//
// 用法: node verify-launcher-channel.mts   (exit 1 = 有失败项)
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const LAUNCHER = process.env.DSH_LAUNCHER || join(process.env.USERPROFILE || process.env.HOME || '', 'Desktop', 'DSH-Web-Launcher.cmd')
const rows: Array<{ step: string; ok: boolean; detail: string }> = []
const add = (step: string, ok: boolean, detail: string) => rows.push({ step, ok, detail })

const dir = mkdtempSync(join(tmpdir(), 'launcher-channel-'))
const marker = join(dir, 'marker.txt')
const sandbox = join(dir, 'test.cmd')

// 沙箱化：不动标记文件位置逻辑本身，只把它指向临时文件；副作用改 echo。
const original = readFileSync(LAUNCHER, 'utf8')
const DRY_VERSION = '9.9.9-test'
let src = original
// 启动器把通道写在一行 set 里；从它解析，而不是假设 alpha。
const CHANNEL = /^set "DSH_CHANNEL=(\w+)"$/m.exec(src)?.[1] ?? 'alpha'
const subs: Array<[RegExp, string, boolean?]> = [
  [/set "MARKER=.*"/, `set "MARKER=${marker}"`],
  [/^call npm install\s+-g.*$/m, 'echo SKIP-INSTALL %LATEST%'],
  // start 有两处（if 分支的 node 版 + else 分支的 Git Bash 版），且都缩进在块内 → 全局替换
  [/^[ \t]*start "DSH-Web".*$/gm, 'echo SKIP-START', true],
  [/^for \/f "delims=" %%v in \('npm view .*$/m, `for /f "delims=" %%v in ('echo ${DRY_VERSION}') do set "LATEST=%%v"`],
  [/^if exist "%USERPROFILE%\\\.dsh\\dsh-web-boot\.mts" \($/m, 'if 1==1 ('],
  [/^pause\r?$/gm, 'echo SKIP-PAUSE', true],
  [/^[ \t]*node "%USERPROFILE%\\\.dsh\\(.*?)\.mts"$/gm, '    echo SKIP-HOOK $1', true],
]
for (const [re, to, all] of subs) {
  if (!re.test(src)) add(`替换规则命中 ${re.source.slice(0, 28)}`, false, '未命中 → 沙箱化不完整')
  src = all ? src.replace(new RegExp(re.source, re.flags), to) : src.replace(re, to)
}
// 门禁：真实副作用残留必须在执行前拦住（旧版只在跑完后报告，曾因此真跑了一次 npm install -g）
const preLeaks: string[] = []
if (/^[ \t]*call npm install\s/im.test(src)) preLeaks.push('npm install')
if (/^[ \t]*start "/im.test(src)) preLeaks.push('start')
if (/^pause\s*$/im.test(src)) preLeaks.push('pause')
if (/^[ \t]*node "%USERPROFILE%\\\.dsh\\[^\n]*\.mts"/im.test(src)) preLeaks.push('hook node call')
if (preLeaks.length > 0) {
  console.log(`FAIL  沙箱化不完整，拒绝执行: ${preLeaks.join(' | ')}`)
  rmSync(dir, { recursive: true, force: true })
  process.exit(1)
}
writeFileSync(sandbox, src.replace(/\r?\n/g, '\r\n'), { encoding: 'utf8' })

const sandboxName = 'test.cmd'
const dirName = dir
const run = (): string => {
  try {
    return execFileSync('cmd.exe', ['/d', '/s', '/c', sandboxName], { encoding: 'utf8', cwd: dirName, stdio: ['ignore', 'pipe', 'pipe'], timeout: 90000 })
  } catch (e: any) {
    return `EXIT ${e.status}\n${String(e.stdout ?? '')}${String(e.stderr ?? '')}`
  }
}

/* 1) 无标记 → 更新分支 + 写出 "<通道> <版本>" */
rmSync(marker, { force: true })
const first = run()
const wroteMarker = existsSync(marker) ? readFileSync(marker, 'utf8').trim() : ''
add('无标记 → 走更新分支', /\[2\/3\] updating dsh/.test(first) && /SKIP-INSTALL/.test(first), 'saw [2/3] and install line')
// 版本可能是预发布串（0.2.1-rc.2），且通道已不是写死的 alpha —— 两者都从启动器实测值来。
add('标记写成 通道+版本', new RegExp(`^${CHANNEL} \\d+\\.\\d+\\.\\d+(-[0-9A-Za-z.-]+)?$`).test(wroteMarker), `channel=${CHANNEL} marker="${wroteMarker}"`)

/* 2) 标记匹配（同通道同版本）→ 跳过 */
const second = run()
add('标记匹配 → 跳过更新', /skipping update/.test(second) && !/SKIP-INSTALL/.test(second), 'no re-install')

/* 3) 标记通道不同（模拟从 latest 切到 alpha）→ 不跳过 */
// 通道从启动器自身解析，不写死：启动器把 DSH_CHANNEL 从 alpha 换成 next 后，写死的 latest 仍是"另一条通道"，语义不变。
const OTHER_CHANNEL = CHANNEL === 'latest' ? 'next' : 'latest'
writeFileSync(marker, `${OTHER_CHANNEL} ${wroteMarker.split(' ')[1]}\r\n`)
const third = run()
add('通道变更 → 不被旧标记挡住', /\[2\/3\] updating dsh/.test(third) && /SKIP-INSTALL/.test(third), 'channel-aware')

/* 4) 通道变量与取版本命令确实按通道解析 */
add('取版本命令带通道', /npm view @deepseek-ai\/dsh@%DSH_CHANNEL% version/.test(original), '@%DSH_CHANNEL% 已注入')

/* 5) 沙箱纯度：副本里不得残留任何真实 install / start / 补丁钩子（允许缩进形态） */
const leaks: string[] = []
if (/^[ \t]*call npm install\s+-g/m.test(src)) leaks.push('npm install')
if (/^[ \t]*start "DSH-Web"/m.test(src)) leaks.push('start')
const hookLeft = [...src.matchAll(/^[ \t]*node "%USERPROFILE%\\\.dsh\\.*?\.mts"/gm)].map((m) => m[0].trim())
if (hookLeft.length > 0) leaks.push(`hook(${hookLeft.length}): ${hookLeft[0].slice(0, 46)}`)
if (!first.includes('SKIP-START')) leaks.push('干跑输出没看到 SKIP-START')
if (!/SKIP-INSTALL/.test(first)) leaks.push('干跑输出没看到 SKIP-INSTALL')
add('沙箱无真实副作用', leaks.length === 0, leaks.length === 0 ? 'install/start/钩子均已替换' : leaks.join(' | '))

rmSync(dir, { recursive: true, force: true })

for (const r of rows) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.step.padEnd(26)} ${r.detail}`)
const bad = rows.filter((r) => !r.ok)
console.log('-'.repeat(64))
console.log(bad.length === 0 ? `全部通过（${rows.length} 项）` : `失败 ${bad.length}/${rows.length}`)
if (bad.length > 0) process.exit(1)
