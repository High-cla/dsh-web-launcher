# 补丁台账

核验基线：`@deepseek-ai/dsh@0.2.2-rc.5`、`@earendil-works/pi-ai@1.5.2`、`@sunjuntao/dsh-prompt-library@1.0.0`、`dsh-live-compact@1.1.12`（核验日期 2026-11-22）。

**核验方法**：把目标包的**纯净 npm 包**拉下来解压，与已装文件逐字 diff。这样才能区分两件容易混淆的事：

- 补丁**仍在起作用** → 纯净包是「未修」形态，已装文件是「已修」形态；
- 补丁**已经过时** → 纯净包自己就是「已修」形态（上游修好了），或目标包根本不存在。

```bash
T="C:/Users/<you>/AppData/Local/Temp/dsh-pristine"
npm pack @deepseek-ai/dsh-llm-pi-ai@0.2.2-rc.5 --pack-destination "$T"
tar -xzf "$T/deepseek-ai-dsh-llm-pi-ai-0.2.2-rc.5.tgz" -C "$T/x"
diff -u "$T/x/package/lib/index.js" "%APPDATA%/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js"
```

> npm 是原生 Windows 程序：`--pack-destination` 必须给 `C:/...` 形式，给 MSYS 的 `/tmp/...` 会以 `C:\tmp\...` 解析并以 ENOENT 失败。

## 保留（6 个，启动器逐个调用）

| 钩子 | 修什么 | 目标文件 | 纯净包状态 |
|---|---|---|---|
| `patch-dsh-install-heal.mts` | `npm install -g` 半装后全局树出现空包目录，dsh 启动即 `ERR_MODULE_NOT_FOUND`（静默闪退） | 全局 `@deepseek-ai/dsh/node_modules/*` | 守卫型，无可比对的锚点 |
| `dsh-agua-patch.mts` | 显式 `user-agent` 被 `attributionHeaders()` 覆盖 | `dsh-llm-pi-ai/lib/index.js` | 未修 |
| `patch-prompt-library-source-kind.mts` | 插件写退役 `source: {kind:'plugin',plugin:'…'}`，V4 准入拒收并让下一轮失败 | `profiles/web/node_modules/@sunjuntao/dsh-prompt-library/lib/index.js` | 未修 |
| `patch-pi-ai-output-clamp.mts` | 本地历史估算超窗 → 输出预算塌成 1/16，回复被截断 | `@earendil-works/pi-ai/dist/api/simple-options.js` | 未修 |
| `patch-subprocess-terminal-pid.mts` | ① node-pty 构造期 `pid=0` → `terminal_close` 报 `surviving pid: 0`；② 打包 conpty.dll 宿主不执行命令 | `dsh-subprocess-local/lib/index.js` | 均未修 |
| `patch-live-compact-gate.mts` | `gate.js` 的 `PRESET_IDS` 缺 `mcp-opt`，默认 preset 的压缩接管失效 | `profiles/web/node_modules/dsh-live-compact/gate.js` | 未修 |

### 1. patch-dsh-install-heal.mts

- 症状：`Error: Cannot find package "…\@deepseek-ai\cordis\index.js" … code ERR_MODULE_NOT_FOUND`，DSH-Web 窗口立刻关闭（看起来是「闪退」）。
- 做法：逐个校验全局 dsh 的依赖目录里 `package.json` 存在且非空壳；缺失则 `npm install -g <同版本> --force`。`--check` 只报告不改动。
- 顺序约束：**它必须是第一个钩子**——重装会整树替换，擦掉其后钩子打的补丁。
- 复验：`node %USERPROFILE%\.dsh\patch-dsh-install-heal.mts --check` → `[dsh-heal] 全局树完好`，exit 0。

### 2. dsh-agua-patch.mts

- 症状：`ag` provider（`AG_API_KEY`）认证异常——请求头里的显式 UA 被覆盖成默认值。
- 根因：`dsh-llm-pi-ai/lib/index.js` 的 `requestHeaders()` 在 `prepare()` 之后无条件执行 `for (const [name, value] of Object.entries(attributionHeaders())) headers.set(name, value)`（纯净 rc.5 在 :1967）。
- 做法：v2 在 attribution 循环之后，把 `configured` 里显式给的 `user-agent` 重新 `set` 回去；v1 的整段文本锚点已随 0.2.2-rc.1 改版失效。
- 依赖前提：profile 仍配置了自定义 UA —— `profiles/web/cordis.patch.yml:220` 的 `user-agent: opencode/1.0`。
- 复验：`node %USERPROFILE%\.dsh\dsh-agua-patch.mts` → `[agua] 补丁已存在，跳过`，exit 0。
- 失效判据：上游把「显式 configured 头优先于 attribution」做进 `requestHeaders()`（纯净包出现该行为）→ 删钩子并把脚本移入 `retired/`。

### 3. patch-prompt-library-source-kind.mts

- 症状：AI 润色/收录后**下一轮**才报 `format v4 message requires a producer-owned source kind`，毒行与错误文本都不落盘，像「突然坏了、只能重启」。
- 根因：`dsh-prompt-library/lib/index.js` 的 `collectText()` 写 `source: { kind: "plugin", plugin: "prompt-library" }`（纯净 1.0.0 在 :4763）；合法 kind 是生产者自有名：`user` / `model` / `tool` / `runtime-context` / `plugin:<name>`。
- 做法：字面替换为 `{ kind: "plugin:prompt-library" }`（与 bili、dsh-better-sidebar 的写法一致）；先备份、原子替换、失败回滚。
- 复验：`node …patch-prompt-library-source-kind.mts --check` → `已是合规写法（kind: "plugin:prompt-library" ×1）`，exit 0。
- 逃生舱：`DSH_PROMPTLIB_SOURCE_KIND=off`。

