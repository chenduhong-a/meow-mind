# meow-mind

跨会话记忆插件（DSH cordis 插件，host 半 + 侧边栏标签），从 meow-memory 0.33.1 重写而来。目标：**降词元、治积累、提召回**。

它做的事可以在三句话里说完：

1. **存**——把跨会话要记住的东西分九层存进 SQLite，正文只留结论与判据，证据另存。
2. **找**——新会话开场自动交代全局准则、用户偏好与当前项目；之后每轮按你的话检索，够相关才贴。
3. **理**——`/dream` 与 `memory_dream` 做合并、去重、瘦身、拆分；侧边栏可以人工逐条过一遍。

跑起来之后你不需要做什么，注入是自动的；只有**要写**的时候才需要调工具或说一句「记一下」。

## 一、安装

```powershell
dsh plugin --profile <profile> add file:<本目录绝对路径> --config.strict-dep-builds=false
```

两个参数都不能省：

- `--config.strict-dep-builds=false`：依赖里的 `onnxruntime-node` 与 `protobufjs` 带 build script，pnpm 11 默认因此**以退出码 1 结束**（包其实已装好）。这两个包不需要跑 build script——`onnxruntime-node` 自带全平台预编译 `.node` 与 `.dll`。
- 装完要**重启宿主**（插件是 host 半，热重载不生效）。

**不能与 meow-memory 共存**：两者注册同名 `memory_search` / `memory_update`，同一 profile 下互相顶掉，且两套注入叠加正是要解决的「太耗词元」。验收期只能装一个。

## 二、5 分钟上手

### 2.1 它在你没做任何事时，已经做了什么

新会话第一条消息前，插件拼一个**首轮块**塞进上下文（预算 3,200 tokens，实测约 1,900）：

```
## 记忆使用说明
思考过程（reasoning）与回复一律用中文书写…   ← 常驻语言提醒，每次都在第一行
## 全局准则（rules）（全局）      ← 全局库里 project='全局' 的准则
## 用户画像                     ← 按节截断，默认 2 节 / 1,050 字（全局库）
## 全局准则（rules）（本工作区）  ← 工作区库的准则（与上面那段靠标签区分）
## 项目
## 待办（todo）                 ← 最多 3 条
## 共享库样板 2 份：…            ← 只有一行索引，正文按需 get
## 信箱（N 封待办）              ← 有信才出现；只列别人写来的，手工信标 [手工信]
```

块里的 URL 只保留主机名（`https://github.com/x/y` → `github.com`）：整段删掉会让句子缺宾语，首轮块曾出现过「在 在 C:\…」这种残句。

之后每轮用户消息 ≥ 8 个字才检索（`injection.minQueryChars`），命中就贴一小块（预算 800 tokens），同一会话内不重复贴同一条。

### 2.2 第一次该做的三件事

```js
// ① 看看库里有什么
memory_health {}                       // 两库条数、向量数、首轮 token
memory_home {}                         // 两个库文件的确切路径

// ② 写第一条准则（跨工作区都成立的）
memory_remember {
  level: 'rules', project: '全局',
  content: '汇报版本变动时必须附更新说明，不能只说「已升级」',
  keywords: ['版本', '更新说明', '汇报口径']
}

// ③ 写一条本工作区的事实
memory_remember {
  level: 'fact', project: 'dsh',
  content: '本机 profile 目录是 C:\\Users\\<你>\\.dsh\\profiles\\desktop',
  keywords: ['profile', '路径', 'desktop']
}
```

不用刻意「喂」它——`governance.autoCapture` 默认开，会把你的话原样记成 `observation`（原始观察，不进检索），需要时再提炼。

## 三、日常用法

### 3.1 存记忆：九层怎么选

| 层 | 放什么 | 例子 |
|---|---|---|
| `soul` | 全局人格底色，跨工作区；本会话人格走 `personas` | 「我是谁、在哪里、主要做什么」 |
| `user` | 用户偏好（现已转画像，此层留档） | 原始偏好原话，归档为 `review` |
| `project` | 项目当前状态 | 「这个仓库用 pnpm，Node 22」 |
| `fact` | 稳定事实、路径、数字 | 「Zotero 端点是 127.0.0.1:23119」 |
| `lesson` | 踩过的坑与判据 | 「pwsh 改 JS 会吃掉反引号，改用 node 脚本」 |
| `topic` | 主题化知识块 | 「中文记忆框架的评测结论」 |
| `rules` | 行为准则 | 「多选项一律弹选项卡」 |
| `todo` | 待办，办完即删 | 「周三前把 SPEC §14 补完」 |

