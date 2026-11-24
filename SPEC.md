# meow-mind 规格（阶段 1 交付物）

> 2026-11-20 ｜ 依据 `C:\deepseek\work\_planner\meow-mind-重写规划.md` v2（PL-AC2CC08F-E8C9）
> 本文是「逐条可验证」的需求规格；实现约束见 §10。

## 0. 一页话

DSH 跨会话记忆插件。单文件 SQLite，无外部服务。写入走事件溯源 + 六级状态机，读取走「注入保底 + 工具深查」，检索走 BM25 与真 embedding 混合，排序四因子可解释。替换 meow-memory 0.33.1，数据无损迁移。

## 1. 目标与非目标

**目标**

1. 首轮注入从实测 7.8K tokens 降到 ≤3.2K（user 块精简 + 索引化）。
2. 每消息注入从「关键词命中若干条全文」降到 ≤800 tokens（L0 摘要优先，按需展开）。
3. 召回：在 24 条离线评测集上，hit@5 ≥ 85%、MRR ≥ 0.72（BM25 基线 70.8% / 0.549；纯语义 79.2% / 0.704）。
4. 写入端可治理：重复/冲突/过时条目能被自动识别并进入 Review，不靠人工巡检。
5. 数据资产不丢：现有 431 条（7 个工作区库）全部可迁移，任一条可追溯到迁移前后 id 映射。

**非目标**

- 不做云同步、多租户、web 面板、向量数据库。
- 不做 Rust/Python 双栈；一个 npm 包、一份 Node 代码。
- 不内建模型调用；embedding 只用本地 ONNX。
- 不改变「记忆库按工作区隔离」这个既有语义。

## 2. 数据模型

### 2.1 库位置（延续双位置）

| 位置 | 路径 | 用途 |
|---|---|---|
| 工作区库 | `<cwd>/.dsh-mind/memory.db` | 该工作区的全部记忆 |
| 全局目录 | `$DSH_HOME/.dsh-mind/` 或 `memory_home` 指针 | 跨工作区共享（user/rules/soul 层） |
| 指针 | `$DSH_HOME/storages/meow-mind-home.json` | `memory_home` 迁移记录 |

> 目录名由 `.dsh-meow` 改为 `.dsh-mind`；迁移脚本负责搬迁 + 指针更新（§9）。

### 2.2 表

**七层记忆表**（沿用，字段基本不变，`status` 语义改变见 §3）

```sql
soul / user / project / fact / lesson / topic / rules
  id TEXT PRIMARY KEY,          -- 26 位 ULID 风格
  title TEXT,
  content TEXT NOT NULL,
  importance INTEGER DEFAULT 1,
  keywords TEXT,                -- JSON 数组
  status TEXT NOT NULL DEFAULT 'memory',
  source_session TEXT,
  hit_count INTEGER DEFAULT 0,
  created_at TEXT, updated_at TEXT,
  last_accessed_at TEXT,
  -- 各层专有列保持：project.subcategory / topic.goal / lesson.corrected
```

**新增表**

```sql
-- 事件溯源：一切观察与操作先落这里
events(
  id TEXT PRIMARY KEY,
  session_id TEXT, turn_id TEXT,
  kind TEXT NOT NULL,          -- observe | extract | propose | promote | update | forget | review | evolution
  level TEXT,                  -- 目标层（可空）
  payload TEXT NOT NULL,       -- JSON
  idempotency_key TEXT,        -- 唯一索引，防重复采集
  created_at TEXT NOT NULL
)
CREATE UNIQUE INDEX idx_events_idem ON events(idempotency_key) WHERE idempotency_key IS NOT NULL;

-- 证据：一条记忆为什么成立
memory_evidence(
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  event_id TEXT,
  stance TEXT NOT NULL,        -- supported | contradicted | superseded
  source_kind TEXT NOT NULL,   -- user_statement | dialog | video_observation | agent_inference | system | feedback
  quote TEXT,                  -- 支持原文片段（可空）
  created_at TEXT NOT NULL
)

-- 关系：归并与冲突
memory_relations(
  from_id TEXT NOT NULL, to_id TEXT NOT NULL,
  relation TEXT NOT NULL,      -- duplicates | refines | contradicts | supersedes | depends
  created_at TEXT NOT NULL,
  PRIMARY KEY(from_id, to_id, relation)
)

-- 版本
memory_versions(
  id TEXT PRIMARY KEY, memory_id TEXT NOT NULL,
  version INTEGER NOT NULL, content TEXT, status TEXT,
  diff TEXT,                   -- JSON：改了什么
  created_at TEXT NOT NULL
)
CREATE UNIQUE INDEX idx_versions ON memory_versions(memory_id, version);

-- 反馈
memory_feedback(
  id TEXT PRIMARY KEY, memory_id TEXT NOT NULL,
  signal TEXT NOT NULL,        -- user_explicit | outcome | self_eval
  value REAL NOT NULL,
  note TEXT, created_at TEXT NOT NULL
)

-- 提取/整理审计
extract_runs(
  id TEXT PRIMARY KEY, session_id TEXT,
  adds INTEGER, updates INTEGER, deletes INTEGER, skipped INTEGER,
  detail TEXT,                 -- JSON：每条原因
  created_at TEXT NOT NULL
)
```

**FTS**

```sql
memory_fts(memory_id UNINDEXED, level UNINDEXED, body)  -- body = title + content + keywords×2
-- 分词：中文 bigram（自定义 tokenizer 在 Node 侧做，写入时预切词存 body）
```

### 2.3 向量

- 存法：`memory_vectors(memory_id TEXT PRIMARY KEY, dim INTEGER, vec BLOB, model TEXT, updated_at TEXT)`，vec 为 Float32 小端拼接。
- 不建 ANN 索引：条目量级 ≤5 万时，768 维暴力点积在 Node 里约 10–20ms（实测 24 条查询嵌入 113ms，单条 4.7ms，检索算力不是瓶颈）。

## 3. 六级状态机

### 3.1 六态

| 态 | 含义 | 注入 | 可变 |
|---|---|---|---|
| **Observation** | 原始观察（用户原话、工具结果摘要、外部内容），未加工 | 否 | 是 |
| **Evidence** | 带来源与主体的证据，支持或反驳某个主张 | 否 | 是 |
| **Candidate** | 候选记忆：有来源、待验证 | 否（除非显式查） | 是 |
| **Memory** | 长期记忆：唯一注入源 | **是** | 是 |
| **Review** | 回顾态：到期复查、冲突待裁决、完结归档 | 否 | 是 |
| **Evolution** | 演化态：规则/经验更新，带版本与回滚点 | 视层而定 | 是 |

**硬规则**（违反即 bug）

1. **禁止静默晋升**：任何写入不得直接产出 `Memory`，必须经过 `Candidate`（用户显式 `memory_remember` 且带明确来源者除外，见 3.2）。
2. **agent_inference 不得晋升为事实**：`source_kind=agent_inference` 的证据只能支撑 `lesson` / `topic`，不能支撑 `fact` / `user`。
3. **事实记忆唯一晋升路径**：`Candidate → Memory` 需满足其一：①≥1 条 `stance=supported` 且 `source_kind ∈ {user_statement, video_observation, system}` 的证据；②用户显式确认（`memory_feedback.signal=user_explicit`）。
4. **过期只标不删**：到期/失活标 `uncertain`（存 `status='review'` + `rev` 元数据），内容保留。
5. **冲突不自动裁决**：检测到 `contradicts` 关系时两条都进 Review，返回给用户/模型裁决。

### 3.2 允许的显式短路径

用户当面说「记住 X」时，`memory_remember` 直接写 `Memory`，但必须同时落一条 `events(kind=observe, source_kind=user_statement)` 与一条 `memory_evidence(stance=supported)`。**事件不可省**——这是可追溯性的下限。

### 3.3 旧三态映射

| 旧 | 新 | 说明 |
|---|---|---|
| `active` | `Memory` | 原样，继续注入 |
| `stale` | `Review` | 完结归档，不注入；原 `stale` 的 todo 完成语义保留在 `rev.done` 元数据 |
| `archived` | `Review` + `rev.tombstone=true` | 软删：不注入、不参与检索，`memory_read` 仍可读 |

> 不引入 `Invalidated` 态：archived 已是软删，再分一层没有实际收益（结论记在这里，避免实现时再加）。

## 4. 工具契约（22 个，前缀保持 `memory_*`）

| 工具 | 必填 | 可选 | 说明 |
|---|---|---|---|
| `memory_remember` | `content` `project` `keywords` | `level` `subcategory` `importance` `goal` `corrected` | 用户显式写入 |
| `memory_observe` | `content` `source_kind` | `occurred_at` `subject` `data_ref` `idempotency_key` | 原始观察落事件 |
| `memory_search` | `query` | `level` `project` `status` `days` `k` `content_max` `explain` | 混合检索，返回带解释 |
| `memory_read` | `id` | `include_evidence` | 读全文 + 证据链 |
| `memory_update` | `id` | `content` `status` `keywords` `importance` `project` `subcategory` `goal` | 带版本快照 |
| `memory_context` | `query` | `token_budget` `level` | 按预算拼装上下文块 |
| `memory_project` | `project` | `limit` | 项目全景：按 `project` 列跨七层精确聚合（旧数据无该列时退化为标题/关键词匹配），每层给条数与字数、内容取 L1 摘要；`project` 层额外按 `subcategory` 分组。实测 `dsh` = 250 条 / 98,292 字（user 6 / project 8 / fact 81 / lesson 137 / topic 17 / rules 1） |
| `memory_home` | — | `target` | 全局目录查看/切换 |
| `memory_dream` | — | `group` | 整理窗口 |
| `memory_find_similar` | `id` | `k` `content_max` | 相似/冲突查找 |
| `memory_forget` | `id` | `hard` | 默认软删，`hard=true` 才真删 |
| `memory_link` | `from` `to` `relation` | `remove` | 手工维护关系（same_topic / supersedes / contradicts），校验两端存在、禁自连 |
| `memory_feedback` | `id` `kind` | `note` | 反馈只淘汰不提升：`wrong` 降 `review`，`useful` 只记事件不改状态 |
| `memory_health` | — | — | 条数/体积/索引/模型状态，含 `relations` 与 `firstTurnTokens` |
| `memory_profile` | — | `action` `topic` `sub_topic` `content` `merge` `limit` `advance` | 用户画像维护：`get` / `upsert` / `delete` / `refresh`（带 `advance: true` 时推进「已归纳」游标）/ `pending`（列出尚未归纳的 `user` 记忆）。详见 §15 |

**与旧插件的工具名冲突**：新旧都注册 `memory_*`，同一 profile 装两个会撞。**验收方案**：meow-mind 只在独立 profile（`dsh plugin --profile mind add …`）或临时 `DSH_HOME` 里验收，切换时一次换掉，不做共存。（这条写死，不许在实现时"兼容一下"。）

## 5. 注入

### 5.1 首轮（每会话一次）

```
<meow-mind>
## 记忆使用说明（≤200 tokens，固定）
...要点...

## 长期记忆（user 层）
- 条 1
- 条 2

## 全局准则（rules 层，importance≥2）
- 条 1
</meow-mind>
```

预算：整块 **≤3,200 tokens**（实测基线 7.8K）。超预算时按 `importance` 降序截断，被截断的条数写入块尾（`另有 N 条未展开，用 memory_search 查`）。

### 5.2 每消息

1. 取用户消息文本（<8 字不检索）。
2. 混合召回 top-k（k=6），只取 `status='memory'`。
3. **去重**：本会话已注入过的 `memory_id` 跳过（沿用现 meow-memory 的 `seen` 机制）。
4. 输出 L0 摘要（每条 ≤60 字），命中语义相近的多条合并成一行。
5. 预算 **≤800 tokens**；为 0 时不输出（不写空块）。

### 5.3 L0/L1/L2

| 级 | 内容 | 何时 | 实现 |
|---|---|---|---|
| L0 | 一句话主旨（≤60 字） | 首轮块每条 | `l0()`：剥代码块/markdown/URL/短括号 → 按句切取首句 → 超长再按标点剪 |
| L1 | 首句 + 后续要点（命中块 ≤80 字；`read` 里可要 200 字） | 命中块每条 / `memory_read?detail=l1` | `l1()`：同 L0 但要第二条要点，用「；」连接 |
| L2 | 原文 | `memory_read`（默认） | `l2()` 原样返回 |

**不做**服务端摘要生成（无模型调用）：全部规则实现。质量靠「先剥噪音、再按句子边界切」，不靠生成。

**句读的关键坑**：英文句点 `0.2.2-rc.5`、`v1.2`、`5.10.5→5.10.6` 里的点不是句末——`sentences()` 只在「点后跟空白或结尾，且点两侧不都是数字」时才切。初版把 `.` 一律当句读，一条记忆被切成 `内核 0.` `1.` `5-rc.`，摘要直接失效（实测 L0 从有意义的 11.8% 变成一个字的碎片）。

**实测压缩比**（927 条 / 378,487 字，含 archived/stale）：L0 **11.8%**（44,504 字）、L1 **39.3%**（148,617 字）。按层看 L0 平均 40–49 字/条、L1 平均 133–166 字/条；user 层原文本来就短（168 字/条），压到 L1 只剩 21% 收益，所以首轮块里 user 用 L0 而不是 L1。

## 6. 检索与排序

### 6.1 词法通道

- 中文 bigram + 英文/数字词，`content` 与 `keywords`（权重 ×2）合并成 `body`。
- BM25：`k1=1.2, b=0.75`（沿用阶段 0 基线实现，已验证）。

### 6.2 语义通道

- 模型：`Xenova/bge-base-zh-v1.5` q8（ONNX 98.1 MB，随包放 `models/Xenova/bge-base-zh-v1.5/`），`dtype='q8'`，768 维，cls 池化 + L2 归一。
- 加载：**懒加载 + 后台预热**——`apply` 后 2 秒起 `ensureEmbedder()`，首次冷加载约 15 秒不能挡第一步；缓存后重新加载 280 ms。
- 向量：`memory_remember` 写入时算并落 `memory_vectors`（失败静默）；存量用 `idsMissingVectors` 补，431 条约 **45–54 秒**（104–126 ms/条）。
- 混合：**双通道召回**（不是「先词法筛再重排」）——
  - 候选 = 词法 `bm25Candidates`（`hybridPool` 默认 50）**∪** 语义 top `semanticPool`（默认 20，全库扫 `allVectors`）。
  - 两通道都命中：`semanticMix × 语义分 + (1 - semanticMix) × 词法分`（默认 0.5）。
  - **只被语义召回：语义分打五折**——单一通道证据弱于双通道证据，不打折会挤掉词法已排对的条目（实测 hit@5 从 79.2% 掉回 66.7%）。
  - 只被词法召回：用词法分，不额外惩罚。
- 耗时：431 条库上 query 嵌入约 4.7 ms + 全库余弦约 1 ms，单次混合检索 **30–44 ms**。
- 断网/模型缺失：降级纯 BM25，`memory_health` 报 `embeddingAvailable: false`。

### 6.3 四因子排序

```
score = 0.65 × lex_norm        // 词法或融合分，归一到 [0,1]
      + 0.15 × recency         // exp(-天数/30)
      + 0.10 × status_weight   // Memory 1.0 / Evolution 0.9 / Review 0.4 / Candidate 0.3
      + 0.10 × evidence_norm   // min(1, supported_count / 3)
```

