# pkkkkh 的 DSH 插件

> 对外发布用的**稳定快照**：从私有开发仓库导出，已去掉本机路径；已发布到 npm（`@pkkkkh/*`）。
> 下面按「原创 / 聚合层 / 基于上游修改」分开写，避免把别人的代码算成自己写的。

## 一、原创（代码全部自己写）

- [`@pkkkkh/dsh-restart`](https://www.npmjs.com/package/@pkkkkh/dsh-restart) v0.2.6 — 安全自重启 + 常驻看门狗 + 按渠道播报
- [`@pkkkkh/image-toolbox`](https://www.npmjs.com/package/@pkkkkh/image-toolbox) v0.1.0 — 服务端生图（火山方舟 Seedream），一个 `image_generate` 工具
- [`@pkkkkh/im-session-archive`](https://www.npmjs.com/package/@pkkkkh/im-session-archive) v0.2.3 — IM 会话归档 + 跨会话长期上下文（LONGTERM）

## 二、聚合层（自写门面 + vendored 上游）

- [`@pkkkkh/video-toolbox`](https://www.npmjs.com/package/@pkkkkh/video-toolbox) v0.2.2 — 一个 `video_toolbox` 门面；ffmpeg 那 11 个工具是 vendored 的 dsh-ffmpeg 0.7.20（MIT），代码量 85% 非自写

## 三、基于上游修改的维护版（fork，已署名）

- [`@pkkkkh/dsh-handoff`](https://www.npmjs.com/package/@pkkkkh/dsh-handoff) v0.4.0 — 基于 zhenbang1216/dsh-handoff（MIT） 修改；改了什么见包内 `NOTICE.md`

## 安装

    dsh plugin --profile desktop add @pkkkkh/dsh-restart
    dsh plugin --profile desktop add @pkkkkh/image-toolbox
    dsh plugin --profile desktop add @pkkkkh/im-session-archive
    dsh plugin --profile desktop add @pkkkkh/video-toolbox
    dsh plugin --profile desktop add @pkkkkh/dsh-handoff

## 未收录（上游在自己的仓库维护）

- dsh-bilibili — CZX2244（本机维护版有大量改动，未公开）
- dsh-bili-subagent — Yuuyuko-uu（本机维护版未公开）
- dsh-deepseek-tools — 来源不明，不公开

## 许可

MIT。fork 包的上游版权声明见各包 `NOTICE.md` 与 `LICENSE`。
