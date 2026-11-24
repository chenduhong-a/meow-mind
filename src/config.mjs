// 配置 schema（schemastery）。全部 volatile：设置页可改、改完立即生效。
// schemastery 是宿主提供的 peer；缺失时降级为「无设置表单」，插件仍能加载。
let z = null;
try {
  z = (await import('@deepseek-ai/schemastery')).default ?? null;
} catch {
  z = null;
}

export const config = z === null ? undefined : z
  .object({
    enabled: z.boolean().default(true),
    /** 工作区内库目录（相对 cwd）。 */
    projectDir: z.string().default('.dsh-mind'),
    /** 全局目录覆盖（空=平台默认 ~/.dsh-mind）。 */
    homeDir: z.string().default(''),
    /** 全局共享库目录：默认 C:\deepseek\.dsh-mind-global；空字符串 = 关闭全局库。 */
    globalDir: z.string().default('C:/deepseek/.dsh-mind-global'),
    embedding: z
      .object({
        enabled: z.boolean().default(true),
        model: z.string().default('Xenova/bge-base-zh-v1.5'),
        dtype: z.string().default('q8'),
        /** 相对插件根；空=自动探测 models/ 目录。 */
        localPath: z.string().default(''),
        allowRemote: z.boolean().default(false)
      })
      .volatile(),
    injection: z
      .object({
        enabled: z.boolean().default(true),
        firstTurnBudget: z.number().default(3200),
        perMessageBudget: z.number().default(800),
        summaryChars: z.number().default(60),
        /** 命中块用的 L1 长度（比首轮的 L0 长，够判断要不要 read）。 */
        hitChars: z.number().default(80),
        // 用户画像：注入时按分节取前 N 条，总字数上限。画像表为空时自动退回散条 user 记忆。
        profileChars: z.number().default(1050),
        profileTake: z.number().default(2),
        topK: z.number().default(6),
        /** 用户消息短于该长度就不检索（寒暄）。 */
        minQueryChars: z.number().default(8)
      })
      .volatile(),
    retrieval: z
      .object({
        hybridPool: z.number().default(50),
        /** 语义分在词法分里的占比（0=纯词法，1=纯语义）；只对有向量的候选生效。 */
        semanticMix: z.number().default(0.5),
        /** 语义通道独立召回多少条（与词法候选取并集，才能救回词法完全没命中的条目）。 */
        semanticPool: z.number().default(20),
        /** 按查询意图给每层分配名额，避免 lesson 刷屏、user 层进不来。 */
        intentQuota: z.boolean().default(true),
        k1: z.number().default(1.2),
        b: z.number().default(0.75),
        weights: z
          .object({
            lex: z.number().default(0.65),
            recency: z.number().default(0.15),
            status: z.number().default(0.1),
            evidence: z.number().default(0.1)
          })
          .volatile()
      })
      .volatile(),
    governance: z
      .object({
        /** 自动捕获用户消息为原始观察（防压缩重写历史后丢失）。 */
        autoCapture: z.boolean().default(true),
        dupThreshold: z.number().default(0.92),
        similarThreshold: z.number().default(0.8),
        candidateTtlDays: z.number().default(7),
        staleDays: z.number().default(90)
      })
      .volatile()
  })
  .volatile();

export const DEFAULT_CONFIG = {
  enabled: true,
  projectDir: '.dsh-mind',
  homeDir: '',
  globalDir: 'C:/deepseek/.dsh-mind-global',
  embedding: { enabled: true, model: 'Xenova/bge-base-zh-v1.5', dtype: 'q8', localPath: '', allowRemote: false },
  injection: {
    enabled: true,
    firstTurnBudget: 3200,
    perMessageBudget: 800,
    summaryChars: 60,
    hitChars: 80,
    profileChars: 1050,
    profileTake: 2,
    topK: 6,
    minQueryChars: 8
  },
  retrieval: { hybridPool: 50, semanticMix: 0.5, semanticPool: 20, intentQuota: true, k1: 1.2, b: 0.75, weights: { lex: 0.65, recency: 0.15, status: 0.1, evidence: 0.1 } },
  governance: { autoCapture: true, dupThreshold: 0.92, similarThreshold: 0.8, candidateTtlDays: 7, staleDays: 90 }
};