权重写在配置里可调；`explain=true` 时返回四因子分解。

**为什么不是 0.45/0.20/0.20/0.15（初版）**：24 条评测集上，recency + status 各 0.2 的固定先验合计 0.4，对「找一个具体事实」这类查询过重——正确条目哪怕词法排第一，也会被「最近改过的无关条目」顶掉。三组权重实测见 §13.4。差异都在 ±1 条（≈4pp）内，样本小，当前取「hit@5 最高且保留先验」的一组。

## 7. 写入治理

### 7.1 查重合并（写入时）

1. 新内容先算 embedding（若模型可用），与同层最近的 5 条比余弦。
2. `>0.92` → 判重复：`memory_relations(duplicates)`，不新建，返回既有 id。
3. `0.80–0.92` → 判相似：建 `Candidate` + `refines` 关系，待 Review。
4. `<0.80` → 正常新建。

### 7.2 Review 慢速通道（dream 时）

- 扫描 `Candidate` 超过 7 天的 → 晋升或丢弃（按 §3.1 规则）。
- 扫描 `Memory` 中 `contradicts` 关系的 → 输出裁决清单。
- 扫描 90 天未命中且 `importance≤1` 的 → 标 `Review`（不删）。
- 每次产出 `extract_runs` 一条审计。

## 8. 配置 schema

```
{
  memory_home: string | null,
  embedding: { enabled: bool (true), model: string ('Xenova/bge-base-zh-v1.5'), dtype: 'q8' | 'fp32' (q8) },
  injection: { firstTurnBudget: 3200, perMessageBudget: 800, summaryChars: 60 },
  retrieval: { topK: 6, hybridPool: 50, minScore: 0.0 },
  weights: { lex: 0.45, recency: 0.20, status: 0.20, evidence: 0.15 },
  governance: { dupThreshold: 0.92, similarThreshold: 0.80, candidateTtlDays: 7, staleDays: 90 }
}
```

全部 `.volatile()`（设置页可写）。

## 9. 迁移方案（阶段 4）

1. 备份：`memory.db` + wal/shm → `handover/backups/`，跑 `PRAGMA integrity_check`。
2. 建新库：`<cwd>/.dsh-mind/memory.db`，执行 schema。
3. 逐表搬：七层表保持 id 不动（迁移后 id 不变，便于对拍）。
4. 状态映射：按 §3.3。
5. `keywords` → 重建 FTS body（bigram 预切词）。
6. 向量：对全部条目批量算一次（后台任务，16 条/批）。**实测 927 条 172.4 秒（186 ms/条）**，进程内存峰值约 1.35 GB；这是迁移时的一次性成本，装好后只对新增条目增量嵌入。
7. 对拍报告：条数、字数、每层 status 分布、全量内容逐字比对。**实测（2026-11-20）：927 条全部迁移、逐条比对不一致 0 条、FTS 建索引 927 条、`project` 归属完整保留（fact: dsh 197 / 全局 32 / gxu-grad 29；lesson: dsh 176 / 全局 154）。**
8. 回滚：保留旧目录，`memory_home` 指针切回。

## 10. 实现约束（MVP）

- 模块 ≤15 个文件；单文件 ≤600 行。
- 零运行时依赖（`node:sqlite` 内置）；embedding 走可选依赖 `@huggingface/transformers`（缺失则降级）。
- 不写 `process.env` 以外的全局状态；所有 IO 走 `ctx.logger`。
- 每次写操作串行（单 promise 链），避免 SQLite 锁竞争。

## 11. 验收判据（阶段 2 出口）

- [ ] `dsh plugin --profile mind add` 装得上，工具面 13 个齐全。
- [ ] 空库 → 写 10 条 → 关会话 → 新会话首轮注入里有它们。
- [ ] 24 条评测集：hit@5 ≥ 85%、MRR ≥ 0.72。
- [ ] 首轮注入 ≤3,200 tokens（用 `memory_context` 实测）。
- [ ] 断网/删模型后仍能纯 BM25 工作。
- [ ] 重复内容写入不产生第二条（查重生效）。
- [ ] 旧库迁移对拍零差异。

## 12. 连锁修改清单（六态改名波及面）

| 对象 | 改什么 | 何时 |
|---|---|---|
| `~/.dsh/AGENTS.md` 第九节 | status 段：active/stale/archived → 六态表述 | 迁移前 |
| 各工作区 `agent-准则.md` | 同上 | 迁移前 |
| `memory-collab` 技能 | status 用法、dream 流程 | 迁移前 |
| `dsh` 技能 references | 若提到 meow-memory 状态 | 迁移前 |
| 记忆条目本身 | 状态值迁移（脚本做，不手改） | 迁移时 |
| `插件说明.txt` | 插件名/版本/端口 | 上线时 |

## 13. 实测记录（2026-11-20）

### 13.1 依赖与体积
| 包 | 体积 | 备注 |
|---|---|---|
| `onnxruntime-node` | **287.7 MB / 236 文件** | 含 win32/darwin/linux × x64/arm64 全套二进制，比规划估的 85 MB 大 3 倍多 |
| `@huggingface/transformers` | 10.3 MB / 1,479 文件 | 4.3.2 |
| `sharp` | 0.9 MB / 47 文件 | transformers 的图片预处理依赖 |
| `protobufjs` | 2.9 MB / 79 文件 | onnxruntime 依赖 |
| 模型 `Xenova/bge-base-zh-v1.5` q8 | 103 MB | 走 hf-mirror 下载 |
| 插件本体 | 约 56 KB | src 8 个文件 + SPEC + README |

**结论：语义通道的实际代价约 400 MB，不是规划里的 200 MB。**

### 13.2 安装坑（必须写进文档）
pnpm 11 默认 `strict-dep-builds=true`，遇到 `onnxruntime-node` / `protobufjs` 的 build script 会**以退出码 1 结束**（包其实已装好）。装的时候要带：
```
dsh plugin --profile <p> add file:<path> --config.strict-dep-builds=false
```
这两个包不需要 build script：`onnxruntime-node` 自带全平台预编译 `.node` 与 `.dll`。

### 13.3 宿主契约（对照 meow-memory 源码确认）
- 事件签名：`ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => { const decision = await next(); ... })`
- 判定：`decision.kind === 'enter'` 才改写；`signal.aborted` 直接放行
- 消息：`decision.messages`；改写方式 `[...decision.messages]` + `splice(indexOf(userMsgs[0]), 0, msg)`
- 注入消息：`createUserMessage({ content, source: { kind: 'plugin:<name>', form, sections } })`，来自 `@deepseek-ai/dsh-llm`
- 子代理：`agent.session.header.origin === 'subagent'` 不注入

### 13.4 实测数据
- **首轮块（真实 431 条记忆）：3,073 tokens / 3,465 字符**（预算 3200，占 96%）；对照 meow-memory 现在的约 7.8K，**降 61%**
- 首轮块（5 条测试数据）：282 tokens / 350 字符
- 命中块（真实库）：**287–366 tokens**（预算 800，占 36–46%）
- token 估算：100 汉字 = 150 tokens（CJK 1.5/字）
- 白盒：12 工具全部有 `parameters` / `output.schema` / `output.render`；pre-step 注入 2 条；子代理注入 0 条
- 检索（真实库 5 条跨层问法）：top1 命中 2 条（「技能换机器」→ 可移植改造、「记忆插件重写」→ 记忆库重写），3 条偏（「工具全没了怎么修」仍给 PS 编码坑、「挑东西」给成技能分层）——**与阶段 0 结论一致：跨层综合性问题靠检索算法救不回，属内容治理**

**预算截断的坑（已修）**：初版逐条累加只算 `GUIDE + 40`，没预留 4 个节标题与「另 N 条未展开」行的开销，导致拼装后 3,239 > 3,200。改成预留 200 tokens 后稳定在 3,073。

### 13.4b 阶段 3 混合检索实测（24 条评测集 / 431 条记忆）

| 权重 (lex/recency/status/evidence) | 通道 | hit@1 | hit@5 | MRR |
|---|---|---|---|---|
| 45/20/20/15（初版） | 纯 BM25 | 25.0% | 66.7% | 0.466 |
| 45/20/20/15 | 混合 | 25.0% | **79.2%** | 0.461 |
| 85/5/5/5（低先验） | 纯 BM25 | 29.2% | 66.7% | 0.478 |
| **85/5/5/5** | 混合 | **33.3%** | 75.0% | **0.527** |
| 65/15/10/10（中先验，**采用**） | 纯 BM25 | 29.2% | 66.7% | 0.487 |
| **65/15/10/10** | 混合 | 29.2% | **79.2%** | 0.502 |

**结论**：
1. **混合检索的价值在 hit@5**（补回词法漏掉的召回），不在 hit@1——词法已经排第一的查询，语义加进来也翻不动，只可能搅乱。
2. **recency + status 合计 0.4 的固定先验对「找具体事实」过重**：压到 0.15+0.10 后 hit@1 从 25.0% 升到 29.2%。压到 0.05+0.05 能到 33.3%，但会让已完结（Review）条目过多混入，故未取。
3. **样本只有 24 条，三组差异都在 ±1 条（≈4pp）内**，属于噪声量级；当前选 65/15/10/10 是因为 hit@5 最高且保留先验结构，不是因为它统计显著。
4. 语义候选**必须打折**（×0.5），否则会挤掉词法已排对的条目——这是实现上最容易踩的坑。

### 13.5 降级设计
- `@deepseek-ai/schemastery` 缺失 → `config = undefined`，插件仍加载（只是没有设置表单）
- `@huggingface/transformers` 缺失或加载失败 → 纯 BM25，`warn` 一次
- 所有注入失败 → `fail-open` 放行原始消息

### 13.6 2026-11-20 修的三处数据格式 bug（都影响排序但不报错）

1. **时间戳格式**：迁移来的 `created_at` / `updated_at` 是**毫秒数字字符串**（`"1792647808084.0"`），`new Date(s).toISOString()` 抛 `RangeError: Invalid time value`。改法：原样传（`insertMemory` 存 TEXT），不做 ISO 转换。
2. **keywords 格式**：库里存 `JSON.stringify([...])`，测试脚本若用 `String(k).split(/\s+/)` 会得到含引号的整串，**关键词加权完全失效**（实测命中 hit@5 从 79.2% 掉到 66.7%）。改法：导出时 `JSON.parse(k).join(' ')`。
3. **`daysSince` 对毫秒字符串失效（最隐蔽）**：`Date.parse("1792647808084.0")` 返回 NaN → `return 999` → `recency = exp(-999/30) ≈ 0`。**四因子里 recency / status / evidence 三项于是对所有条目完全相同**，排序退化成只看词法分，权重参数等于没接上。这就是 2026-11-20 早些时候三组权重（45/20/20/15、85/5/5/5、65/15/10/10）跑出完全相同数字的原因。修法：`Date.parse` 失败时再用 `Number(v)` 兜一次。

**修后实测（435 条 / 24 条查询）**：纯词法 65/15/10/10 → hit@1 29.2% / hit@5 62.5% / MRR 0.465；纯词法 85/5/5/5 → 同 hit，MRR 0.456（**两权重开始分化**）；混合 65/15/10/10 → 29.2% / **70.8%** / 0.486；混合 85/5/5/5 → **33.3%** / 66.7% / **0.505**。混合比纯词法 hit@5 高 8.3pp。

### 13.6b 测试数据的自给约定

`test/fixtures-memories.json`（931 条，含 archived/stale）+ `test/fixtures-queries.json`（24 条评测集，A 词面 8 / B 语义改写 8 / C 跨层 8）随脚本走，用 `new URL('fixtures-*.json', import.meta.url)` 定位。**不再依赖任何外部目录**（2026-11-20 曾因删 `_mind-p0` 导致两个测试脚本断粮）。重建 fixtures 时注意上面 §13.6 的两条格式坑。

### 13.6c 关系网（2026-11-20 补）

表 `memory_relations(from_id, to_id, relation, created_at)`，主键 `(from_id, to_id, relation)`，`to_id` 上有索引。三类关系：

- `same_topic`——同主题：同 project（或一方为空）+ keywords 交集 ≥ 3，**写入时自动建双向边**；
- `supersedes`——取代：由 `memory_link` 手动建；
- `contradicts`——冲突：由 `memory_link` 手动建，`memory_dream` 会列出全部冲突对。

**写入路径**：`memory_remember` 落库后调 `linkRelated(db, m, level)`，返回建了几条边（`linked` 字段）；关系网失败不影响记忆本身。

**全库重建**：`memory_dream({ rebuild_relations: true })` → `rebuildRelations(db)`，先删全部 `same_topic` 再重算。933 条实测 **94 对 / 188 条双向边 / 54 ms**。

**覆盖率**：137 条有关系 / 933 条 = **14.7%**。低是正常且想要的——阈值 3 只认强关联；抽检 6 对全部正确（同内容的新旧两版、同一批插件升级、同一份准则的两版、RTX 5080 装机记录）。

**第 13 个工具 `memory_link`**：参数 `{ from, to, relation, remove }`；只校验两个 id 都存在、禁止连自己；成功写一条 `events(kind='link')`。

**关系参与检索（2026-11-20 补）**：`fusedSearch` 在排序完成后，取前 5 条做种子，各带出 `same_topic` 邻居，分数 = `种子分 × 0.35`（常量 `RELATION_FACTOR`、`RELATION_SEEDS`）。邻居只补召回、不抢位置——不加分给已排好的条目，只在 limit 有余量时补在后面。实测「RTX 5080 装机」查询带出一条装机排障记录（种子 `0mw8wce3a`，score 0.116）。

**已知边界**：关系网只有 14.7% 覆盖，所以扩展是加分项不是主力；`supersedes` / `contradicts` 目前只存不参与排序（冲突对由 `memory_dream` 列出供人工判断）。

### 13.7 自动捕获与三条纪律（2026-11-20 晚）

参考 Mnemosyne 与 OpenViking 的源码后补的四件事——两家都没做全，但各有可借的落地形态。

### 自动捕获（补最大的缺口）

**问题**：原设计只靠模型主动调 `memory_remember`，一段对话没主动写、被压缩就永久没了。这是比「状态机只跑两态」更实际的缺口。

**触发**：`agent/pre-step` 的 `enter` 分支，在拼注入块之前处理最后一条 user 消息。不单独注册 `session/event`，因为 pre-step 已经拿到同一批消息且能省一次事件往返。

**清洗与过滤（`src/capture.mjs`）**：
- `cleanForCapture(text)`：剥掉自己注入的 `<meow-mind>` / `<meow-mind-hit>` 块（否则召回内容被写回库形成回声，OpenViking `capture-utils.mjs:619-640` 同款做法），再压缩空白；
- `shouldCapture(text)`：长度 12–8000、非纯噪音（`嗯`/`ok`/`谢谢`/`收到` 这类整条都是语气词）、CJK ≥4 或字母数字 ≥6；
- `fingerprint(text)`：FNV-1a → base36，进幂等键。

**落库**：`recordEvent({ kind: 'observe', payload: { content, sourceKind: 'dialog', auto: true }, idempotencyKey: `auto:${sessionId}:${fingerprint}` })`。同一句话在同一会话里只落一次；不同会话各落一次（同一事实在不同上下文出现是合理的）。

**开关**：`governance.autoCapture`，默认 `true`。捕获失败一律静默——不能因为写观察失败把对话拦住。

### 三条纪律

