# dsh-session-usage

> 给 DeepSeek Harness 的「对话用量」插件：把每个会话的输入 / 缓存读 / 缓存写 / 输出 token 与估算费用汇总成一张表，并直接标注在侧栏会话行上。

[English](#english) · [安装](#安装) · [看什么](#看什么) · [配置与数据](#配置与数据)

---

## 它解决什么

DSH 自带的用量信息是「当前会话、当前上下文」视角，回答不了这些问题：

- 这个项目我一共烧了多少 token / 多少钱？
- 哪几个会话最贵？
- 最近 1 小时、1 天、7 天分别花了多少？
- 缓存命中率高不高（cache-read 占比）？

本插件**直接解析本地会话日志**（`$DSH_HOME/sessions/<project>/<session>/session.v4.jsonl.zstd`），所以**历史会话也算得出来**，而不是从装上插件那一刻开始计数。

## 功能

- 📊 **对话用量表**：每个会话一行，输入 / 缓存读 / 缓存写 / 输出 token，以及估算费用（人民币）
- 🪙 **两种视图**：`Token 用量` 与 `费用`，一键切换，选择会被记住
- ⏱ **时间窗口**：最近 10 分钟 / 30 分钟 / 1 小时 / 3 小时 / 1 天 / 7 天 / 30 天 / 全部
- 📌 **侧栏标注**：在侧栏的会话行上直接画出 token 或费用，随窗口与视图模式联动
- 🧮 **峰谷价 + 节假日计价**：按官方峰谷规则（工作日 09:00–12:00、14:00–18:00 为高峰，其余半价）折算，法定节假日与调休基于内置日历
- ⚡ **增量缓存**：解析结果写入 `~/.dsh/dsh-session-usage/cache.json`，只有日志增长的文件才重新解析
- 🌐 纯本地：只读本地会话日志，不联网

## 环境要求

- DeepSeek Harness **>= 0.2.1-rc.2**（Web GUI / 桌面客户端）
- Node.js `^22.19.0 || >=24.0.0`（用到内置 `zlib` 的 zstd 能力）
- 需要能读到 `$DSH_HOME`（默认 `~/.dsh`）

## 安装

```bash
cd "/d/Program Files/DeepSeek Harness/resources/runtime/cli/bin"
./dsh.cmd plugin --profile desktop add "git+https://github.com/Aily-DSH/dsh-session-usage.git"
```

或本地开发：

```bash
dsh plugin --profile desktop add "file:/D:/path/to/dsh-session-usage"
```

**装完重启一次 DeepSeek Harness 客户端**，然后打开 **设置 → 对话用量**。

## 看什么

1. 顶部是汇总卡片：当前窗口内的总 token、缓存命中比例、估算费用
2. 中间是窗口切换（10 分钟 … 全部）与视图切换（Token 用量 / 费用）
3. 表格每个会话一行：标题、所属工作区、四类 token、费用
4. 侧栏里的会话行会带上对应的数字，方便一边干活一边看

## 配置与数据

插件没有必填配置。相关路径：

| 路径 | 说明 |
| --- | --- |
| `$DSH_HOME/sessions/<project>/<session>/session.v4.jsonl.zstd` | 数据来源（DSH 自己写的会话日志） |
| `~/.dsh/dsh-session-usage/cache.json` | 解析缓存（可随时删除，删除后重建） |
| `GET /api/dsh-session-usage/list` | 宿主路由，返回汇总后的列表（仅回环） |

计价口径：

- 模型按 `deepseek-flash` 价目折算（人民币 / 百万 token），并把 `deepseek-v4-pro` 收敛到同一行
- 高峰窗口：北京时间工作日 09:00–12:00、14:00–18:00；其余时段（含周末与法定节假日）按低谷价半价
- 节假日表来自 `lib/holidays.js`（由 `tools/gen-holidays.mjs` 生成），到期后可重新生成

## 工作原理

DSH 的会话日志是「**追加写的独立 zstd 帧序列**」，每个帧里是一段 JSONL 事件。Node 的 `zstdDecompressSync` 遇到第一个帧就停，所以宿主半按 zstd 魔数（`28 B5 2F FD`）切分文件、逐帧解压。

为控制开销：

- 先用廉价子串预过滤，跳过体积巨大的 `tool/result`、`request/header` 行，再 `JSON.parse`
- 只解析携带计费字段的事件（`usage` 里的 `inputTokens / outputTokens / cacheReadTokens / cacheWriteTokens / totalTokens`）
- 每个会话文件按 `mtime + size` 命中缓存，避免重复解压

## 已知限制

- 费用是**估算**：四舍五入与官方账单可能有几个百分点的差异，以控制台账单为准
- 只统计本地日志里存在的事件；用其它客户端/机器跑过的会话不在本地就不会出现
- 首次打开大历史（几百个会话）时会有一段时间的解析开销（之后走缓存）
- 缓存文件版本号（`CACHE_VERSION`）升级后会自动重建

## 卸载

```bash
dsh plugin --profile desktop remove dsh-session-usage
```

删除 `~/.dsh/dsh-session-usage/`（可选）。

## 目录结构

```
lib/index.js       宿主半：日志发现、逐帧解压、事件聚合、缓存、/list 路由
lib/client.js      客户端半：设置页表格 + 侧栏标注
lib/pricing.js     峰谷价与人民币换算
lib/holidays.js    中国法定节假日/调休表（生成物）
tools/gen-holidays.mjs  重新生成节假日表
cordis.patch.yml   插入插件行
```

## 赞赏

如果这个插件帮你省了钱，欢迎扫码请作者喝一杯 ☕（纯属自愿，不影响使用和更新）

<p align="center">
  <img src="assets/reward-qr.png" alt="赞赏码" width="260">
</p>

## English

**dsh-session-usage** shows per-conversation token usage and cost for DeepSeek Harness. It parses the local session logs directly (`$DSH_HOME/sessions/.../session.v4.jsonl.zstd`, an append-only sequence of zstd frames, decompressed frame by frame), so past conversations are included rather than starting from installation. A settings section renders a sortable table with input / cache-read / cache-write / output tokens and an estimated CNY cost that follows the official peak/off-peak rule (weekday 09:00–12:00 and 14:00–18:00 Asia/Shanghai are peak, everything else half price; Chinese holidays accounted for). The same number is painted onto sidebar session rows. Parsed data is cached in `~/.dsh/dsh-session-usage/cache.json`.

```bash
dsh plugin --profile desktop add "git+https://github.com/Aily-DSH/dsh-session-usage.git"
# restart the client once
```

**Sponsor:** if this plugin saved you money, you can buy the author a coffee — scan `assets/reward-qr.png`.

## License

[MIT](./LICENSE)
