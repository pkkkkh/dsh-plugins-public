# NOTICE — 来源与署名

本包是基于上游 **zhenbang1216/dsh-handoff（MIT）** 修改的自用维护版，不是从零编写。

## 上游

- 项目：zhenbang1216/dsh-handoff
- 许可：MIT（原文见同目录 LICENSE）

## 本仓库相对上游的改动

- 自动生成交接文档：compaction / 会话开始与每 N 回合补一份（带节流与日志）
- 空文档自动重试一次
- max-tokens 截断不再当成成功：改为续写，并在必要时标注
- 静默失败可见化 + 缓存原子化 + 容错加固（与 dsh-bilibili 同一批修复）

## 许可

沿用上游 MIT 许可；再分发时请保留上游版权声明与 LICENSE。