| # | 纪律 | 来源 | 本地落地 |
|---|------|------|---------|
| 1 | 写记忆必挂来源 | Mnemosyne `ingestion/pipeline.py:29-57`（无 source_ids 的 active 强制降 candidate） | `memory_remember` 先 `recordEvent(kind='observe')` 再 `addEvidence`，一条记忆至少挂一条自己的观察；来源 id 落在 `memory_evidence` |
| 2 | 派生材料不当证据 | Mnemosyne `verification/assessment.py:34-38` | `addEvidence` 拒收 `inference` / `agent_inference` / `summary` / `model_output` / `self_eval` / `generated` 六类 `sourceKind`（`stance='supported'` 时），返回 `null` |
| 3 | 反馈只淘汰不提升 | Mnemosyne `feedback_learning.py:18-49`（`confidence_delta=0.0`）+ `promote.py:30-34`（`useful_feedback` 已 retired，"usefulness is utility, not truth"） | `memory_feedback({ kind: 'wrong' })` → 降 `review`；`{ kind: 'useful' }` 只写 `events(kind='feedback')`，**不动状态、不动分数** |

**为什么不做「有用就升」**：Mnemosyne 自己把这条规则退役了。有用是效用不是真实性——一条被频繁用到的错误记忆会因此越升越高。反馈的正确用途是**发现错误**，不是**确认正确**。

**不做**：六级状态机的完整晋升引擎（需要 claim 生命周期 + 验证引擎 + 依赖传播，Mnemosyne 用了 AST 解析器与 SCC 依赖图，代价远大于收益）；`memory_feedback` 的多信号权重（本地没有 outcome/self_eval 信号源，只有用户显式评价）。

### 实测（`test/discipline.mjs`，七项全过）

```
[capture]     observe=1 auto=1            —— 用户消息落进 events，payload.auto=true
[idempotent]  observe=1                   —— 同一消息再跑不重复写
[noise]       sess-2 observe=0            ——「嗯嗯」不捕获
[evidence]    派生=null(拒绝) 真实=写入     —— agent_inference 被拒、user_statement 正常
[feedback]    useful->memory wrong->review —— useful 不改状态、wrong 降 review
[strip]       "正文 结束"                  —— 注入块被剥掉，回声防护生效
[tools]       14 个
```

### 13.8 意图分桶配额与 dream 自洁（2026-11-20）

**意图分桶**（`src/bm25.mjs`）：`INTENT_PATTERNS` 五类（preference / howto / where / when），命中第一个即定，否则 `general`；`INTENT_QUOTAS` 按层分配 top-k 槽位（如 `howto: {lesson 4, rules 1, fact 1}`、`where: {fact 3, project 2}`）；`bucketPick()` 先按配额逐层取，不足按总分补齐，最后按分重排。开关 `retrieval.intentQuota`（默认 true）。

**坑**：`howto` 正则不能用单独的「怎么」，否则「今天天气怎么样」被误判；改成「怎么 + 动词」集合才准。

**实测（435 条 / 24 条查询）**：开启分桶后 hit@1 / hit@5 / MRR 与关闭时**完全一致**（纯词法 29.2% / 62.5% / 0.460；混合 29.2% / 70.8% / 0.486）。原因：评测集多数是 general 意图，且 hit@k 只判「期望 id 在不在 top5」，分桶改变的是**层的构成**而非**是否命中**。**分桶的价值要用「top5 覆盖几层」这类指标衡量，不能用 hit@k。**

**dream 自洁**（`src/store.mjs` 三个函数 + `memory_dream` 接线）：
- `findDuplicates(db, 0.92)`——只在 `same_topic` 边上算（`from_id < to_id`），避免 O(n²) 全库比较；token 集合余弦；只比 status 都是 memory 的；保留 `updated_at` 新的。
- `mergeMemory(db, pair)`——关键词并集截 13 个写回 keep，drop 设 `review` + 从 FTS 删 + 记 `supersedes`。
- `splitLongMemory(db, id, 800)`——从中间找句号/分号/换行切，前半留原条、后半建新条（标题「（续）」），互连 `same_topic`。

**实测**：活库 935 条里重复对 **0 个**（sim ≥ 0.92 一条都没有）；超长 **3 条**已拆——`topic` 1079 → 587+492、`project` 858 → 315+543、`fact` 852 → 360+492，三条接缝处语义连贯、新条目 status 均为 memory。同主题边从 188 增到 **196**。

### 13.9 `/dream` 斜杠指令（2026-11-20 晚）

**为什么加**：整理记忆库原本只能靠模型主动调 `memory_dream` 工具。斜杠指令是模型之外的第二条路——用户直接敲，不占对话轮次。

**宿主契约**（从两个已装插件反证；`app.asar` 里只有内核自己的 `registerCommandConversationNode`，没有插件侧 API）：

```js
ctx.inject(['commands'], (c) => {
  c.commands.register({
    name: 'dream',
    description: '整理记忆库：查重合并、超长拆分、重建关系网',
    input: { hint: '[run] · 不带参数只列清单，/dream run 实际执行' },
    handler: async ({ agent, rawInput }) => {
      const cwd = agent?.session?.header?.cwd;
      return { kind: 'success', text: '...' };   // 内核只认 success / error 两种
    },
  });
});
```

参考 `dsh-visual-card/index.js:227-245`（`/visual`，用 `safeCommand` 吞 duplicate 错误）与 `@ericwang1358/dsh-daily-flashcard/lib/index.js:74-104`（`/study-spar`，第 91 行取 `agent?.session?.header?.cwd`）。

**两档设计**：清理不可逆，所以**默认档必须只读**。

- `/dream` → 列清单：「记忆库 N 条 / 重复对 N 个 / 超长 N 条」，非空时给前 3 条可拆分候选与可合并对，末行提示 `/dream run`
- `/dream run` → `rebuildRelations` → `mergeMemory`（≤5 对）→ `splitLongMemory`（≤3 条），每步 try/catch 隔离，任一步失败不影响其余

**实测**（2026-11-20 17:45，work 库 938 条）：dry 档 `重复对 0 / 超长 58`；run 档 `关系网重建 100 对 / 合并 0 对 / 拆分 3 条`。

**边界**：`ctx.commands` 不存在时（老宿主）整段跳过，不影响工具面；重复注册被 try/catch 吞掉——插件可能被 bundle 与 patch 各加载一次，第二次跳过而不是让 boot 失败。
### 13.10 沉淀候选（`/dream` 会提醒该更新哪个技能）

**为什么加**：`~/.dsh/AGENTS.md` 第十一节有「整理记忆时同步判去向」的准则——记忆里的方法与流程该写进技能。但 `memory_dream` 原先不做这个判断，全靠临时想起来。

**判据（四层筛，`store.mjs` 的 `findSinkCandidates`）**：
1. 只扫 `lesson` / `rules` 两层、`status='memory'`、`created_at` 在窗口内（默认 **1 天**——老账不该逐条列；30 天会报 159 条等于没筛，1 天 21 条才是能看的量）；
2. 长度 > 60 字且命中 `METHOD_WORDS`（`必须|应该|不要|判据|步骤|先|再|然后|否则|正确做法|坑|报错|症状|红线|注意`）；
3. 不含 `SUNK_MARK`（`已写进|沉淀到|见 skill|归入技能|已归技能`）——已标去向的不再报；
4. 与各技能 `SKILL.md` 的 token 集合算重合率：**> 0.5 判为「已写进技能」直接排除**；0.12–0.5 记为 `hintSkill`（猜它该进哪个技能）。

技能目录取 `process.env.MEOW_MIND_SKILLS_DIR || ~/.agents/skills`，每个子目录读 `SKILL.md`。

**接入点**：`memory_dream` 的两个 return 都带 `sinkCandidates: { total, items }`；`/dream` 的 dry 与 run 各加一行「可沉淀：N 条…（→skill 或未匹配）」。

**为什么只列不改**：技能文件改坏会导致加载失败且无回滚；机器给候选，是否修改由模型判断后动手。

### 13.11 拆分条目的向量补齐（2026-11-21 修）

**问题**：`splitLongMemory` 只做两件事——把原条目内容截成前半、`insertMemory` 建一条标题带「（续）」的新条，**不写向量**。结果是拆出来的条目只在词法通道可见，语义检索永远搜不到它。

**怎么发现的**：修好 `memory_find_similar` 之后顺手核对「记忆条数 vs 向量条数」，发现 `946 条 / 937 向量`，差 **9 条全是「（续）」**——全是 11-20 那两次 `/dream run` 拆出来的（project 层 7 条、fact 1、topic 1；3 条 `memory`、6 条 `review`）。

**修法（两处调用方都要补）**：
1. `store.mjs` 的 `splitLongMemory` 返回值加 `tail`（切出去的后半段原文），让调用方能拿到要嵌入的文本；
2. `index.mjs` 的 `/dream`：拆分前 `const emSplit = await ensureEmbedder().catch(() => null)`，拆完对 `r.newId` 调 `saveVector(db, r.newId, await emSplit.embed(r.tail), m.level)`；
3. `tools.mjs` 的 `memory_dream`：同一套逻辑，用 `deps.embed`（`registerTools` 解构出来的那个）——`memory_dream` 的 `execute` 本来就是 async，不用改签名。

两处都用 try/catch 包住补向量那一步：**补失败不影响拆分本身**，最坏退回只有词法通道的旧行为。

**实测**：补完 9 条耗时约 1 秒（短文本 100–190 ms/条），向量总数 **937 → 946**（= 全量条数），缺向量 0 条。

