# pkkkkh 的 DSH 插件

[![GitHub stars](https://img.shields.io/github/stars/pkkkkh/dsh-plugins-public?style=flat-square)](https://github.com/pkkkkh/dsh-plugins-public/stargazers)
[![npm](https://img.shields.io/npm/v/@pkkkkh/dsh-restart?style=flat-square)](https://www.npmjs.com/package/@pkkkkh/dsh-restart)
[![downloads](https://img.shields.io/npm/dm/@pkkkkh/dsh-restart?style=flat-square)](https://www.npmjs.com/package/@pkkkkh/dsh-restart)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

给 **DeepSeek Harness**（DSH）用的插件合集：让跑在 IM 通道（微信 / QQ / 飞书…）或桌面端的 agent，能**自己重启**、**服务端生图**、**处理视频**、**分析 B 站视频**、**跨会话记住上下文**。

每个包都发布在 npm（`@pkkkkh/*`），一行命令就能装进 DSH。

## 插件一览

| 包 | 做什么 | 一眼看点 | 安装 |
| --- | --- | --- | --- |
| [`@pkkkkh/dsh-restart`](https://www.npmjs.com/package/@pkkkkh/dsh-restart) | 安全的自我重启 | 计划任务排 kill/start，重启后自己回来并发一句播报 | `dsh plugin add @pkkkkh/dsh-restart` |
| [`@pkkkkh/image-toolbox`](https://www.npmjs.com/package/@pkkkkh/image-toolbox) | 服务端生图 | 一个 image_generate，直连火山方舟 Seedream，无客户端 UI | `dsh plugin add @pkkkkh/image-toolbox` |
| [`@pkkkkh/dsh-session-archive`](https://www.npmjs.com/package/@pkkkkh/dsh-session-archive) | 会话归档 + 长期上下文 | 按通道前缀归档旧会话，维护一份跨会话 LONGTERM.md | `dsh plugin add @pkkkkh/dsh-session-archive` |
| [`@pkkkkh/video-toolbox`](https://www.npmjs.com/package/@pkkkkh/video-toolbox) | 视频工具箱（统一入口） | 一个 video_toolbox 覆盖 ffmpeg / 转码 / 转写 | `dsh plugin add @pkkkkh/video-toolbox` |
| [`@pkkkkh/dsh-handoff`](https://www.npmjs.com/package/@pkkkkh/dsh-handoff) | 会话交接文档 | 自动生成交接 markdown：任务、进展、未完成、坑 | `dsh plugin add @pkkkkh/dsh-handoff` |
| [`@pkkkkh/dsh-bilibili`](https://www.npmjs.com/package/@pkkkkh/dsh-bilibili) | B 站视频分析 | 文稿优先 + 定向抓帧，省 token 的 B 站总结 | `dsh plugin add @pkkkkh/dsh-bilibili` |

## 快速开始

```bash
# 装到桌面 profile（把包名换成上面任何一个）
dsh plugin --profile desktop add @pkkkkh/dsh-restart
```

兼容性：DSH `>=0.2.1-rc.2 <0.3.0`；Node `^22.19.0 || >=24`。

## 关于代码来源（重要）

这里的包不是「全部从零写的」，按来源分三类，避免把别人的代码算成自己写的。

### 一、原创（代码全部自己写）

- [`@pkkkkh/dsh-restart`](https://www.npmjs.com/package/@pkkkkh/dsh-restart) v0.2.11 — 安全的自我重启
- [`@pkkkkh/image-toolbox`](https://www.npmjs.com/package/@pkkkkh/image-toolbox) v0.1.2 — 服务端生图
- [`@pkkkkh/dsh-session-archive`](https://www.npmjs.com/package/@pkkkkh/dsh-session-archive) v0.3.0 — 会话归档 + 长期上下文

### 二、聚合层（自写门面 + vendored 上游）

- [`@pkkkkh/video-toolbox`](https://www.npmjs.com/package/@pkkkkh/video-toolbox) v0.2.2 — 自写路由门面；ffmpeg 能力 vendored 自 dsh-ffmpeg 0.7.20（MIT），约 85% 代码非自写

### 三、基于上游修改的维护版（fork，已署名）

- [`@pkkkkh/dsh-handoff`](https://www.npmjs.com/package/@pkkkkh/dsh-handoff) v0.4.2 — 基于 zhenbang1216/dsh-handoff（MIT） 修改；改了什么逐条写在包内 NOTICE.md
- [`@pkkkkh/dsh-bilibili`](https://www.npmjs.com/package/@pkkkkh/dsh-bilibili) v0.9.3 — 基于 CZX2244/dsh-bilibili（MIT） 修改；改了什么逐条写在包内 NOTICE.md

## 怎么被发现

- 仓库带 `dsh-plugin` topic，DSH 插件市场索引（dsh.works / dsh.market）每日扫描 GitHub 与 npm 自动收录；
- 每个包的 `package.json` 里有 `keywords: dsh-plugin` 与 `dsh.bundle` 字段；
- 想手动找插件，可以按 `dsh-plugin` 搜 npm 或 GitHub topic。

## 反馈

用着有问题、或者想要某个功能，开 issue 说一声。更新流程是「私有仓库改 → 重新导出 → 推这里」，所以这里永远是稳定快照。

## 许可

MIT。fork 包的上游版权声明见各包 `NOTICE.md` 与 `LICENSE`。
