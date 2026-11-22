// 宿主 @deepseek-ai/dsh-subprocess-local 的两处终端补丁（幂等；锚点失效即 exit 1 并说明原因）。
// ① [dsh-patch:terminal-pid]  node-pty 1.2.0-beta.15 构造期 pid 为 0（真 pid 要等 ready_datapipe），
//    宿主 Terminal 构造时一次性取值 ⇒ pid=0 / rootIdentity=undefined / close 报 `surviving pid: 0`。
// ② [dsh-patch:conpty-dll]  本机 node-pty 的打包控制台宿主（useConptyDll:true → conpty.dll + OpenConsole.exe，1.25.260303002）
//    实测只吐 23 字节终端模式序列，不出提示符、不执行命令（原生 conhost 正常）。改为默认走系统控制台宿主，
//    想恢复旧行为设 DSH_CONPTY_DLL=1。
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const APPDATA = process.env.APPDATA || join(process.env.USERPROFILE || process.env.HOME || '', 'AppData', 'Roaming');
const LIB = process.env.DSH_SUBPROCESS_LOCAL_LIB || join(APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-subprocess-local', 'lib', 'index.js');
if (!existsSync(LIB)) { console.error('[terminal-patch] 宿主文件不存在: ' + LIB); process.exit(1); }

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const bak = join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'launcher-backups', 'subprocess-local-index.js.pre-terminal-' + stamp + '.bak');
mkdirSync(dirname(bak), { recursive: true });
let patched = 0;
let lines = readFileSync(LIB, 'utf8').split('\n');

// ---------- ① pid ----------
const PID_MARK = '[dsh-patch:terminal-pid]';
const PID_ANCHOR = 'this.pid = terminal.pid;';
if (readFileSync(LIB, 'utf8').includes(PID_MARK)) {
  console.log('[terminal-pid] 补丁已存在，跳过');
} else {
  const idx = lines.findIndex((l) => l.trim() === PID_ANCHOR);
  if (idx < 0) { console.error('[terminal-pid] 锚点未找到（this.pid = terminal.pid;），上游已改结构，需重新定位'); process.exit(1); }
  const pad = (lines[idx].match(/^\s*/) || [''])[0];
  const block = [
    pad + '/* ' + PID_MARK + ' node-pty 1.2.0-beta.15 构造期 pid 恒为 0，真 pid 在 ready_datapipe 之后才发布； */',
    pad + '/* 宿主在此处一次性取值 ⇒ pid=0 / rootIdentity=undefined / close 报 surviving pid: 0。下面在 ≤1s 内补取一次。 */',
    pad + 'if (!this.pid) {',
    pad + '  let dshPidTries = 0;',
    pad + '  const dshPidTimer = setInterval(() => {',
    pad + '    const live = terminal.pid;',
    pad + '    if (live) {',
    pad + '      this.pid = live;',
    pad + '      try { this.rootIdentity = inspector.snapshot().tree(live).find((member) => member.pid === live); } catch (_) { this.rootIdentity = void 0; }',
    pad + '      clearInterval(dshPidTimer);',
    pad + '      return;',
    pad + '    }',
    pad + '    if (++dshPidTries >= 100) clearInterval(dshPidTimer);',
    pad + '  }, 10);',
    pad + '  if (typeof dshPidTimer.unref === \'function\') dshPidTimer.unref();',
    pad + '}',
  ];
  copyFileSync(LIB, bak);
  lines.splice(idx + 1, 0, ...block);
  writeFileSync(LIB, lines.join('\n'), 'utf8');
  console.log('[terminal-pid] 已应用（backup=' + bak + '）');
  patched++;
}

// ---------- ② conpty dll ----------
const DLL_MARK = '[dsh-patch:conpty-dll]';
const text2 = readFileSync(LIB, 'utf8');
if (text2.includes(DLL_MARK)) {
  console.log('[conpty-dll] 补丁已存在，跳过');
} else {
  lines = text2.split('\n');
  const i = lines.findIndex((l) => l.includes('useConptyDll: true'));
  if (i < 0) { console.error('[conpty-dll] 锚点未找到（useConptyDll: true），上游已改结构，需重新定位'); process.exit(1); }
  const before = lines[i];
  if (!before.includes('platform === "win32" ?')) { console.error('[conpty-dll] 该行结构已变，拒绝改写: ' + before.trim()); process.exit(1); }
  const pad = (before.match(/^\s*/) || [''])[0];
  const after = before.replace('platform === "win32" ?', 'platform === "win32" && process.env.DSH_CONPTY_DLL === "1" ?');
  lines.splice(i, 0, pad + '/* ' + DLL_MARK + ' 打包控制台宿主在本机只吐 23 字节初始化序列、不执行命令；默认改用系统 conhost，DSH_CONPTY_DLL=1 可回退 */');
  lines[i + 1] = after;
  writeFileSync(LIB, lines.join('\n'), 'utf8');
  console.log('[conpty-dll] 已应用（改用系统控制台宿主，opt-in 环境变量 DSH_CONPTY_DLL=1）');
  patched++;
}

const final = readFileSync(LIB, 'utf8');
const ok = final.includes(PID_MARK) && final.includes(DLL_MARK) && final.includes('process.env.DSH_CONPTY_DLL === "1"');
console.log('[terminal-patch] patched=' + patched + ' selfCheck=' + (ok ? 'OK' : 'FAIL'));
process.exit(ok ? 0 : 1);