**一个部署上的坑**：源码目录 `C:\deepseek\work\meow-mind\node_modules` 已于 11-20 删除（464 MB 纯开发依赖），所以**在源码目录里跑任何 import `embed.mjs` 的脚本都会报 `Cannot find package '@huggingface/transformers'`**。补向量的脚本要放到 `C:\Users\ZQY\.dsh\profiles\desktop\` 下跑，用 `./node_modules/meow-mind/src/...` 导入——那份插件副本的依赖是 pnpm hoisted 到 profile 的 `node_modules` 里的，能解析。

---

### 13.12 插件侧的沉淀候选（2026-11-21 补）

**为什么补**：§13.10 的沉淀候选只回答「这条经验该不该写进自建**技能**」，插件侧完全没判。用户问「脚本怎么判断是否有价值用来优化自建的插件与技能」时，只能承认「插件那半是空的」——不是漏写，是拿 token 重合率去比 `src/*.mjs` 没有意义（技能是自然语言，插件是代码）。

**换成比什么**：比**符号**。

> 如果一条记忆点名了某个函数名 / 配置键 / 报错串，而所有自建插件的源码里都找不到它，那要么插件缺这个能力，要么行为已经变了。

**判据（`src/plugins.mjs` 的 `findPluginGaps(db, limit = 5, sinceDays = 7)`）**：

> 这段逻辑原本写在 `store.mjs` 里，2026-11-21 抽成独立模块：它只读文件系统、不碰数据库结构，与 `store.mjs` 的 CRUD / 向量 / 关系 / 技能沉淀是两件事；抽出后 `store.mjs` 从 601 行降到 517 行。`plugins.mjs` 反向 `import { parseStamp } from './store.mjs'`（时间戳双格式解析），单向依赖不成环。

1. **哪些算自建插件**——从 `~/.dsh/profiles/desktop/package.json` 读所有 `file:` / `link:` 依赖，**只留目录型**（`.tgz` / `.zip` 打包件不可改，跳过）。本机实测命中 4 个：`meow-mind`、`dsh-doc-parser`、`dsh-raw-html-v2`、`dsh-plugin-structured-prompt`。
2. **读源码**——递归 4 层、跳过 `node_modules` 与点目录、只吃 `.mjs/.cjs/.js/.ts/.json/.md`、累计上限 2 MB，拼成一个大字符串缓存（`_pluginSources`，一次进程只读一遍）。
3. **抽符号**——正则只抓「像代码标识符」的三种形态：**小写开头的驼峰**（`findSinkCandidates`）、**全小写的下划线名**（`split_long_memory`）、**小写开头的点分名**（`governance.autoCapture`）；再排除 **文件扩展名**（`.exe/.dll/.dmp/.log/.json/.md/...`）与 `i.e` / `e.g` / `etc` 这类缩写。
4. **比对**——符号在上面那个源码大串里出现一次就算「已覆盖」，全都找不到的进候选；同一符号全局只留一条，按所在记忆的字数倒序取前 `limit`。

**第一版踩的坑**：正则放宽到「任何含点或下划线或大写字母的词」，结果报出 `userinit.exe` 与 `MEMORY.DMP` 两个 **Windows 系统文件名**——它们当然不在插件源码里。收紧成「小写开头」+ 扩展名黑名单后归零。

**实测（work 库 946 条，近 7 天）**：**0 条**。这不是判据失效，是**好消息**：近期记忆里提到的符号（`findSinkCandidates`、`splitLongMemory`、`memory_find_similar` 等）**都在 meow-mind 源码里**，说明记忆描述与插件实现是同步的。这个指标的用法是**哨兵**——平时安静，一旦报出来就说明「记忆说有这么个东西，代码里却没有」。

**接了三处**：

| 入口 | 字段 | 输出 |
|---|---|---|
| `memory_dream` 两档 return | `pluginGaps` | `{ total, items, plugins }` |
| `/dream` dry 档 | 一行文本 | `插件缺口：无（近 7 天记忆提到的符号都在自建插件源码里）` |
| 自检 07 项 | `sink.pluginGaps` | `插件缺口：N 个符号在自建插件源码里找不到（...）` |

**边界（写清免得被当成准的用）**：

- **假阳率不低**：源码注释里出现过的词也算「覆盖」，所以某些真缺口会被漏掉；反过来外部工具名（`ffmpeg`、`sqlite3`）若不在任何插件源码里就会报出来。
- **只读不改**：和 §13.10 一样，工具只列候选，改插件是我的活，不是它的。
- **读不到就是跳过**：`package.json` 缺失、目录不存在、`meow-mind` 没装，都返回 `skipped` 而不是抛错，不影响 dream 与自检其余项。

### 13.13 写入自动带会话识别码

**问题**：会话码规则（`AGENTS.md` 第九节）要求「写记忆必须附码」，但那是靠模型手打——忘了就漏、打错就串味。

**做法**（`src/code.mjs`，2026-11-21）：

```js
export function sessionCode(sessionId) {
  // 1) 先查 ~/.dsh/CODES.md 表里登记的码（用户定过用途前缀，最准）
  // 2) 查不到就按 <前缀>-<SHA1(sessionID) 前 8 位>-<后 4 位> 现算，前缀缺省 MT
}
export function decorate(content, exec) {
  return withCode(content, sessionCode(sessionIdFrom(exec)));  // exec.agent.session.header.id
}
```

**接线**：`memory_remember` / `memory_observe` / `memory_update` 三个写工具的 `execute(args, exec)` 取第二个参数，正文经 `decorate()` 补 `（码：XX-XXXXXXXX-XXXX）`；`memory_update` 只在传了 `content` 时补，只改状态/标题不动正文。

**三条边界**：

1. **已带码不重复**——正则认末尾 `（码：XX-XXXXXXXX-XXXX）`，手写过也不会变两个；
2. **拿不到会话 id 就不加**（`exec.agent.session` 缺失时静默跳过），不阻断写入；
3. **码表读不到就现算**——前缀退化成 `MT`，不报错。

**实测**：单元测试 10 项全过——码表命中得 `LD-BA49BC34-894F`、未登记会话现算得 `MT-D2A18D58-9543` 且幂等、补码在末尾、已带码不重复、无 `exec` 不加码、`exec.agent` 存在但无 `session` 也不加。

**为什么不用环境变量 `DSH_SESSION_ID`**：host 是单进程多会话，环境变量是进程级的，只反映启动时那个会话；`exec.agent.session.header.id` 才是每次工具调用真实的会话。

### 13.14 结论与证据分离 + 全库精修（2026-11-21）

**用户原话**：「这么写记忆太长了，把证据，具体做了什么从记忆中剥离出来单独存放，记忆中留结论与判据就行」。

**判据**：读这条记忆能不能直接做决定？能的部分留正文（结论 + 判据），不能的部分（实测数字、报错原文、过程、引用的原话）进证据表。

**三层落地**：
- 写入口：`memory_remember` 与 `memory_update` 新增 `evidence` 参数，正文与证据分道走；`memory_update` 改正文时**旧正文自动进证据表**（不依赖调用方记得传）。
- 存储：复用 `memory_evidence` 表，`source_kind='note'` + `quote` 放原文，不新建表（多一套存储＝多一份对账）。
- 回读：`memory_read` 的 relations/evidence 字段 + `listEvidence(db, id)` 可取最近 5 条原文。

**第一轮：机械瘦身（自动）** `slimMemory(db, level, id, {maxChars})` 取 L1 摘要并回退到完整句末（正文不以「…」结尾），原文整体存证据；`memory_dream` 的 run 分支与 `/dream run` 默认跑一遍（`slimMax` 默认 200 字，单次每层最多 60–80 条）。备份 `handover/backups/memory-before-slim-2026-11-21T07-58-24.db`；339 条 >180 字降到 ≤200 字（project 17 / fact 91 / lesson 190 / topic 22 / rules 19），证据表 note 352 条；随后两轮标点与括号修复 220 条。首轮块 3,051 → **3,045 tokens**——收益不在首轮（本来就只取 L0/L1），在检索命中块与 `memory_read` 的可读性。

**第二轮：全库人工精修（子代理）** 机械截断留下 12 条仍超 200 字、少数断在句中或括号内、个别从「③路径：」这类序号中间开始，光靠自动 pass 修不好。

做法：按层导出 416 条活跃记忆为 8 个 JSON 分片（rules 24 / project 17 / topic 22 / fact a/b 各 53 / lesson a/b/c 81–83），派 8 个子代理各自只读自己的输入、只写自己的输出 JSON，**数据库由主线串行写入**（避免多个 `node:sqlite` 抢写）。委派书统一要求：正文 = 结论 + 判据，目标 80–160 字、硬上限 200 字（含识别码）；阈值、路径、命令、字段名、工具名、ID 必须逐字保留；删实测过程、时间流水、大段引用；修补残句与未闭合括号；单行无 Markdown；原识别码保留、没有不新增。

应用（`_apply.mjs`）：先按 `{id: {level, content}}` 全库快照 `_polish/before-polish.json`（911 条，含 review 层），`*-fix.json` 排最后并允许覆盖同名 id；逐条旧正文 `addNoteEvidence`（按 `memory_id` + `quote` 去重）、`UPDATE <lv> SET content, title, updated_at`；末尾 `INSERT INTO memory_fts(memory_fts) VALUES('rebuild')`。备份 `handover/backups/memory-before-polish-2026-11-21T16-15.db`（9,555,968 B）。

**最终读数**：处理 416 条 / 更新 419（含 3 条只改标题）/ 未变 2 / **超 200 字 0 条** / 最长 200（`0mwek6b93`）。各层：rules 24 条 3,536 字（均 147）、project 17 / 3,003（177）、topic 22 / 3,700（168）、fact 106 / 14,717（139）、lesson 247 / 39,282（159）——**合计 416 条 / 64,238 字**，精修前约 9.4 万字，压缩约 **32%**；证据表 **767 条（note 753）**；FTS 重建 950 条；「原文丢失」等占位符 0。

**两个可复用的坑**：①**子代理报的字数不能直接信**——`topic` 交的第一版 5 条自报 198–199 字，主线复核实测 206–293 字；字数必须由主线用自己的计数器（`[...str].length`）过一遍。②**原文被早前裁剪丢掉的条目**（topic 层 5 条）能从 `memory_evidence` 里 `source_kind='note'` 取回精修前全文再重写——这就是「证据另存」顺带给出的回滚能力。

**已知不足**：正文里的 ①②③ 序号与半角括号混排，跨条目格式仍不统一；证据表只按需回读，没有 UI。

### 13.14b 用户全库批改后的清理（2026-11-21）

**用户操作**：在侧边栏逐条批改 **272 条**（全部 2026-11-21 当天打标）——useful 15（活跃 6）、useless 218（活跃 204）、只写评语 39（活跃 28）；其中 34 条指向已归档条目。

**处置判据**：评语分三类——①「有写进技能/插件里面吗，写了就删了」→ 逐条到 `C:\Users\ZQY\.agents\skills` 里核对，全部能在技能中找到（四件套→`dsh/references/ops.md`、技能与记忆分工→`memory-collab/SKILL.md:28`、四层门控→`dsh/references/ops.md:25` 等）；②「此条可以放新准则里面」→ 子代理优先已在 `~/.dsh/AGENTS.md` §十一，「意图不确定不要猜」新写进 §五；③「过时了 / 环境信息留自检快照」→ 直接删。

**执行**：备份 `handover/backups/memory-before-review2-2026-11-21T17-11-04.db`（10,784,768 B，含 wal/shm）；一个事务里删 **232 条**（204 useless + 28 评语）+ 232 行 `memory_marks` + 438 行 `memory_evidence`；`memory_links` 表不存在（关系网在另一处），脚本里做了存在性判断；末尾重建 FTS。

**保留 6 条**（用户标 useful）：画像只放跨场景特质、记忆只写结论与判据、汇报版本变动附更新说明、记忆库不重复技能、未经同意不安装、插件说明.txt 规模；另有 **171 条未被批改**的活跃记忆原样保留。

**结果**：活跃 **409 → 177** 条（rules 7 / project 5 / fact 11 / lesson 152 / topic 2），各层 review 累计 505 条；剩余标记 40 行、剩余证据 347 行；FTS 953；四套测试全绿（whitebox 16 工具、command 全通过含 `/log` 三条、discipline 六项 OK、smoke 正常）。

### 13.14c 按技能去重（2026-11-21，用户口径）

用户 m23106 让「筛哪些适合进共享记忆库」，看完 173 条清单后改口径（弹卡 custom）：「**先按技能去重，把技能覆盖到的记忆删掉**」。

做法：178 条活跃记忆按 `i % 4` 切成四片（45/45/44/44），四个子代理各查自己的 44–45 条，只读技能（用户级 `C:\Users\ZQY\.agents\skills` 12 个 + 五个插件自带技能），只写自己的 `out-<x>.json`；判据三档 `yes`（技能已写明核心判据/步骤，记忆无额外信息）/ `partial`（同主题但缺数字、报错或边界）/ `no`（零命中）；每条要给 `where`（文件:行）与 ≤40 字的原文 `quote`。

结果：**yes 118 / partial 35 / no 25**，yes 合计 18,931 字；主线抽查四条边界（`selfcheck.md` 5.4c、`SKILL.md` 路径表、`plugin-dev.md` 的 `output` 必填、`SKILL.md` §3 红线不搬）确认引用为真后，备份 → 正文存档 → 单事务硬删（连带 `memory_marks`/`memory_evidence`）→ FTS rebuild。

**它证明的一件事**：同一个知识在技能与记忆里各写一份时，维护成本不是两倍——是「哪天对不上，你不知道该信哪份」。删掉记忆那份不是丢信息，是消除第二种真相。

读数：删 `project 1 / fact 5 / lesson 107 / topic 2 / rules 3`，活跃 178 → **60**（rules 4 / project 4 / fact 7 / lesson 45）；topic 清空。备份 `backups/memory-before-dedupe-2026-11-21T09-22-39.db`，被删正文与覆盖位置存档 `backups/deleted-skill-covered-2026-11-21T09-22-39.md`（34 KB）。

### 13.14d 技能补写与最终去重（2026-11-21）

按用户在弹卡里的选择（「先按技能去重，把技能覆盖到的记忆删掉」），去重删完 118 条后又走了一轮：把剩下 **61** 条按层切片（fill-a 31 / fill-b 30）交给两个只读子代理，逐条比对 12 个用户技能与 5 个插件技能的正文，判三种动作：`patch`（技能缺这条信息，给出可插入的片段）、`covered`（技能已完整写明）、`keep`（是本机状态／一次性记录，不该进技能）。

结果：**patch 44 / covered 10 / keep 7**；44 条补丁按锚点插入 **16 个技能文件**（`memory-collab`、`thinking-discipline`、`windows`、`html-card`、`dsh` 及其 references、`bili-transcript`、`doc-parsing`、`skill-authoring`），原文件先备份到 `_fill/bak/`，插入前要求 anchor 在该文件整行命中 1 次（避免同文多处误插），插入后逐条校验首行可在文件里检索到——44/44 通过，失败 0。

随后的删除：候选 54 条（patch 44 + covered 10），其中 **3 条是用户此前标过「有用」的**（画像只放跨场景特质 `01M7YH374`、记忆只写结论与判据 `01M7YHYMQ`、插件说明.txt 规模 `0mtpho3fd`）自动保护、不删；实际删 **51 条** + 证据 102 行，FTS 重建 **955** 条。**活跃 61 → 10 条**（rules 3 / fact 5 / lesson 2）。

留下这 10 条的判断标准：它们是「本机状态」与「一次性记录」，技能里写不进去也不该写——本会话只做规划不执行、麒麟 SoC × MatePad 知识库路径、本机会话识别码、11 个技能里 2 个非自研、批改清理记录、手写 xlsx 方案、HF paper 可能挂同作者前作，以及被保护的那 3 条。

**踩的坑**：子代理给的 anchor 是从记忆正文里抄的，容易在强调符号（`**有用**` vs `**还有**用`）上偏一位；要求它们按行号从目标文件逐字取 `lines[N-1]` 再统计整行命中数，两份回执 44/44 anchor 唯一。另有 n41 与技能原文冲突（`doc-parsing/SKILL.md:66` 写 token 带 `sk-` 前缀，记忆说不带），处理方式是**不删原句、追加判据**（「前缀不是判据，以最小 `/file_parse` 请求或控制台对照为准」），避免用一条记忆覆盖一条更老的实测。

### 13.15 审议页只列活跃条目（2026-11-21）

用户反馈：侧边栏审议页会显示已归档（`status='review'`）的记忆，"让我做了没有用的工作"——他在这些条目上打的标记随归档一起失去意义。

改法（`src/review.mjs`）：
- `listForReview` 的查询加 `WHERE status IN ('memory', 'evolution')`，**归档条目不再出现在审议页**（`memory_read` 仍可按 id 读回）。
- `reviewStats` 只统计仍活跃条目的标记，另返回 `archived` 计数供排查；归档条目上的历史标记保留在 `memory_marks` 里，不删（那是当时的判断记录）。
- `applyMarks` 遇到归档条目直接跳过，不把 `review` 再翻一次、也不给归档条目加 `importance`。
- `client.js` 的 `visibleGroups` 改为只渲染有条目的层（`user` 层归档后不会留一个空壳）。

实测：work 库可见 417 条（rules 24 / project 17 / fact 106 / lesson 248 / topic 22），`user` 层 0 条；标记 48 条里 **25 条指向已归档条目**（user 16 / rules 9），全部隐去。

**卡片上的写入时间（同日补）**：`review.mjs` 的 `listForReview` SELECT 增加 `created_at`，每条返回 `writtenAt`（= created_at 的 `YYYY-MM-DD HH:mm`，缺失时退回 updated_at）与 `updatedText`；`client.js` 在 meta 行显示短格式 `11-21 15:45`（`slice(5)`），鼠标悬停看「写入 … · 更新 …」（两者相同则不重复）。效果：老条目能一眼看出是「9 月写的、今天被我精修过」，不必再猜。

### 13.16 时间信息的三个字段与量级修复（2026-11-21）

**正文不记时间，时间在字段里**：七层表都有 `created_at` / `updated_at` / `last_accessed_at`，写入时自动填，不用手写。实测活跃记忆正文含年份的比例：rules 67%、topic 64%、fact 58%、project 35%、**lesson 1%**——日期只在「日期本身是结论」时才写进正文（如迁移日期、版本发布时间），lesson 类方法条目基本不带。

**检索怎么用时间**：`bm25.mjs` 的 `daysSince(row.last_accessed_at ?? row.updated_at)` → `recency = exp(-days/30)`，权重 0.15；取不到时间按 999 天（recency≈0）处理。

**怎么读出来**：`store.mjs` 的 `fmtStamp(v)` 统一成本机时区的 `2026-11-21 16:39`（`Intl.DateTimeFormat('sv-SE', {timeZone:'Asia/Shanghai'})`，认 ISO 字符串、毫秒数字与微秒）；`memory_read` 额外返回 `created` / `updated` / `lastAccessed` 三个可读字段，证据条带 `at`；`memory_search` 每条命中带 `at`（= updated_at 的可读值）。

**修掉的量级 bug**：414 条 `updated_at` 被写成**微秒**（`Date.now()*1000`，17 位），`daysSince` 把它当毫秒 → 时间落在 5 万年后 → 天数为负被 `Math.max(0, …)` 夹成 0 → **recency 恒为 1**，等于 0.15 的时效权重对所有条目失效。修法两层：数据侧 `n > 1e14 ? n/1000` 批量折回毫秒（414 条）；代码侧 `daysSince` 同样认微秒，防再次写入。

### 13.17 版本流水进插件（2026-11-21）

**用户原话（两次）**：先说「记忆中类似『什么时候什么插件版本升级到什么版本』的流水账单独建一个日志文件存放，不放记忆里面，需要的时候再查」；随后改口「日志功能合并进记忆插件里面，不要独立出去」。最终形态是**表 + 工具 + 斜杠指令**，没有独立文件（`C:\deepseek\work\logs\升级日志.md` 建过一版、已删，避免两套真相）。

**为什么**：流水账是**事件史**，只在回溯时有用；放在记忆库会占检索面、拉低命中精度，还会让「当前状态」与「历史事件」混在一起——升级三次后，记忆里留着三份互相矛盾的版本号。

**表**：`change_log(id, day, subject, from_version, to_version, note, source, created_at)` + `day` 与 `subject` 索引；`src/changelog.mjs` 提供 `ensureLogTable` / `today` / `addLog` / `listLog` / `removeLog` / `logStats` / `formatRow` / `renderLog`。`src/index.mjs` 的 `dbFor` 在开库后调 `ensureLogTable`（老库自动补建，失败不影响记忆本身）。

**三个入口**：
- 工具 `memory_log`（第 **16** 个）：`action: add | list | remove | stats`（默认 list），参数 `day / subject / from / to / note / source / since / until / query / limit / id`。
- 斜杠 `/log [关键词]`：不带参数列最近 20 条，带参数按 `subject / note / 版本号` 模糊查；空库回「还没有版本流水记录（用 memory_log 的 add 记）」。
- 直接写库：`addLog(db, {...})`，`subject` 必填，`day` 缺省今天（非 `YYYY-MM-DD` 也退回今天，不让脏日期进表）。

**记忆只留两类**：**当前基线**（如「内核 0.2.2-rc.5 / 外壳 0.14.0，26 deps / 38 bundles，掉队 0」）与**选型判据**（如 MinerU 钉 3.4.5、billion-context 只认 latest、univer-office 的 peer 线）。判据：这条写的是「某天升到了哪版」还是「以后该怎么做」——前者进流水表，后者进记忆层。

**迁移**：24 条历史流水灌进表（`logStats` → `{entries:24, since:'2026-11-05', until:'2026-11-21'}`，从内核 `0.2.1-rc.x → 0.2.2-rc.1` 到 meow-mind 0.1.0）。同时把 10 条纯流水记忆（`0mwiu678l` / `0mwm2snls` / `0mwoi7fbu` / `0mwehz0pr` / `0mwa75b6g` / `0mwfug4l0` / `0mwn47w5i` / `0mvuk2t3x` / `0mwn41xh3` / `0mwa9qmyq`）原文写进 `memory_evidence`（`source_kind='note'`）后归档成 `review`；备份 `handover/backups/memory-before-verlog-2026-11-21T16-51-12.db`；活跃 414 → **409**。

### 13.18 全局记忆库：两库读写路由（2026-11-21）

**位置与开关**：全局库 `C:\deepseek\.dsh-mind-global\memory.db`（`cfg.globalDir` 默认值即此，环境变量 `MEOW_MIND_GLOBAL_DIR` 可覆盖）。**把 `globalDir` 设成空串就退回单库模式**——这是设计时留的回滚开关，不是配置项彩蛋。

**一条不变式**：全局库里所有条目 `project = '全局'`；工作区库也可以有 `project` 含「全局」的历史条目（多为 review 归档），但新的全局内容一律写全局库。分区判据复用已有的 `project` 列，不新增 `scope` 列——多一列就多一处要在 16 个工具里维护。

**代码面（stage-A，5 个文件）**：
- `db.mjs`：`globalPath(cfg)`（空串返回 null）、`openGlobal(cfg)`（失败返回 null，调用方降级成单库）。
- `config.mjs`：`globalDir` 默认 `C:/deepseek/.dsh-mind-global`。
- `index.mjs`：`globalFor()` 懒加载 + 缓存（`globalTried` / `globalEntry`），开库后 `ensureLogTable`，新建打日志「全局库 …（新建）」，失败 warn 后降级；注入两处调用各多传一个参数。
- `inject.mjs`：首轮块**全局层先占预算**（`soul` 3 条 / `rules` 12 条 / `project` 3 条，标题带「（全局）」），工作区用剩余预算；`semanticScores` 合并两库向量；命中块 `[全局]` 前缀。
- `bm25.mjs`：原 `fusedSearch` 改名 `fusedOne`，新 `fusedSearch` 两库各跑一遍再合并。**注释里写清了为什么不能混池**：BM25 分是按库归一化的，混在一起会让条目多的库系统性压制条目少的库；合并后统一做 `bucketPick` 配额截断。

**代码面（stage-B，`tools.mjs` 34,612 → 39,136 B）**：`gdb()` 与 `locate(id)`（先全局后工作区）两个辅助函数，然后按下表逐工具改。

| 工具 | 路由 |
|---|---|
| `memory_remember` | `project === '全局'` → 全局库，否则工作区；返回带 `scope` |
| `memory_observe` | **永远工作区**（观察是过程记录，不进全局） |
| `memory_search` | 两库合并；`touchAccess` 按 `scope` 回写对应库；命中带 `scope` |
| `memory_read` / `memory_update` / `memory_forget` / `memory_feedback` | `locate(id)` 先全局后工作区 |
| `memory_context` | 传 `globalDb`，全局先出块 |
| `memory_project` | 两库合并，按层累加 count/chars/items |
| `memory_home` | 返回 `{ scope: 'both', workspace, global }` |
| `memory_health` | 两库统计 + 合计 |
| `memory_find_similar` | 两库候选与向量合并，结果带 `scope` |
| `memory_link` | 两端同库才建边，跨库直接报错「关系不能跨库建立」 |
| `memory_dream` | 应用分支对全局库补做瘦身 + 去重合并 + FTS 重建；dry-run 仍只报工作区 |

**为什么不跨库建关系**：`memory_read` 的 relations 与 `memory_dream` 的关系重建都按单库遍历，跨库边会让两边账对不上；关系网是「库内语义」，跨库的语义重叠交给检索合并去做。

**迁移（2026-11-21）**：工作区库里 `status IN ('memory','evolution')` 且 `project` 含「全局」的 6 条（fact 2 / lesson 2 / rules 2）连同证据 10 条、向量 6 条搬进全局库并从工作区删除；工作区库 538 → 532 条，两侧 FTS 重建。备份 `handover/backups/memory-before-global-2026-11-21T09-39-06.db`。工作区库仍有 fact 20 / lesson 51 / topic 5 / rules 10 条 `project` 含「全局」，都是 review/归档状态，按判据留在工作区当历史。

**已知边界**：①`memory_dream` 的冲突清单与休眠候选只按工作区库报（两库各报一套会变成两本账）；②侧边栏审议页仍只读工作区库；③embedding 只用一个实例（98.5 MB 模型加载两次不值得），两库向量各存一份。

### 13.19 待办层（todo，2026-11-21）

**需求原话**：「记忆库里面加一种分类：待办项。事办完就删」。

**做法**：`LEVELS` 加第 8 层 `todo`（`db.mjs:6`），老库打开时由 `initSchema` 的建表循环自动补表（`CREATE TABLE IF NOT EXISTS`），不需要迁移脚本、不需要改任何工具签名——`S_LEVEL` 是 `enum: LEVELS` 生成，加层即自动出现在 `memory_remember` / `memory_read` / `memory_update` 等参数里。

**四个入口**：①写入 `memory_remember { level: 'todo', content: '…' }`；②首轮块注入最多 3 条（`inject.mjs` 的 `take('todo', …, '待办（todo）', 3)`，排在「项目」之后）；③侧边栏审议页第一组（`REVIEW_LEVELS` 顶部加 `['todo', '待办']`）；④检索 `memory_search { level: 'todo' }`。

**删除**：办完直接 `memory_forget`（走 `locate` → `getMemoryAnyLevel` 会遍历 LEVELS，自然包含 todo），删记忆时连带 FTS 与向量；不做归档、不进 `memory_evidence`——待办是状态不是知识。

**为什么不做「自动过期」**：过期时间猜不准（有的当天办完、有的等一周），删错比留脏更麻烦；「办完就删」由人决定，工具只保证删起来是一步。

**边界**：待办只写「要做什么 + 什么时候算完」，不写背景与理由（背景归 fact/project）；同一条别两处存（工作区与全局只挑一处，跨工作区的事才进全局库）。

### 13.20 跨会话信箱（memory_mail，2026-11-21）

**需求**（用户原话，m23924）：「回信是我让你写的插件的新功能，在共享库新建文件夹，把之前的删了」。此前跨会话留言靠 `C:\deepseek\work\_relay\信箱.md` 单文件手工追加，没有工具、没有校验，谁都能写错格式。

**做法**：新增 `src/mailbox.mjs`（纯文件、无表），信件落在 `<globalDir>\mailbox\`：

| 文件 | 内容 |
|---|---|
| `inbox.md` | 未归档的信，一段一封，`## 日期 时间 · 发件码 → 收件方` 开头，前三行是 `- 编号 / - 状态 / - 主题`，空行后是正文 |
| `archive/<YYYY-MM>.md` | 归档后的信（状态改「收档」，追加「- 归档：日期 时间」） |
| `README.md` | 首次投递自动生成的格式说明 |

**三个入口**：
1. 工具 `memory_mail`（第 17 个）：`action: post | list | read | archive | stats`；post 的 `from` 自动取当前会话码，缺省 `to='全体'`、`status='待办'`；
2. 首轮注入：`mailboxStats` 的 `pending > 0` 时出「## 信箱（N 封待办）」，最多列 3 条标题（`[id] 主题（发件码 → 收件方，日期 时间）`），超出的提示用 `memory_mail list` 看，**正文不进上下文**；
3. 斜杠 `/mail`（只读）：不带参数列待办、`all` 列全部未归档、带关键词则模糊查。

**关闭开关**：信箱跟着 `cfg.globalDir` 走——`globalDir` 为空时 `mailboxDir()` 返回 null，工具回「信箱未启用」，注入小节不出现，斜杠提示同样关闭。

**边界**：只追加不删（归档才摘块）；`from` 字段按会话码格式校验失败时不丢信，原样保留；解析器对发件码放宽为「非空片段」，格式不对不该让整封信消失。

**实测**：16 项断言全过（关闭态、投递、README 自动生成、状态过滤、关键词、读全文、归档后待办归零、归档后 inbox 取不到、渲染文本）；四套测试全绿（`discipline` 17 工具、`command` 3 条指令）。

### 13.21 共享库样板（global_doc，2026-11-21）

**需求原话**：「我们今天写的共享库相关内容都是要写进插件的，不是独立功能」→ 盘点后用户选定「样板与索引进插件（A+B+C）」。

**为什么要单开一张表**：样板是「整套读完才有用」的长文（准则完整版、工具链手册），长度以 KB 计；塞进 `rules` / `lesson` 会被检索与注入切成片段，既挤预算又读不全。判据一句话：**要整套读完才有用 → 样板；只取一句就够 → 记忆**。

**表**（建在全局库，老库自动补建）：

```sql
CREATE TABLE IF NOT EXISTS global_doc (
  name TEXT PRIMARY KEY,      -- 小写字母/数字/连字符，2–40 位
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

**工具**：第 18 个 `memory_doc`（`list` / `get` / `put` / `del`，默认 list）。`list` 只回名字、标题、字数、摘要与更新时间；`get` 整篇取回；`put` 覆盖写；全局库关闭时工具直接报「全局库未启用」。

**首轮注入**：在项目与待办之后追加**一行**索引——`共享库样板 N 份：guidelines（…）, research-toolchain（…）。要看全文用 memory_doc get(name)，不要凭印象回答。` 只列名字，正文永远不进首轮块。

**迁移**：`samples\跨工作区准则.md`（11,061 B）→ `guidelines`（5,086 字，去掉与 AGENTS.md 重复的首段）；`samples\科研工具链.md`（2,925 B）→ `research-toolchain`（1,803 字）；`samples\INDEX.md` 的判断标准段试入库后删除（`list` 已承担路由功能）。三份 md 与 `samples\` 目录一并删除；`~/.dsh/AGENTS.md` 的四处指针改成 `memory_doc get(name:"…")` / `memory_doc list`；全局库 rules「三层存放」那条同步改成 `memory_doc`。

**顺带修掉一个真 bug**：`DEFAULT_CONFIG` 是手写对象，不继承 schema 默认值，之前没加 `globalDir` → `globalPath()` 返回 null → `openGlobal()` 恒为 null，**两库路由在「配置没显式给 globalDir」时静默失效**（表现为工具都正常，只是全局库从不参与）。修法两层：`DEFAULT_CONFIG` 补上 `globalDir: 'C:/deepseek/.dsh-mind-global'`；`db.mjs` 里加 `DEFAULT_GLOBAL_DIR` 兜底——`undefined` / null 走默认路径，只有**空字符串**才表示关闭（保留回滚开关的语义）。

**验收**：首轮块组成 `记忆使用说明 → 全局准则（rules）（全局）→ 用户画像 → 共享库样板 2 份…`，实测 **1,870 tokens / 1,988 字符**；四套测试全绿（18 工具 / command 三条指令 / discipline OK / smoke OK）。

### 13.22 工具 render 契约（2026-11-21 踩坑）

**现象**：重启后 `memory_doc list` / `memory_mail list` / `memory_log stats` 全部报 `Error: content.some is not a function`；`memory_profile get` 报 `TOPICS is not defined`。

**根因一**：工具定义的 `output.render` 签名是 **`(args, value)`**，且**必须返回内容块数组** `[{ type: 'text', text: '...' }]`。我后加的四个工具写成了 `render: (r) => typeof r === 'string' ? r : JSON.stringify(r, null, 2)`——参数位错（拿到的是 args）且返回字符串，宿主对结果调用 `.some()` 即抛错。正确写法见 `tools.mjs` 顶部：

```js
const OUTPUT = { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 1) }] };
```

参照 `C:\deepseek\tools\dsh-doc-parser\lib\main.js`：`render: (_args, value) => text(value)`，`text()` 返回的也是数组形态。**判据：render 只要返回字符串，工具调用必炸**；契约自检可以 grep `render: (.*) =>` 并确认右侧以 `[{` 开头。

**根因二**：`tools.mjs` 的 `import { findConflicts, pendingMemories, getProfile } from './profile.mjs'` 漏了 `TOPICS`，而 `memory_profile` 的 get 分支返回 `topics: TOPICS`——`profile.mjs:9` 确实导出了它。补进 import 即好。

**教训**：加新工具时别手写 `render`，直接复用顶部的 `OUTPUT` 常量；工具文件改完先 `node --check`，再跑四套测试，最后**实调一次**（测试覆盖不到 render 的运行时契约）。

**补记（2026-11-21 晚，信箱来信指出）**：除了 `render`，直接写 `ctx.tools.register({...})` 还会漏掉 `add()` 补的三个默认字段——`timeoutMs`（15000）、`isConcurrencySafe`（`() => true`）、`presentCall`（通用卡片）。缺 `presentCall` 时内核做卡片装配同样会抛 `content.some is not a function`，所以**新工具一律 `add({...})`**，不要手写 register。当日已把 `memory_profile` / `memory_log` / `memory_mail` / `memory_doc` 四处改成 `add()`，改完 `ctx.tools.register(` 在文件里只剩 `add()` 内部那一处（静态自检阈值：`register` 计数 = 1、`add({` 计数 = 18）。

### 13.23 注入里的常驻语言提醒（2026-11-21）

**背景**：用户发现我的思考块一直用英文写，而「推理与思考过程用中文」这条早在全局库 rules 里。原因是它埋在几十条准则里，容易被挤掉或干脆没被当真。

**做法**：`src/inject.mjs` 顶部加
```js
const LANG_RULE = '思考过程（reasoning）与回复一律用中文书写；代码、命令、路径、专有名词、引用原文照原样，不硬译。';
const GUIDE = [LANG_RULE, '本块是跨会话记忆，不是用户本轮的原话。', …];
```
它出现在首轮块 `## 记忆使用说明` 的**第一行**，不占规则层配额、不会被预算挤掉；实测两库齐全时首轮块 42 行 / **2,020 tokens**（此前 1,870，多出来的就是这一句与它带来的重排）。

**边界**：注入只能提醒，管不住模型的输出——真正的约束仍要靠 rules 层那条准则与自觉；这句话的作用是把「该用中文」放在每一轮最显眼的位置。

### 13.24 画像归全局库 + dream 提示改实话（2026-11-21）

**由来**：study 工作区的会话往信箱写信，指出画像层四处对不上（四个工具绕过 `add()`、工具描述里的分节与实际 `TOPICS` 不一致、画像表为空导致注入退回散条、`/dream run` 承诺了并不存在的归纳步骤）。前两条当晚已修（见 §13.22 补记与工具描述），后两条是设计选择，用户裁决：**提示改实话**、**画像迁进全局库**。

**为什么画像归全局库**：画像描述的是「这个人」，换个工作区打开依然成立——这与两库判据（§13.18「换个工作区打开，这条还对吗」）一致。之前放在工作区库，导致 study 库空壳、work 库有 17 条分节，同一件事要维护两份。

**四处改动**：

1. `src/inject.mjs` 画像段：全局库优先、工作区兜底——

```js
const opts = { take: cfg.injection.profileTake ?? 2, maxChars: cfg.injection.profileChars ?? 1050 };
let brief = '';
if (globalDb) { try { brief = buildBriefNarrative(globalDb, opts); } catch { brief = ''; } }
if (!brief.trim()) brief = buildBriefNarrative(db, opts);
```

2. `src/tools.mjs` 的 `memory_profile`：`const db = deps.globalFor?.() ?? dbFor();`——写节、改节、删节、刷叙事、查 pending 全部落在全局库。
3. 同一文件的 `memory_dream` 画像统计（`findConflicts` / `pendingMemories` / `getProfile`）同步改读 `deps.globalFor?.() ?? db`，否则整理报告会对着空的本地表说话。
4. `src/index.mjs` 的 `/dream`：`const pdb = globalFor() ?? db;` 之后三处都读 `pdb`；未归纳 > 0 时补一行「→ 归纳得在会话里做：memory_profile 的 pending 列清单，逐节 upsert；插件自身调不到模型，不会自动归纳」；catch 分支原文「跑一次 /dream run 会用现有 user 记忆归纳」改为实话。

**数据迁移**：`user_profile` 1 行 / `user_profile_section` 17 条 / `user_profile_cursor` 1 行从工作区库复制进 `C:\deepseek\.dsh-mind-global\memory.db`（`INSERT OR REPLACE`，先 `ensureProfileTables(g)`），校验全局库分节数与原库一致后清空工作区那份——**单一真相**，不要两套。备份 `handover/backups/memory-before-profile-global-2026-11-21T10-58-09.db`。

**验证**：全局库画像 `v9 / 17 条分节 / narrative 1,379 字`，brief 861 字；工作区 brief 0 字；真库 `buildFirstTurnBlock` → **2,116 tokens / 2,361 字符**，含「## 用户画像」段；四套测试 exit=0。

**边界**：两边都有画像时读全局库（唯一真相）；全局库关掉（`globalDir` 空）或画像为空时自动退回工作区库，不会把画像读丢。

### 13.25 project 列可写 + 归一 + 分节描述对齐（2026-11-21）

**由来**：study 会话写来两封信——它的工作区库里有 12 条 lesson 的 `project` 写成「全球」（11）或「global」（1），另有 8 条 rules 标着「全局」却躺在工作区库，而这些条目本该进全局库；`memory_update` 没有 `project` 参数，这一列在工具层不可写，只能读不能改。

**改动（三处）**：

1. `src/store.mjs` 的 `updateMemory` 字段映射加 `project: 'project'`，diff 键列表同步加 `project`——版本快照会记 `fields:["project"]`，FTS 由既有的 `syncFts(db, table, after)` 重建（实测：写入「全球」→ update 成「全局」→ 库里是「全局」，快照 v2 `{"kind":"update","fields":["project"]}`，FTS 行数 1）。
2. `src/tools.mjs` 新增 `const normProject = (v) => /^(全局|全球|global)$/i.test(String(v ?? '').trim()) ? '全局' : String(v ?? '').trim();`
   - `memory_remember`：先归一再判路由，落库用归一后的值（此前「全球」不会被识别成全局库路由）；
   - `memory_update`：参数加 `project`，进 patch 前归一——错标可以就地改正，不必删了重写。
3. `memory_profile` 的 `topic` 描述去掉 `boundary`，与 `profile.mjs` 的 `TOPICS`（7 项：identity / workflow / delivery / tradeoff / communication / info / goal）对齐。这条是信箱来信指出的：描述写 8 个而实现 7 个，照着描述写会被 `upsertSection` 以「未知分节」拒掉。`boundary` 这个维度用户已在 2026-11-21 明确删除（场景规则归技能），所以正确修法是删描述而非加回分节。

**同时修正**：`SPEC.md` 第 4 节标题「工具契约（15 个）」→「18 个」（README 昨晚重排时已改，SPEC 漏了）。

**边界**：`update` 只改字段，**不搬迁**——把一条记忆从工作区库挪到全局库仍需单独迁移脚本（复制全列 + 证据 + 向量 + FTS，再从原库删）。`normProject` 只认三种写法，其余原样保留（不猜）。

### 13.26 信箱归档的两种定位（2026-11-21 晚）

**起因**：inbox 里出现几封「手工写信」——信坏了的时候对方用 Python 直接写文件投递，编号栏填的是「（手工写信，…）」这种占位串。`archiveLetter` 原来只按 `id` 找信，这几封点不动，只能永远留在 inbox 里挡列表。

**改法**（`src/mailbox.mjs`）：
- `archiveLetter(cfg, ref)` 的 `ref` 可以是字符串（按 id）或对象 `{ id, time, subject, from }`；按 id 找不到时退化为「时间精确 + 主题包含」定位。
- 多匹配**直接拒绝**并报条数（`匹配到 N 封，请再加 time 或更长一点的 subject`），不猜。
- 摘除按**对象身份**而非 id——占位编号会撞（实测两封手工信共用同一个占位串），按 id 过滤会把同编号的其它封一起删掉。
- `memory_mail { action:'archive' }` 新增可选 `time` 参数，与 `subject` 搭配即可归档手工信。

**验证**：临时信箱 11 项断言全过（投递 2 封 + 手工 2 封 → 多匹配拒绝且一封不少 → 按 id 归档 → 按 time+subject 只摘一封、同编号的另一封仍在 → 不匹配报错 → 归档文件含正文与「状态：收档」）。

### 13.27 注入块质量三修（2026-11-21）

**由来**：用户问「全局记忆的注入有问题吗」。实跑 `buildFirstTurnBlock` 渲染真库首轮块（2,326 tokens / 49 行），逐行看才发现三处影响可读性的问题——这类问题不会报错，只会让模型照着残句理解。

**① 两段同名 `## 全局准则（rules）`**：全局库段带「（全局）」，工作区段不带标签，两段标题一模一样。改法：工作区调用补 tag —— `take('rules', ['memory', 'evolution'], '全局准则（rules）', 25, db, '（本工作区）')`。

**② URL 被整段吃掉，句子缺宾语**：`stripNoise` 原本是 `const URL = /https?:\/\/\S+/g` 加 `s.replace(URL, '')`。`\S+` 把中文标点也算非空白，于是「http://127.0.0.1:23119/api/，读免认证、写要授权…」整段被删，剩下两个「在」拼成 **「Zotero 10 在 在 C:\deepseek\…」**。改法：匹配到中文标点为止，且只保留主机名：

```js
const URL = /https?:\/\/[^\s，。；、！？（）【】「」《》"'<>]+/g;
s = s.replace(URL, (u) => { const m = /^https?:\/\/([^/?#]+)/.exec(u); return m ? m[1] : ''; });
```

实测：`https://github.com/ranxianglei/billion-context` → `github.com`；Zotero 那条变成「Zotero 10 在 127.0.0.1:23119，读免认证、写要授权、绝不可转发或对外暴露；」。

**③ 信箱段被自己发的广播占满**：`listLetters({ status: '待办', limit: 3 })` 不分收发，我发给「全体」的广播也排进首轮块；手工信的编号是 `（手工写信，…）` 占位串，当 id 显示很难读。改法：`buildFirstTurnBlock(db, cfg, globalDb, selfCode)` 加第四参，过滤 `l.from === selfCode`；不像 id 的编号显示成 `[手工信]`；待办总数按过滤后算；`index.mjs` 传 `sessionCode(sid)`。

**结果**：47 行 / 2,258 tokens / 2,448 字符（原 49 行 / 2,326）；信箱段从 4 封降到 2 封（都是 study 会话写来的），自己那两封不再出现。

**判据**：注入块是给模型读的——句子在哪儿断，它就照着断句理解；「在 在」这种残句会让它把两条记忆当成一条。摘要函数改动后必须把真实注入块打出来看一遍，不能只看 token 数与工具是否报错。

### 13.28 审议栏的时间窗筛选（2026-11-21）

用户：「记忆审议栏里面加一个近7天内容筛选」。

**为什么不能在 SQL 里比时间**：`created_at` / `updated_at` 这一列在库里混着三种格式——新写入的 ISO 字符串、旧库迁移来的毫秒数字（`1795248834467.0`）、个别微秒（17 位）。直接 `WHERE updated_at >= ?` 会让数字与字符串按 SQLite 的类型序比较，结果不可信。

**改法**（三处；`index.mjs` 不用动——它本来就是 `listForReview(db, payload)` 原样透传）：

1. `src/review.mjs`：`listForReview` 多收 `opts.days`（0 = 不限），算 `cutoff = Date.now() - days * 86400000`；逐条 `const stamp = parseStamp(row.updated_at) || parseStamp(row.created_at); if (!stamp || stamp < cutoff) continue;`。`parseStamp` 从 `store.mjs` 导入（它已经把三种格式折成毫秒）。返回值多带一个 `days` 方便前端对账。
2. `client.js`：层下拉之后加时间窗下拉（全部时间 / 近 7 天 / 近 30 天），`load` 里带 `days: Number(days) || 0`，`useCallback` 依赖数组补 `days`。
3. 空态文案按时间窗分流：`这个时间窗里没有条目，换成「全部时间」看看`。

**验证**：临时库造三条（今天 / 三天前 / 十天前，其中「今天」那条故意写成毫秒时间戳）→ 全部 3 条 / 近 7 天 2 条 / 近 30 天 3 条；十天前那条被筛掉，毫秒格式能正确折回。真库此刻 16 条活跃全部落在 7 天内（今天都被改过），所以「近 7 天」现在看起来等于「全部」——这是真实情况，不是筛选失效。

**边界**：时间窗按 `updated_at` 优先、`created_at` 兜底；「今天改过的旧条目」会留在窗内，这是有意的——审议关心的是「最近动过的」。改的是 host 半与 client 半，**要重启宿主才能看到下拉**。

### 13.29 三份审计与修复（2026-11-22）

派三个只读子代理审计 9 个自建技能与 2 个自建插件（meow-mind、dsh-doc-parser），报告在 `C:\deepseek\work\_audit\{meow-bugs,skills-bugs,docparser-bugs}.md`。用户裁决「全修」——静默失败/数据丢失（A）、契约与指向错（B）、过时数字（C）一次清完。

**meow-mind 三高危（都已修，行为测试 13 项全过）**：

1. `src/index.mjs` 的 import 漏 `slimMemory`（`store.mjs:391` 有导出）→ `/dream run` 的瘦身段每次 `ReferenceError`，被 `catch { /* 瘦身失败不影响其余步骤 */ }` 吞掉，**永远瘦身 0 条且无日志**。
2. `upsertSection` 只认 `replace`，`abort` 落到「内容不同则追加」分支 → **传 abort 反而写入**。现在 `abort` 直接返回不写库，`update` 兼容为 `replace` 别名；`tools.mjs` 的 schema 与 description 三处对齐成 `append|replace|abort`。
3. `mailbox.mjs` 的 `parseInbox` 丢掉首行不匹配的段，而 `archiveLetter` 用筛过的列表**重写整个 inbox** → 那几封永久消失（同文件注释自己写着「格式不对不该让整封信消失」）。现在坏段存进 `out.skipped`，归档时原样写回。

**dsh-doc-parser 六高危**：`lib/formulas/mathtype.js` 缺 `import fs` 却八处在用（四个 `doc_formulas` action 全崩，错误还被伪装成「LibreOffice not found」）；`lib/main.js:322` 与 `lib/mineru-online.js:286` 的 `slice(0, 4000)` 把长表从标签中间截断、行列静默丢失；文本层页写死 `confidence: 100` → 页头假报 `(ocr 100%)`；`doc_tables` 的 `timeoutMs: 120000` 与 24 页 cap 不匹配（冷启动 40 s + 每页 1.2–7 s）；`MINERU_MODE` 两条静默路径（显式 online 无 token 静默本地、未设 mode 有 token 静默上传）现在都打显式提示。详见其 `README.md`。

**技能侧**：`dsh/scripts/selfcheck.mjs` 两副本 md5 同步（工具副本从 `store.mjs` 误 import `findPluginGaps`，它其实在 `plugins.mjs`）；`dsh/references/selfcheck.md` 的 MinerU 端口 8000/8001/7860 → 18000；`doc-parsing/references/office.md` 附录「本技能没有附带脚本」与同目录 SKILL.md 矛盾；`memory-collab/references/memory.md` 四处指向已删的 `C:\deepseek\共享\agent-准则.md`（改成全局库样板 `guidelines` 与全局 `rules`）；`dsh` 选篇表四篇体积与节数按实测刷新；技能数 12 → 13、行数统计改为「最短 51 / 最长 256 / 中位 105 / 平均 131」并补 2026-11-22 现况。

**判据**：审计报告只当线索，每条都要回源码或实测确认——子代理报的「未使用导入」是陈旧副本造成的误报，它自查后撤回了。四套测试与技能静态复查都在修完之后跑，不拿审计报告当验收。

**补记（2026-11-22 00:20，重启后验真）**：`memory_profile` 的四个写操作在临时库上跑 11 项断言全过（首次写入 / `merge=abort` 连首次写入一起挡 / `replace` 覆盖且 confidence 归 1 / 旧名 `update` 仍覆盖 / 相同内容 `confirm` 且 +1 / 不同内容 `merge` 用「；」拼接 / `refreshNarrative` 版本 +1 / `setCursor` / `findConflicts` 的 `suspected === total` / `deleteSection` 返回 `removed=1`）。验真顺带发现上一轮的 abort 修法有边界漏洞——判断原本在「有无旧条目」之后，**首次写入时 `merge=abort` 仍会 INSERT 一条**，现已上移到取旧值之前并加注释。这条要下次重启才生效（运行中的宿主仍持旧模块），其余三个高危重启后已验真（`memory_profile get` 返回带新 `suspected`/`note` 即证明新代码在跑）。另外 `memory_mail` 的参数名是 `action` 不是 `operation`，传错时工具退回默认的 `list` 且不报错——归档看似成功实则什么都没做，是个容易背后果的静默回退。

### 13.30 soul 按会话隔离（2026-11-23）

> **已被同日的人格改造取代**：工作区库的 soul 段不再注入，本会话人格改由 `personas` / `persona_traits` 提供，首轮块段标题从「自我设定（soul·仅本会话）」变成「人格（本会话）」；本节描述的行为现在只在全局库那条 soul 上成立。新的模型见 §13.31。

**动机**：用户一个会话一个用途，而 `soul` 层原本固定从工作区库取、不带会话条件——同一工作区的所有会话看到同一份，等于所有用途共用一个人格。用户此前已出现过「认领错识别码」的混淆。

**五处改动**：

1. `src/inject.mjs`：`buildFirstTurnBlock(db, cfg, globalDb = null, selfCode = '', selfSession = '')` 加第 5 参；
2. 同文件 `take(...)` 加第 7 参 `sessionOnly = false`，为真时过滤 `!m.source_session || m.source_session === selfSession`；
3. 工作区 soul 段改为 `take('soul', [...], '自我设定（soul·仅本会话）', 5, db, '', true)`；**全局库那条（`（全局）`）不动**，它仍是跨工作区的底色；
4. `src/index.mjs` 调用处多传 `sid`（当前会话 id）；
5. `src/tools.mjs` 的 `level` 描述补「soul 是本会话私有（只注入本会话，别的会话看不到）」。

**为什么 `source_session` 为空的老条目要保留**：升级前写的 soul 没有来源字段，一刀切会让历史条目在一次重启后全部消失，而用户无从知道为什么。

**验收**：临时库 9 项断言全过（A 看得到自己的、看不到 B 的；B 同理；无来源老条目两边都可见；`selfSession=''` 时带来源的都不注入；段标题含「仅本会话」；`rules` 仍跨会话共享；块非空）。四套测试 exit=0，首轮块 2,327 tokens。

**边界（本轮没做）**：只隔离**注入侧**，没有隔离**检索侧**——`memory_search` 仍可能召回别的会话写的 soul。要彻底隔离得给检索加同款过滤；当前判据是「注入侧串了会立刻被读进上下文，检索侧要主动搜才出现，风险低一档」。

**判据**：一条记忆要不要按会话隔离，看它「是不是只对这个用途成立」——是，写 soul（自动隔离）；对所有用途都成立，写 rules / lesson（跨会话共享，别塞 soul）。

### 13.31 记忆库重构：时间线三层 + principle + 人格（2026-11-23）

**动机**：用户要的是「带场景的回忆」而不是「一条条结论」——人格是长期共事长出来的，规则只能表达「总是」，案例才能表达「那次是、另一次不是」。旧结构把工具坑、方法准则、人格默契混在同一池里检索，导致串味与「失忆」（检索被稀释）。

**五个变化**：
1. **时间线五表**：`episodes` / `phases` / `decisions` / `personas` / `persona_traits`，`SCHEMA_VERSION` 1 → 4。原本想叫 `events`，发现已被运行时事件日志占用（`db.mjs:31`），改名 `episodes`。
2. **第九层 `principle`**（经验准则），与 `lesson`（工具坑）分开。全局 lesson 42 条按「换一个工具还成不成立」判开：24 条工具坑 + 18 条准则（`_mig1.mjs` 事务搬迁，FTS 的 `level` 一并改写）。
3. **注入改版**：`## 自我设定（soul·仅本会话）` → `## 人格（本会话）`（读 `persona_traits`）+ 新增 `## 当前处境`（活跃 episode + 其最新未归档 phase，没有则整段不出现）；全局库那条 soul 段保留，它是跨工作区底色。
4. **检索**：`memory_search` 加 `event` / `tags` 两参数；`levelOf` / `loadRow` 改认 `KINDS`，并用 `TABLE_OF` 做 kind → 表名映射；新三层按 persona **fail closed** 隔离；`tags` 过滤对 decision 继承其所属 phase 的 `env`。
5. **画像 26 → 11 节**（只留客观事实），18 条默契迁到 `persona_traits`。

