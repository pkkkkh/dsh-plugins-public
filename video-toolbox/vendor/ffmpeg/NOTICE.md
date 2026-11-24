# 第三方代码（vendored）

- 来源：`dsh-ffmpeg` **0.7.20**（MIT），作者见其 npm 包
- 取出文件：`lib/{args,config,exec,ffprobe,paths,tools,storyboard}.js` 原样拷贝，未做修改
- **本仓库改过 1 处（2026-11-23）**：`tools.js` 的 gif 工具原本把 `.gif` 同时当 suffix 和 ext 传给 `resolveOutputPath`，默认输出会变成 `xxx.gif.gif`；已把 suffix 改成空串。上游 0.7.20 仍有此问题（只在「不给 output」时出现）。
- 用途：`video-toolbox` 是本仓库的 link 插件，装在仓库里，**无法按包名 import 到 profile 的 node_modules**（Node 从真实路径解析，会 ERR_MODULE_NOT_FOUND）
- 因此把需要的几个源文件复制到这里，改为相对路径引用
- 升级 dsh-ffmpeg 时：同步覆盖本目录这 7 个文件，并更新上面版本号
- `LICENSE` 为上游 MIT 原文，随本目录保留