选择困难时问一句：**这条以后要不要按它做决定？** 要 → `rules`；是事实 → `fact`；是坑 → `lesson`；还没做完 → `todo`。

### 3.2 两库：什么放全局

| | 工作区库 | 全局库（`globalDir`） |
|---|---|---|
| 路径 | `<cwd>\.dsh-mind\memory.db` | `C:\deepseek\.dsh-mind-global\memory.db` |
| 存放 | 只对当前工作区成立 | 换个工作区也成立 |

判据一句话：**换个工作区打开，这条还对吗？** 对 → `project: '全局'`。写的时候 `memory_remember` 按 project 自动选库；读的时候 `memory_read` / `memory_update` / `memory_forget` 按 id 先全局后工作区找；检索与注入都是两库合并（命中行标 `[全局]`）。要改某条的归属用 `memory_update { project: '全局' }`（`全球` / `global` 会被归一成 `全局`）——它只改字段，不跨库搬迁。

禁止两边各存一份，也禁止为了能查到就把项目信息标成「全局」——路由判据被污染后，全局库会变成第二个垃圾桶。

### 3.3 取回

```js
memory_search { query: '上次那个 render 契约的坑' }         // 两库合并排序
memory_read   { id: '01M7YTG8047AAFV3PYVWFTG039', include_evidence: true }
memory_context { maxTokens: 1200 }                        // 要一份可注入的上下文块
memory_project { project: 'dsh' }                         // 某个项目的七层全景
```

工具会回 `created` / `updated` / `at` 三个可读时间戳，不用自己算毫秒。

### 3.4 待办（`todo`）

```js
memory_remember { level: 'todo', content: '把 README 重排成使用手册，含故障排查一节' }
memory_forget   { id: '…' }        // 办完直接删，不归档、不进证据表
```

首轮块最多注入 3 条，侧边栏有独立「待办」组。只写「做什么 + 什么算完」，背景归 `project` / `fact`。

### 3.5 版本流水（`change_log`）

「某天把某东西升到哪版」**不进记忆层**，进插件内置表：

```js
memory_log { action: 'add', subject: 'meow-mind', from: '0.1.0', to: '0.1.1', note: '新增 memory_doc' }
memory_log { action: 'list', subject: 'meow-mind' }
```

记忆里只留**当前基线**（升级后 deps/bundles 掉队须为 0）与**选型判据**（为何钉某版）。

### 3.6 跨会话信箱（`memory_mail`）

```js
memory_mail { action: 'post', to: '全体', subject: '插件升级通知', body: '…' }
memory_mail { action: 'list' }
memory_mail { action: 'read', id: 'L…' }
memory_mail { action: 'archive', id: 'L…' }     // 移进 mailbox\archive\<月份>.md
```