**三个真 bug**（都是「不报错但结果不对」）：
- kind 与表名不同名（`phase` vs `phases`）→ `loadRow` 的表不存在，异常被 catch 成 null，时间线永远搜不到。加 `TABLE_OF` 修掉。
- 往 `memory_fts` 手插数据必须先 `tokenize(...).join(' ')`（中文切二元组），直接插原文会变成一个超长 token，搜什么都命中不了。
- persona 为空时写成「全放开」等于没隔离。改成 fail closed：没有 persona 只看无主内容。

**终态**：首轮块 1,740 tokens / 1,864 字符（改前 2,420）；九层 + 时间线五表；检索四例抽查全命中。

**边界（本轮没做）**：三个写入工具（`memory_episode` / `memory_phase` / `memory_decision`）未做，时间线仍是 0 条；`evolution` 未退役（两库 0 条）。

### 13.32 时间线写入工具（2026-11-23）

**背景**：§13.31 建了时间线五表，但没有写入入口——建一个事件只能直接写 SQL。本轮补三个工具，工具面 18 → 21。

**三个工具**

- `memory_episode`：`op: create | close | phase_start | phase_complete`。`create` 建事件并自动挂当前会话的 persona；`phase_start` 的 `seq` 自增，**同时把该事件上一个未归档阶段归档**；`phase_complete` 补全内容与 `env` 并重建 FTS；`close` 把事件标 `done` 并归档其全部未归档阶段。
- `memory_decision`：记一次选择。`chosen` / `rejected` 各一句；不给 `phase_id` 时自动挂该事件最新未归档阶段；给 `supersedes` 时把旧决定的 `superseded_by` 指向新 id 并把旧条 `status` 改成 `review`。
- `memory_persona`：`op: create | inherit | trait`。`inherit` 把新会话 id 追加进已有 persona 的 `session_ids`（去重），人格因此跨会话延续。

