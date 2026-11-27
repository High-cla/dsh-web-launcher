# dsh-launcher-kit

DeepSeek Harness（DSH）Web 启动器 `DSH-Web-Launcher.cmd` 及其**启动期补丁钩子**的版本化仓库。

运行位置不在本仓库：双击的是桌面上的 `DSH-Web-Launcher.cmd`，钩子脚本由启动器从 `%USERPROFILE%\.dsh\` 读取。
本仓库是这些文件的**源**；用 `deploy.cmd` 同步到运行位置（覆盖前自动备份到 `%USERPROFILE%\.dsh\launcher-backups\`）。

## 目录结构

| 路径 | 作用 | deploy.cmd 部署到 |
|---|---|---|
| `launcher/DSH-Web-Launcher.cmd` | 启动器：更新检查 → 跑补丁钩子 → 启动 DSH Web | `%USERPROFILE%\Desktop\` |
| `launcher/dsh-web-boot.mts` | 引导器：`dsh --profile web --no-open`，抓取带 token 的登录 URL 再开浏览器 | `%USERPROFILE%\.dsh\` |
| `hooks/*.mts` | 7 个启动期补丁（全部幂等，`npm install -g` 覆盖后自动重打） | `%USERPROFILE%\.dsh\` |
| `tools/verify-launcher-channel.mts` | 干跑验证：沙箱副本 + 副作用替换，验证启动器三个分支 | `%USERPROFILE%\.dsh\` |
| `retired/*.mts` | 已停止调用的脚本（保留供回归复用，不部署）；运行位置的副本已移入 `%USERPROFILE%\.dsh\launcher-backups\retired\` | — |
| `PATCHES.md` | 补丁台账：每条修什么、证据、复验命令、失效判据 | — |

## 启动流程

1. 读 `DSH_CHANNEL`（当前 `next`），用 `npm view` 取版本，与标记文件 `%USERPROFILE%\.dsh-web-version`（内容 `"<通道> <版本>"`）比对；不一致才 `npm install -g @deepseek-ai/dsh@<版本>` 并回写标记。
   - npm cache 不可写时探测并退回 `%LOCALAPPDATA%\dsh-npm-cache`（探测失败只是跳过更新，不阻塞启动）。
   - 标记带通道名：换通道即使版本串相同也会重新评估（版本可能跨通道回退）。
2. 依次跑 7 个补丁钩子。**顺序有约束**：`install-heal` 必须最先——它可能触发整树重装，重装会擦掉其后钩子打的补丁。
   - 另有一项 bili 降噪设置**不在钩子里**：`if not defined BILI_CONFLICT_SCAN set "BILI_CONFLICT_SCAN=0"`（写在启动器里）。环境变量必须进 dsh 进程，而钩子是子进程、改不了父进程 env；`~/.dsh/.env` 也不被 dsh 读取（见 [PATCHES.md](PATCHES.md) 第 8 条）。
3. `start "DSH-Web" node dsh-web-boot.mts`：dsh 只认带 token 的登录 URL，裸 `http://127.0.0.1:3080` 必然 401，所以由引导器抓 URL 再开浏览器（单一 opener，避免重复标签页）。

## 补丁为什么必须每次启动重打

`npm install -g @deepseek-ai/dsh` 会替换整个全局包树（含其 `node_modules` 里的依赖包），所有补丁随之消失。因此：

- 钩子一律幂等：已打则跳过并以 exit 0 结束；锚点找不到才 exit 1 并打印原因（明确失败优于静默失效）。
- 补丁只做**最小语义改动**，不改写上游逻辑，便于随版本重定位。
- 目标包缺失的钩子必须加文件存在性守卫，否则每次启动都打一行假警告——这类噪音会把真警告淹没。

## 验证

```bash
node tools\verify-launcher-channel.mts        # 干跑，1.2s，无网络、无真实安装/启动
```

它把启动器复制到临时目录，用规则把 `npm install` / `start` / 补丁钩子 / `pause` 全部替换成 `echo`，再真跑 `cmd.exe`，断言：无标记走更新分支、标记匹配则跳过、换通道不被旧标记挡住、取版本命令带 `@%DSH_CHANNEL%`、沙箱无真实副作用。

**执行前有 fail-closed 门禁**：替换后若仍残留真实 `npm install` / `start` / 钩子 `node` 调用 / `pause`，直接 `exit 1` 拒绝执行（旧版只在跑完后报告泄漏）。

## 已知坑（都踩过）

- **干跑正则会漏匹配**：启动器里写的是 `call npm install  -g`（两个空格），写死单空格 `install -g` 会让干跑**真的执行一次全局安装**，进而把正在运行的服务端的 PTC runtime 路径打成悬空（`dsh-ptc-runtime-node/lib/process.js` MODULE_NOT_FOUND）。现在用 `install\s+-g`，并加了执行前门禁。
- **CRLF**：`.cmd` 必须 CRLF（仓库里保持 185 个 CR = 行数）。`.mts` 在仓库里统一 LF；正文编辑工具会把 `.cmd` 整篇改写成 LF，node 两种都能跑，但 cmd 解析器对 EOL 敏感，部署前必须转回。
- **转 CRLF 别逐行加 CR**：`perl -pi -e 's/\n/\r\n/'` 在已 CRLF 的行上会造出 `\r\r\n`（185 行 → 370 个 CR，`git diff` 变成整文件重写）。一次性 normalize 才对：`node -e "s.replace(/\r/g,'').replace(/\n/g,'\r\n')"`，再核对 `tr -cd '\r' | wc -c` 等于行数、`file` 报 `with CRLF line terminators`。
- **patch 备份会堆积**：脚本在目标旁边留 `*.prepatch-bak` / `*.bak-*`，`launcher-backups/` 里另有历史副本，排查时先看它们判断「补丁是否曾经打过」。

## 回滚

1. 单文件：`%USERPROFILE%\.dsh\launcher-backups\` 里找 `*.pre-<原因>-<时间戳>` 覆盖回去。
2. 启动器：`copy /Y "%USERPROFILE%\.dsh\launcher-backups\DSH-Web-Launcher.cmd.pre-repo-*.bak" "%USERPROFILE%\Desktop\DSH-Web-Launcher.cmd"`。
3. 全局树被 `npm install -g` 打断时：重跑启动器（`install-heal` 钩子会校验并 `npm install -g --force` 修复），或手工 `npm install -g @deepseek-ai/dsh@0.2.2-rc.5`。

## 环境

- Windows + Git for Windows bash（`C:\Program Files\Git\bin\bash.exe`）
- Node.js 24.x、npm 全局前缀 `%APPDATA%\npm`
- dsh profile `web`（脚本里的 profile 名固定为 `web`，换 profile 需同时改 `patch-live-compact-gate.mts` 调用与钩子守卫路径）