### 4. patch-pi-ai-output-clamp.mts

- 症状：回答中途被切断，`incomplete_details: { reason: "max_output_tokens" }`；bili 侧却只用了约 13% 输入。
- 根因：pi-ai 用**本地未压缩历史**估算输出余量，本地超窗时 `room` 为负，被 `Math.max(MIN_MAX_TOKENS, room)` 兜到 1（纯净 1.5.2 `dist/api/simple-options.js:22`）；压缩代理只改线上 messages，不改 `max_output_tokens`。
- 做法：在最后兜底里加地板 `DSH_OUTPUT_CLAMP_FLOOR`（默认 16384），仍在 `Math.min(maxTokens, …)` 之内 → 小 cap（标题生成）不被抬高，大 cap 不被更早截断。锚点用花括号配平定位函数体，不依赖整行文本。
- 复验：`node …patch-pi-ai-output-clamp.mts --check` → `[pi-ai-clamp] 已含补丁标记 — 跳过`，exit 0。
- 逃生舱：`DSH_PI_OUTPUT_CLAMP=upstream`（跳过）、`DSH_PI_OUTPUT_CLAMP_FLOOR=<n>`。

### 5. patch-subprocess-terminal-pid.mts

- ① pid：node-pty 1.2.0-beta.15 构造期 `pid` 为 0，真 pid 要等 `ready_datapipe` 才发布；宿主 `Terminal` 构造时一次性取值（纯净 rc.5 `lib/index.js:967` `this.pid = terminal.pid;`）→ `rootIdentity` 为 undefined → 每次 `terminal_close` 报 `terminal cleanup failed; surviving pid: 0`，会话行残留为 exited。补丁在构造后 ≤1s 内补取并重算 `rootIdentity`。
- ② conpty dll：本机打包的 `conpty.dll` + `OpenConsole.exe` 只吐约 23 字节终端模式序列，不出提示符、不执行命令；纯净包 win32 分支无条件 `useConptyDll: true`（:1655）。补丁改为 opt-in：`DSH_CONPTY_DLL=1` 才启用。
- 复验：`node …patch-subprocess-terminal-pid.mts` → `patched=0 selfCheck=OK`，exit 0。
- 路径来源：`APPDATA`/`USERPROFILE` 派生，可用 `DSH_SUBPROCESS_LOCAL_LIB` 直接覆盖目标文件。

### 6. patch-live-compact-gate.mts

- 症状：预设 `mcp-opt`（本机 `selectedDefault`，见 `profiles/web/cordis.patch.yml:356`）不再被 compaction spine 接管，静默退回原生压缩。
- 根因：`dsh-live-compact/gate.js:6` 的 `PRESET_IDS` 只含 `standard/ptc/minimal/cordis`（纯净 1.1.12 同样如此）；`pnpm add` / `dsh plugin add` 重装 profile 包会恢复上游文件。
- 做法：向 `PRESET_IDS` 追加 `mcp-opt` / `preset-mcp-opt`；纯字符串补丁，不动逻辑。
- 复验：`node …patch-live-compact-gate.mts --check` → `SKIP  PRESET_IDS already has mcp-opt / preset-mcp-opt`，exit 0。
- 守卫：启动器只在 `profiles/web/node_modules/dsh-live-compact/gate.js` 存在时才调用它（否则脚本按设计 exit 1，不该每次启动打假警告）。

## 已移除（2 个钩子 + 4 段注释，2026-11-22）

| 钩子 | 移除理由 |
|---|---|
| `patch-session-format-compat.mts`（→ `retired/`） | 生产侧已无证据：纯净 rc.5 的 v0 成员白名单确实不含那 6 个成员，但 write 侧已不存在——profile 里 `billion-context@0.1.216` 的 `dist` 中 `compaction/` 出现 0 次、`kernelBlockId` 0 次；`~/.dsh/sessions`（191MB）里含 `kernelBlockId` / `effectiveMessageIds` 的文件 0 个。钩子只在每次启动多打一次 node 调用。 |
| `patch-v4-source-kinds.mts`（→ `retired/`） | 目标 `@dsh-external/dsh-graded-mode` **未安装**（4/4 目标缺文件），vendored 的 `billion-context-dsh` 也不在 profile 里 → 每次启动白打 4 行「未安装（缺文件），跳过」。 |

- 已删注释块：`[removed 2026-10-18]` context-compression-selector 钩子、`[removed 2026-11-13]` agent-team link 钩子、`[removed 2026-10-20]` redteam toolFilter 钩子、`[removed 2026-11-05]` bili allow-dsh-compaction 钩子。这些都是纯注释（无可执行代码），信息已在本台账留档。
- 已装文件里的 session-format 补丁**未回滚**（`npm install -g` 已把全局树换成纯净版，白名单自然回到未修形态）；只有需要读回更早的、带这些成员的会话时才会触发——按上面的 grep 证据，本机不存在这种会话。

## 再次过时的判断流程

1. 看纯净包：`npm pack <pkg>@<已装版本>` 解压后与已装文件 diff。
2. 若纯净包已含修复 → 钩子过时：删钩子、脚本移入 `retired/`、在本台账记录证据。
3. 若目标包/路径不存在 → 钩子已死：删钩子（或像 live-compact 那样加存在性守卫，仅当包可能回归时）。
4. 若锚点失配（脚本 exit 1 且打印「锚点未找到」）→ 不是过时，是**上游改结构**：按新结构重定位锚点，别直接删。