**两条自动行为值得单说**

1. **开新阶段自动归档旧阶段**——「一个时间只处在一个阶段」是这个概念的语义要求，交给人工操作会被忘记；实测第六项断言（开第二个阶段时第一个自动 `archived_at`）就是在验这条。
2. **`supersedes` 时旧决定退 `review`**——沿用「`review` 退出检索但可按 id 回读」的既有语义，不引入新状态；新决定里记 `chosen` / `rejected`，旧的 `superseded_by` 指回新 id，于是「为什么变了」整条链都取得到。

**测试**：`_t7.mjs` 18 项断言全过（建人格 → 挂会话 → 反查 → 两阶段自动归档 → 决定挂最新阶段 → 推翻成链 → 检索命中 `episode` 层 → 关事件 → 当前处境为空 → FTS 四 kind 分布 `{decision:2, episode:1, persona:1, phase:2}`）；四套测试 exit=0；`test/discipline.mjs` 的工具数断言从 `tools.length === 18` 改成 `>= 18`（硬编码会让每次加工具都挂掉，这是本轮踩到的）。

**补记（2026-11-23 15:40，重启后首验踩到）**：`memory_decision` 第一次真调就报 `tool "memory_decision" returned invalid output: value is not lossless JSON`——原因是它的 return 里写了 `hint: episodeId ? undefined : '…'`，**有活跃事件时 hint 就是 undefined**（最常用场景必挂）。宿主的返回值序列化是 lossless JSON，不允许 `undefined` 出现在对象里。改成条件展开 `...(episodeId ? {} : { hint: '…' })` 后正常（临时库实测：有事件时 8 个键、无事件时 9 个键，两者都可序列化）。**判据：工具 return 里不要出现 `undefined`，可选字段用条件展开或 `null`。**

