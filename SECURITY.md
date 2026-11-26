# Security notes

静态扫描（dsh.so / dsh-plugin-vet）对本仓库的结论是 **0 Critical**。
以下 5 条 Warning 是功能必需，逐条说明用途与边界。

## 子进程（2 条，`dsh-restart`）

| 位置 | 用途 | 参数来源 |
|---|---|---|
| `dsh-restart/lib/index.js:157` | 执行外部命令（排程 / 拉起 DSH） | 本地配置与常量 |
| `dsh-restart/lib/index.js:401` | 拉起 watchdog 脚本 | 本地脚本路径 |

另有 `dsh-restart/scripts/dsh-watchdog.cjs` 调用 `powershell.exe` 注册/触发计划任务，
以及 `dsh-bilibili`、`video-toolbox`、`image-toolbox` 调用 `ffmpeg` / `ffprobe` / `whisper-cli` / `sherpa-onnx`。

**共同边界**：

- 只调用**本机已安装**的可执行文件，不下载、不解包、不执行任何来自网络的脚本；
- 命令与参数由本地配置或用户提供的时间点生成，不经网络下发；
- 不写系统目录、不改其他应用的文件、不做删除类操作。

## 文件写入（3 条，`dsh-session-archive`）

| 位置 | 用途 | 目标 |
|---|---|---|
| `lib/index.js:119` | 合并归档 id 到 `workspace.json` | DSH 自己的配置文件 |
| `lib/index.js:397` | 保存插件状态 JSON | 插件自己的状态目录 |
| `lib/index.js:404` | 写 `LONGTERM.md` 等文本 | 插件自己的状态目录 |

三处都是**原子写**：先写 `<file>.tmp`，再 `rename` 覆盖目标，避免中断导致文件损坏。
只覆盖自己的目标文件，不删除任何东西。

## 网络行为

- `dsh-bilibili`：访问 B 站公开接口与用户自己提供的登录凭证，用于取视频元数据/字幕/评论/弹幕。
- `image-toolbox`：调用用户自己配置的生图服务端点。
- 其余插件默认不联网。

## 权限插件（`dsh-session-permissions`）

**默认空转**：`channels` 与 `workspaces` 两端默认都为空，装上**不会**给任何会话放权。
要放权必须使用者自己在一层配置里写明通道名或工作区目录。本仓库不附带任何“开箱即完全访问”的默认值。

## 凭据

- 不内置任何密钥、令牌、SESSDATA；
- 登录凭证由使用者在本地生成并保存在本地，不会写入本仓库或上报。

## 报告问题

发现安全问题请开 issue（不要公开贴凭据），或直接联系仓库维护者。