信件是文件：`<globalDir>\mailbox\inbox.md`（归档进 `archive\`）。发件人自动取当前会话码。`/mail` 是同功能斜杠入口。

手工投递的信（对方直接写文件，编号栏不是真 id）也能归档：给 `time` 与 `subject` 定位即可，例如 `memory_mail { action: 'archive', time: '18:51', subject: '画像层' }`；匹配到多封会拒绝并报条数，不会猜。

### 3.7 长文样板（`memory_doc`）

判据：**要整套读完才有用 → 样板；只取一句就够 → 记忆**。

```js
memory_doc { action: 'list' }
memory_doc { action: 'get', name: 'guidelines' }
memory_doc { action: 'put', name: 'my-manual', title: '…', body: '…' }
```

首轮块只列一行索引（名字、标题、字数），正文按需取——这样长文不占日常预算。

### 3.8 用户画像（`memory_profile`）

画像回答的是「这个人是谁」，跨工作区都成立，所以**存在全局库**（没有全局库时才退回工作区库）——study、work 读的是同一份，改一处就够。

分节维度：身份 / 工作方式 / 交付偏好 / 取舍标准 / 沟通风格 / 查证偏好 / 长期目标。`get` 看全部；`upsert { topic, sub_topic, content, merge }` 改一条（`merge` 取 `append` / `replace` / `abort`）；`delete` 删一节；`refresh` 重算叙事；`pending` 列出还没归纳的 `user` 记忆。

画像只放**跨场景稳定特质**，场景规则归技能与准则层——判据是「这条内容换个场景还成立吗」。

**归纳不会自动发生**：插件内部调不到模型，`/dream run` 只做关系网、合并、瘦身、拆分与去重，不写画像。`/dream` 会报「未归纳 N 条」，要归纳时在会话里让我按 `pending` 清单逐节 `upsert`。

### 3.9 侧边栏审议

右侧「记忆审议」标签（`client.js` + `/meow-mind/api`）：库下拉、按层筛选、时间窗（全部 / 近 7 天 / 近 30 天）、每条显示写入时间、可标「有用 / 无用」并写一句评语。只列活跃条目（`status IN ('memory','evolution')`），已归档的不会来占你时间。

### 3.10 斜杠指令

| 指令 | 作用 |
|---|---|
| `/dream` | 只读体检：条数、重复对、超长条目、画像待归纳（只报不归纳） |
| `/dream run` | 真整理：关系网 → 合并 → 瘦身 → 拆分（不可逆，先备份） |
| `/log [关键词]` | 版本流水查询 |
| `/mail [关键词]` | 信箱：无参列待办、`all` 列全部 |

## 四、配置

宿主设置页有表单（依赖 `@deepseek-ai/schemastery`；缺失时降级为无表单，插件仍能跑）。默认值：

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 插件总开关 |
| `projectDir` | `.dsh-mind` | 工作区内库目录（相对 cwd） |
| `homeDir` | `''` | 旧全局目录覆盖（空 = 平台默认 `~/.dsh-mind`） |
| `globalDir` | `C:/deepseek/.dsh-mind-global` | **全局库目录；设成空串 = 关闭全局库** |
| `embedding.enabled` | `true` | 关掉则纯 BM25 |
| `embedding.model` / `dtype` | `Xenova/bge-base-zh-v1.5` / `q8` | 语义通道模型 |
| `injection.firstTurnBudget` | `3200` | 首轮块 token 预算 |
| `injection.perMessageBudget` | `800` | 每消息命中块预算 |
| `injection.minQueryChars` | `8` | 短于此不检索（寒暄） |
| `injection.hitChars` | `80` | 命中块单条 L1 字数 |
| `injection.profileChars` / `profileTake` | `1050` / `2` | 画像注入上限 |
| `injection.topK` | `6` | 命中块最多几条 |
| `retrieval.hybridPool` / `semanticPool` | `50` / `20` | 词法与语义召回池 |
| `retrieval.semanticMix` | `0.5` | 双通道都命中时语义占比 |
| `retrieval.weights` | `0.65/0.15/0.10/0.10` | 词法 / 新近 / 状态 / 证据 |
| `retrieval.intentQuota` | `true` | 按意图给层分名额 |
| `governance.dupThreshold` / `similarThreshold` | `0.92` / `0.8` | 查重与相似阈值 |
| `governance.autoCapture` | `true` | 自动把用户消息记为 `observation` |

## 五、故障排查

| 症状 | 原因与处理 |
|---|---|
| 改完代码没变化 | **插件是 host 半，必须重启宿主**；改 `client.js` 要重开侧边栏 |
| 工具报 `content.some is not a function` | 工具的 `output.render` 必须返回内容块数组 `[{ type:'text', text }]` 且签名是 `(args, value)`；加工具直接复用 `tools.mjs` 顶部的 `OUTPUT` 常量（见 SPEC §13.22） |
| `memory_doc` 报「全局库未启用」 | `globalDir` 为空串，或全局库目录不可写 |
| 检索不到刚写的条目 | 新写入要等 FTS/向量落库（同步写入，一般即时）；若手工改过库，跑一次 `INSERT INTO memory_fts(memory_fts) VALUES('rebuild')` 后**再按 `buildBody` 重插**（contentless 风格的表 rebuild 不清旧行） |
| 首轮块比预期小很多 | 预算 3,200 会先给使用说明与画像，剩余的按层取；画像是 `profileChars` 截断的，不是全文 |
| 装了不生效、工具不见了 | 与 `meow-memory` 同装会互相顶掉，卸一个 |
| 安装时 `ERR_PNPM_IGNORED_BUILDS` | 加 `--config.strict-dep-builds=false` |
| 磁盘多出 400 MB | 语义通道需要 `onnxruntime-node` 287.7 MB + 模型 98.5 MB；不需要就 `embedding.enabled: false` 或删 `models/` |

## 六、设计笔记

### 6.1 数据

SQLite 单库（`node:sqlite`），九层表 `soul / user / project / fact / lesson / principle / topic / rules / todo` + 时间线五表（`episodes` / `phases` / `decisions` / `personas` / `persona_traits`）+ 事件溯源 / 证据链 / 关系 / 版本 / 反馈 / 向量 / 日志 / 样板 / 信箱 等附属表。加层只需往 `LEVELS` 加一项，`CREATE TABLE IF NOT EXISTS` 自动补表。

### 6.2 检索

- **双通道召回**：BM25 词法池（50）∪ 语义池（20）；两通道都命中按 `semanticMix` 混合，**只被语义召回的打五折**（不打折会挤掉词法已排对的条目）。
- **四因子打分**：`0.65 词法 + 0.15 新近 + 0.10 状态 + 0.10 证据`。
- **关系扩展**：top-5 作种子带出 `same_topic` 邻居，分数 × 0.35，只补位不抢位。
- **意图分桶**：判成 preference / howto / where / when，按 `INTENT_QUOTAS` 分配槽位，避免某层刷屏。**这项不改变 hit@k，改的是 top-k 的层构成**。
- **两库合并**：各自归一化后合池再排序，不能直接混池比（条目多的库会系统性压制条目少的库）。

### 6.3 注入

首轮块 `buildFirstTurnBlock(db, cfg, globalDb)`，段落顺序：使用说明 → 全局准则（全局）→ 用户画像 → 全局准则 → 项目 → 待办 → 样板索引 → 信箱。每消息命中块预算 800，带会话内去重与短查询短路。

### 6.4 体积（实测，2026-11-20）

| 项 | 体积 |
|---|---|
| `onnxruntime-node`（全平台二进制） | 287.7 MB |
| `@huggingface/transformers` | 10.3 MB |
| `sharp` | 0.9 MB |
| 模型 q8（`models/`） | 98.5 MB |
| 插件本体（`src/` 170.8 KB + `SPEC.md` 73.4 KB + `client.js` 15.8 KB） | 260 KB |

### 6.5 测试

七个脚本，全部离线可跑、数据自带：

| 脚本 | 验什么 |
|---|---|
| `test/smoke.mjs` | 注入格式、去重、短查询短路、token 估算 |
| `test/whitebox.mjs` | 22 个工具契约、guide 注册、pre-step 注入位置、子代理不注入（需 1 KB 测试桩，见 SPEC §14） |
| `test/discipline.mjs` | 三条纪律：工具数、契约字段齐全、注入只走 pre-step |
| `test/command.mjs` | 三条斜杠指令注册、dry 只读、run 执行、无 cwd 容错 |
| `test/real-volume.mjs` | 435 条真实记忆的首轮预算与命中块 |
| `test/embed-eval.mjs` | 24 条评测集上词法 vs 混合的 hit@1 / hit@5 / MRR |
| `test/summary-eval.mjs` | L0/L1 摘要长度与截断质量 |

`fixtures-*.json` 是从活库导出的快照（`fixtures-memories.json` 931 条，脚本只取 `status === 'memory'` 的 435 条；`fixtures-queries.json` 24 条，A 词面 / B 语义改写 / C 跨层各 8 条，带手工 `expect`）。

### 6.6 变更记录

完整变更记在 `SPEC.md`（§13.x 逐条对应日期与坑），记忆正文口径与去重历史也在那里的 §13.14 系列。插件自身的版本流水用 `memory_log` 或 `/log` 查。

## 附录

- **代码**：`src/` 19 个模块 + `client.js`（侧边栏）+ `test/`（7 个脚本 + fixtures）
- **数据**：工作区 `<cwd>\.dsh-mind\memory.db`；全局 `C:\deepseek\.dsh-mind-global\memory.db`；信箱 `<globalDir>\mailbox\`
- **许可**：Apache-2.0