**边界（仍未做）**：①体检、合并、关系网只覆盖八层，不认时间线四表；②时间线不参与 `memory_profile`；③`evolution` 退役仍未做（两库 0 条，删不删都行）。

### 13.33 三份只读审计与 P0/P1/P2 修复（2026-11-23 晚）

**为什么做**：时间线三工具上线后，用户问「有没有之前残留的代码会影响使用、或新写了但不会被调用」。派了三个只读子代理分别审死代码、不可达功能、层数一致性，产出三份报告（`_audit/meow-residue.md` 30 条、`_audit/meow-unreachable.md` 六类、`_audit/meow-consistency.md` 32 条实质缺陷）。用户裁决「全修」。

**P0：时间线只有一半（能写不能读改）**
- `store.mjs` 的 `getMemoryAnyLevel` 只遍历 `LEVELS` → 改遍历 `KINDS` 并用 `tableOf()` 取表；`tools.mjs` 的 `locate` 随之生效。
- 读侧枚举加 `S_KIND = { enum: KINDS }`（`memory_read` / `memory_update` 用），写侧 `memory_remember` 仍只认 `LEVELS`。
- `memory_forget` 硬删/软删两处直接拼 `${found.level}` → `tableOf()`。**这处必须先改**，否则放开读侧后立刻 `no such table: episode`。
- 同类拼表名共七处一并修：`store.mjs` 的 `mergeMemory`、`review.mjs` 五处、`profile.mjs` 的 `pendingMemories`。
- `personas` 表**没有 `status` 列**，而 `bm25.mjs` 两处状态过滤对全部 kind 生效 → 人格写进 FTS 后 100% 被丢。改成 `row.status !== undefined` 前置判断。

**P1：会让人做错事**
- `memory_persona` 的 create 忽略 `session_id`（硬编码当前会话）→ 改读 `args.session_id ?? sid`；新增 `op: 'list'`（此前拿不到 persona id，`inherit` 与 `trait` 无从调用）。
- `phase_start` 不校验事件存在、`trait` 不校验人格存在、`supersedes` 指向坏 id 静默跳过 → 三处都改成明确报错（错误分支此前不可达）。
- `memory_decision` 的 `content` 必填却允许空串 → 加非空校验。
- 三个 `execute` 缺 `args = {}` 默认 → 补上。
- `inject.mjs` 的自动命中块调 `fusedSearch` 不传 `personaId`，与工具侧不一致 → 补传（此前手搜能到、自动注入看不到自己的时间线）。
- `memory_context` 与 `memory_health` 调 `buildFirstTurnBlock` 不传 `selfSession` → 补传。
- 层清单三份不同步：`client.js` 七层（缺 principle 与 soul）→ 补到十层；`REVIEW_LEVELS` 补 soul。

**P2：清理与接线**
- 死导出：删 `allIds` / `resetCodeCache` / `__test__`；`STATUSES` 从 `db.mjs` 单一来源（`tools.mjs` 不再手写一份）。
- 原本「写了没人调」的三个诊断函数**接上**：`listEvidence`（`memory_read` 复用，替代内联 SQL）、`evidenceCount`（`bm25.mjs` 复用）、`preflight` + `countVectors`（进 `memory_health`，输出新增 `integrity` / `schemaVersion` / `vectors`）。
- JSDoc 错位两处归位（`bm25.mjs` 的「L0 摘要」回到 `summarize`、`store.mjs` 的「内容重复对」回到 `findDuplicates`）。
- **`principle` 终于进上下文**：`inject.mjs` 新增从全局库取 8 条（此前 18 条经验准则一条也进不了首轮块）；`bm25.mjs` 的意图配额里 `howto` 加 2、`general` 加 1。

**验收**：首轮块从 1,553 tokens / 1,806 字符 → **2,565 tokens / 2,636 字符**（新增「经验准则（全局）」段，仍在 3,200 预算内）；真库回归 `getMemoryAnyLevel` 能读 persona、`listPersonas` 返回 1 个、`preflight` 报 `integrity=true schemaVersion=4`；四套测试每批落地后都 exit=0。

**仍未做（留着，不影响使用）**：① `evolution` 状态退役（两库 0 条）；② 关系网重建与 `find_similar` 仍只扫九层；③ `/dream` 的瘦身、去重、合并不处理时间线（**有意**：事件 1500 字、阶段 800 字，按 200 字瘦身会毁内容）；④ `touchAccess` 对 persona 直接 return（personas 无 hit_count 列）；⑤ 时间线不产向量，只有词法通道；⑥ 剩余重复定义（`cosine` 两份且语义不同、时间戳归一两份、`GUIDE` 两份等）未合并。

### 13.34 工具问题反馈：自动捕获 + tool_issues 表（2026-11-23）

**动机**：别的会话用 meow-mind 出错时，错误只留在它自己的对话框里——用户转述会丢掉最值钱的部分（错误原文、哪个工具、当时传了什么）。需要一条不依赖会话自觉的留档通道。

**三个决定**

1. **插件自己捕获，不靠会话主动写**。出错那一刻会话往往在忙着修，指望它想起来 post 一封信不现实。做法是在 `add()` 里包一层 `execute`：捕获异常 → 记一条 → **原样 rethrow**。绝不吞错，否则用户以为成功了。
2. **存新表 `tool_issues`，不存信箱**。信箱是给人读的 markdown，不能标「已修」、不能按工具统计；这张表有 `status`（open / fixed / ignored）与 `count`，能排序、能统计。
3. **三条硬约束**：①不记参数值，只记参数名列表（`memory_remember` 的 content 是用户原话）；②同签名 24 小时内只累加 `count` 不插新行（签名 = 工具名 + 错误首行前 80 字），否则一个坏循环能灌满表；③记录本身失败完全静默——磁盘满、权限不对都只是少一条记录，绝不能让它把原本的错误替换掉。

**表**（`SCHEMA_VERSION` 4 → 5）：`id / tool / signature / error（截断 500 字）/ param_names（JSON 数组）/ session_code / source_session / count / status / created_at / updated_at`，两个索引 `(signature, updated_at)` 与 `(status, updated_at)`。

**查看入口**：第 22 个工具 `memory_issue`，`action: list | mark | stats`。`list` 默认只看 `open`，返回里带 `stats`；`mark` 改状态；`stats` 只回计数。

**测试**（`_ti.mjs` 临时库，14 项全过）：首次插入 count=1；`param_names` 只存名字不存值；同签名第二次累加到 2 且 id 不变；不同工具/不同错误各插新行；`list` 与 `stats` 数字对得上（open=3 / tools=2 / hits=4）；`mark fixed` 后 open 减一；非法 status 被拒；`error` 为 null 不崩；`db` 为空返回 null。

**边界**：只有**抛异常**才记——工具按约定返回 `{ ok: false, error }` 的软失败不算（那是正常业务分支，不是缺陷）；MCP 外部工具的错误也不经这条路径。

### 13.35 收尾三件：evolution 退役、关系网扩时间线、审计报告归档（2026-11-23）

**1. `evolution` 状态退役（22 处，残留 0）**：`db.mjs` 的 `STATUSES`、`bm25.mjs` 的 `STATUS_WEIGHT`（删掉 `evolution: 0.9`）、9 处 `take` 的状态数组、5 处 SQL `status IN ('memory','evolution')`、3 处状态过滤条件。两库实测 0 条，退役后没有任何条目变成不可见。**判据**：状态枚举里只留真正会有数据的状态——`soul` 与 `evolution` 是同一类反例（规则立了，但没有任何机制会产生它）。

**2. 关系网与相似度扩到时间线**：`db.mjs` 新增 `LINKABLE_KINDS = [...LEVELS, 'episode', 'phase', 'decision']`（**不含 `personas`**——它只有 name/description，没有 content 与 keywords，也不该跟记忆建同主题边）。`store.mjs` 的 `linkRelated` / `rebuildRelations` 与 `tools.mjs` 的 `memory_find_similar` 三处改成遍历它。

**踩到的坑**：时间线三张表**没有 `project` 列**（只有九层有），第一版直接 `SELECT id, keywords, project` 报 `no such column: project`。改成 `LEVELS.includes(lv) ? 'project' : 'NULL AS project'`。教训：时间线与九层只是「都写进同一个 FTS」，**列不是一套**——跨表操作时「我以为同构」最容易漏。

**验收**：临时库 8 项断言全过（关键词完全相同的一个 fact + 一个 episode + 一个 phase：`linkRelated` 从 fact 出发建 2 条边、两个时间线 id 都在；`rebuildRelations` 重建 3 对；`findDuplicates` 处理时间线 id 不抛错；`LINKABLE_KINDS` 不含 persona）。四套测试 exit=0；8 个改动文件同步 profile（md5 全 same）。

**3. 审计报告归档**：`work\_audit` 13 份 → `work\handover\audit` 6 份（本轮三份审计 + 三路验收，共 65.2 KB）；11-21/22 的 7 份删除——它们对应的修复早已落进 SPEC 与九个技能，报告本身只是过程；空目录 `_audit` 一并删掉。

