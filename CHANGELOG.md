# Changelog

All notable changes to `dsh-session-usage` are recorded here.

## 0.1.1

- 修复侧栏开关顺序：统计时长（如 `3h`/`1d`）与口径（`T`/`¥`）两个按钮现在固定插在「工作区」标题右侧，不会再跑到标题前面，也不会再靠压缩搜索框的左边距来腾位置。
- 卸掉 `searchSlot` 的 margin 改写逻辑，插件停用后不再残留样式。

## 0.1.0

- 首个版本：对话用量表（输入 / 缓存读 / 缓存写 / 输出 token + 估算费用）、
  时间窗口切换、Token 与费用两种视图、侧栏会话行标注、峰谷价与节假日计价、增量缓存。