### 13.36 信箱分级：全局与工作区（2026-11-23）

**动机**：原来只有一份全局信箱（`<globalDir>\mailbox`）。改技能、插件、准则这类事该让所有会话知道，但「这个工作区自己的操作记录」也发全体，就是在污染别人的收件箱。

**改法**：`mailbox.mjs` 的五个函数（`postLetter` / `listLetters` / `readLetter` / `archiveLetter` / `mailboxStats`）都加 `opts`（`scope` / `cwd`）：
- `scope='global'`（默认）→ `<globalDir>\mailbox`，行为与以前完全一致
- `scope='local'` → `<cwd>\.dsh-mind\mailbox`，只属于当前工作区

`tools.mjs` 的 `memory_mail` 加 `scope` 参数并把 `cwdOf()` 传下去；`index.mjs` 的 `registerTools` 依赖补 `cwd: () => lastCwd`（那里本来就有 `lastCwd`）。

**两个细节**：①缺 `cwd` 时的报错要区分——`scope=local` 报「工作区信箱不可用（拿不到当前会话的工作目录）」，不是「globalDir 为空」，否则会让人去查错方向；②不传 `scope` 一律走全局，旧调用一个字都不用改。

**验收**：临时库 10 项断言全过（两信箱互不干扰、`stats` 的 `scope` 正确、缺 cwd 报对话术、两个工作区各有自己的信箱）；四套测试 exit=0。

**同轮改的 rules（数据不是代码）**：删三条（本机科研工具链 → `AGENTS.md` §六 已覆盖；上下文归档 → §四 已覆盖；萌系字体 → `html-card/SKILL.md:146` 才是执行约束处），改两条（「记忆只写结论与判据」补结论型/经历型/人格型三种写法；「信箱的使用规矩」改成按影响范围选 `scope`）。全局 rules 活跃 16 → 13 条。

### 13.37 码表热重读：会话中途登记的新码立刻生效（2026-11-23）

**症状**：新会话接手时按规矩先算码、再登记进 `~/.dsh/CODES.md`，但之后 `memory_remember` / `memory_mail` 自动补的仍是 `MT-<hash>` 前缀。码表里写着 `LD-3F004438-01D5`，工具给的是 `MT-3F004438-01D5`——哈希一致、前缀不同。

**根因**：`code.mjs` 的 `loadCodes()` 用模块级 `_map` 加 `if (_map !== null) return _map;` 做永久缓存。而 `index.mjs:535` 的 `buildFirstTurnBlock(...)` 在会话首轮注入时就调了 `sessionCode(sid)`，必然早于用户在会话里登记新码。于是本进程整个生命周期都停留在「码表里没有这个会话」的旧视图，直到重启插件。这与「新会话先算码再登记」的固定动作天然冲突，每个登记的会话都会踩。

**改法**：加 `codesStamp()` 返回 `mtimeMs:size`（文件不存在返回 `'missing'`），`loadCodes()` 改为 `_map !== null && stamp === _stamp` 才复用，否则重建。文件从无到有、改长度、等长改写三种情况都触发重读。

**为什么用 mtime+size 不用 `fs.watch`**：`sessionCode()` 只在写记忆/发信时调用，频率极低，一次 `statSync` 开销可忽略；`fs.watch` 在 Windows 上对「编辑器另存为」这类原子替换会漏事件，还要管 watcher 生命周期与泄漏。

**验收**：自写 8 项断言全过（真实码表解析出 `LD-3F004438-01D5` 与 `LD-BA49BC34-894F`、未登记会话回退 `MT` 纯哈希、文件不存在→出现、改表、等长改写三条热重读路径）；smoke / whitebox / command / discipline 四套 `exit=0`；同步 profile 后 md5 一致（`B8244085070051FF2DF6E3A384C13BDF`，3152 B）。

**验真（2026-11-23 23:59，完全退出宿主重启后）**：同一会话调 `memory_mail list`，返回体 `code` 字段为 `LD-3F004438-01D5`（重启前同一调用返回 `MT-3F004438-01D5`），热重读在运行版生效。库状态与重启前逐项一致（541 条 / schema 5 / `integrity: true` / 22 个 `memory_*` 工具 / 首轮块 2,327 tokens），说明这轮只动了码表逻辑。重启前发出的那封信 `from` 仍为 `MT-…`——已写入的信件不回溯改写，属正常历史痕迹。

### 13.38 依赖瘦身 + 兄弟记忆检测 + embedding 降级修正（2026-11-24）

**起因**：`@huggingface/transformers` 原在 `optionalDependencies`，pnpm 会照装，连带拉 `onnxruntime-node@1.30.0`（287.7 MB，含各平台二进制）。`dsh plugin why onnxruntime-node` 的链路是 `meow-mind → @huggingface/transformers@4.3.2 → onnxruntime-node@1.30.0`——此前一直误记成视频插件的依赖，2026-11-24 卸载 video-understand 时才查清。

**改法一（`package.json`）**：`@huggingface/transformers` 从 `optionalDependencies` 移到 `peerDependencies`，标 `peerDependenciesMeta.optional = true`。optional peer 不被 pnpm 自动安装，新装机器不拉那 287 MB；本机已装的不受影响（改声明不删文件）。`peerDependenciesMeta` 里的 `note` 是非标准字段（npm/pnpm 忽略，只作文档）。

**改法二（`embed.mjs`）**：文件头注释一直写「缺失/断网一律返回 null 由上层降级」，实现却是 `catch { throw e }`。改成失败返回 `null` 并置模块级 `failed`——不装包时第一次检索失败即永久降级纯 BM25，不再每条消息重试、不再每轮抛一个异常被吞掉。配套把 `index.mjs` 启动日志由「embedding 就绪」改成「已启用（懒加载，首次检索才载模型）」：`createEmbedder` 只建 api 对象、不载模型，原文案是假的。

**改法三（`inject.mjs`）**：新增 `detectSiblingMemory()`，检测**当前 profile** 是否还装着 `meow-memory`——另一作者的同类插件（npm `meow-memory@0.33.3`，仓库 `Phant0Meow/dsh-meow-memory`，描述与本插件高度重合）。两者注册同名 `memory_*` 工具，同一 profile 下后加载的会把先加载的顶掉。检出时首轮块加一段「## 环境警告」，按注入预算决定是否省略（省略时记入 `dropped`）。

**为什么只查 `DSH_PROFILE_DIR`**：初版遍历 `$DSH_HOME/profiles/*` 全部 profile，只要任一装了 meow-memory 就报警；将来 `web` / `headless` 装了会让 `desktop` 会话误报。插件进程里 `DSH_PROFILE_DIR` 直接可用（本机 `C:\Users\ZQY\.dsh\profiles\desktop`），比遍历精确，也不用猜 profile 名。

**验收**：`detectSiblingMemory` 8 项断言全过（无 `DSH_PROFILE_DIR` / 目录不在 / 无 `package.json` / 只装 meow-mind / 装了 meow-memory 检出 0.33.3 / `DSH_PROFILE` 优先作文本名 / **别的 profile 装了不误报** / 坏 JSON 不抛）；smoke / whitebox / command / discipline 四套 `exit=0`。

**当前本机状态**：`profiles/*/package.json` 里只有 `desktop` 装 `meow-mind`（`file:`），没有 `meow-memory`，所以这段检测目前是空转的防御代码。

## 14. 测试环境桩（2026-11-21）

源码目录为省 464 MB 删过 `node_modules`，而 `src/index.mjs` 的注入链路依赖宿主的 `@deepseek-ai/dsh-llm`：

```js
let createUserMessage = null;
try {
  const llm = await import('@deepseek-ai/dsh-llm');
  createUserMessage = llm.createUserMessage ?? null;
} catch { createUserMessage = null; }
```

解析不到时 `makeMsg` 静默返回 `null`——**宿主里正常运行，但从源码目录跑 `test/whitebox.mjs` 会看到「注入 0 条」**，看着像回归、其实是环境缺失。2026-11-21 排查这个假象花了十几步（先怀疑 `dbFor` 走了别的库，加探针打出 `userRows=1 / block=228` 才定位到 `makeMsg` 返回 null）。

解法：`node_modules/@deepseek-ai/dsh-llm/` 放一个 **1 KB 测试桩**（`package.json` + `index.mjs`，只导出 `createUserMessage`），不参与运行时解析（宿主自己提供真实现）。补桩后白盒输出 `注入 2 条；kind=plugin:meow-mind`、`首轮注入 616 tokens`。

**另一条容易误判的**：白盒第二轮固定是「注入 0 条」——**这是去重生效**，同一会话里已注入过的命中条不再重复，不是 bug。

## 15. 用户画像（2026-11-21 建）

**为什么单独做一层**：19 条活跃 `user` 记忆本身已经够用，但它们是「散条」——注入时按 importance 排序，读的人得自己拼出「这是个什么样的人」。画像把散条压成**结论**，注入只花 1,040 字就能交代完整的行为画像，而原文仍留在 `user` 层当证据。

**借了什么**（调研 8 个框架 + B站实践后的取舍）：
- **Memobase**：`(topic, sub_topic)` 唯一不变式 + 三动作合并 + 每条 ≤5 句 + 时间标注
- **Letta Code**：「把每次修改当作对 prompt 的修订，不是往日志里追加」（`maintaining-core-memory/SKILL.md:6`）
- **B站实践**：`dream cursor`——单独记录「已提炼到哪一条」，避免每次 dream 重扫全库
- **没抄**：置信度分数（判不准，反而给假精确感）、自动抽取（触发时机不可控，先手动）

**三张表**（`src/profile.mjs`，零外部依赖）：
| 表 | 列 | 用途 |
|---|---|---|
| `user_profile` | `id` / `narrative` / `version` / `updated_at` | 单行，存全文与版本号 |
| `user_profile_section` | `profile_id` / `topic` / `sub_topic` / `content` / `confidence` / `mention_dates` / `updated_at` | 主键是 `(profile_id, topic, sub_topic)`，**没有自增 id** |
| `user_profile_cursor` | `key` / `value` | 已归纳游标（`lastMemoryAt`） |

**6 个在用维度**（固定顺序，不按字母排）：身份 / 工作方式 / 交付偏好 / 取舍标准 / 沟通风格 / 查证偏好。`goal`（长期目标）留在 schema 里但暂未使用。每个维度下再分 `sub_topic`（如 `tradeoff` 有 minimal / delete-hard / evaluate-first / upgrade / native / consolidate）。

**原 user 层已归档（2026-11-21 用户拍板）**：画像定稿后，19 条活跃 `user` 记忆全部降到 `status='review'`。`bm25.mjs:152` / `:216` 与注入的 `take()` 都只认 `memory` / `evolution`，所以归档后它们**退出检索与注入**，但 `memory_read` 仍可按 id 取原文回溯——相当于「不再参与推理，但证据不倒」。备份在 `handover/backups/memory-before-user-archive-<stamp>.db`（含 wal/shm），要恢复直接 `UPDATE user SET status='memory' WHERE id=?`。归档后首轮块 3,051 tokens（画像 997 字 + rules + project），与归档前基本持平——因为画像本来就已经顶替了散条 user 段。

**边界维度已删（2026-11-21 用户定规）**：原「边界禁忌」三条（不买联想系 / 商品参数不落库 / 未经同意不安装）全部移除——理由是「**不要留特定场景才会出现的倾向，尤其是技能中已经包含的场景与边界**」：「不买联想」在 `shopping-guide` 的边界清单里、「商品参数不落库」在记忆维护规则里、「未经同意不安装」是全局准则层的默认行为。画像只留**跨场景稳定**的特质，场景规则归技能与准则层。同轮还精简了三处带场景细节的条目：`identity/body` 只留体重身高（去掉购物尺码建议）、`delivery/single-file` 去掉 Downloads 权限提示、`tradeoff/evaluate-first` 去掉「查版本体积依赖、必要时解包读源码」这类审计步骤。

**`info` 维度改名过一次**：原来是「信息来源」，只有一条「B站视频读口播+图文+评论」——那其实是 `bili-transcript` 技能的规则，放在画像里既与技能重复、维度名也不符。2026-11-21 改成「**查证偏好**」，内容换成「判断东西靠不靠谱要可核验的一手材料（源码 / release notes / 实测数字 / 官方文档），二手介绍与宣传口径不算依据」，附两个日期作依据。

**合并三动作**（`upsertSection` 的 `merge`）：
- 缺省（append）：内容不同则用「；」拼接，**拼接前先剥原句尾部标点**（否则出「。；」）；相同则 `confidence + 1`
- `replace`：整条覆盖，`confidence` 归 1
- `abort`：不写

**注入**：`buildFirstTurnBlock` 优先放画像（`## 用户画像` + `buildBriefNarrative({ take: 2, maxChars: profileChars })`，默认 `take: 2` / `1050` 字），放得下就不再放散条 `user` 层；表不存在或为空时静默退回散条。实测真库 **3,016 tokens / 3,176 字符**（预算 3,200），散条版是 3,022——**token 基本持平，信息更结构化**。

**分节标题必须是 `###`**：用 `##` 会和注入块的大节（`## 全局准则（rules）`）同级，按 `##` 切段时画像会被切碎（测试里「用户画像段」切出空串）。

**游标**：`pendingMemories(db, { limit })` 取 `lastMemoryAt` 之后新写的 `user` 记忆；`memory_profile refresh` 带 `advance: true` 才推进游标——**归纳完才推，没归纳不许推**，否则会漏。

**冲突扫描**：`findConflicts` 查三类——同一子节内「不要」与「倾向」并存、`no-` 前缀 topic 与肯定句并存、字面重复。当前 0 处。冲突**不自动改**，由 `/dream` 报给用户决定保留哪条。

**已知边界**：①`/dream run` 的**自动归纳还没做**——目前只能手动 `memory_profile upsert`；②没有 UI（侧边栏只有记忆审议页，画像还看不到）；③画像与 `user` 层的关系是「结论 vs 证据」，删 `user` 记忆不会自动改画像，两者要靠 dream 对账。

---

## §14 源码基线（2026-11-24）

`C:\deepseek\work\meow-mind` 自 2026-11-24 起是本地 git 仓库：`main` 分支、36 个跟踪文件、初始提交 `78d2716`、`.git` 0.21 MB。

**刻意不进仓库的三样**（见 `.gitignore`）：
- `models/`（98.1 MB，Xenova bge-base-zh-v1.5 的 onnx 模型，可重下）
- `node_modules/`
- `test/fixtures-memories.json`（**真实记忆导出，含个人内容**——它被 `test/embed-eval.mjs` 当夹具用，但里面是用户真实记忆，绝不能推到远端；要换就现从本地库导出）

**改源码的定位**：`C:\deepseek\work\meow-mind` 是正本，`C:\Users\ZQY\.dsh\profiles\desktop\node_modules\meow-mind` 是安装副本；改完同步、**完全退出宿主重开**才在工具面生效。回退用 `git restore`，不许模型重写一份「看着一样」的。

**远端已配（2026-11-24 首推）**：`github.com/chenduhong-a/meow-mind`（私有，`main` 已追 `origin/main`）。推送命令必须带 `-c http.proxy=`——`~\.gitconfig` 里那条指向 `127.0.0.1:7897` 的代理已失效，不加会报 schannel 握手失败；凭据走系统级 `credential.helper=manager`。`test/fixtures-memories.json` 与 `models/` 被 `.gitignore` 挡住，远端只有源码。
