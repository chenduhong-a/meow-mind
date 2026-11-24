// 懒加载 embedding：@huggingface/transformers 为可选依赖，缺失/断网一律返回 null 由上层降级。
import { existsSync } from 'node:fs';
import os from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ONNX 默认吃满所有核心，跑批量嵌入时 Windows 资源管理器（explorer.exe）会抢不到
// 时间片被判「停止与 Windows 交互」并重启，表现为桌面变黑、点不动。
// 2026-11-20 实测两次（16:29、16:43），故限 4 线程并把进程降到 BelowNormal。
const ONNX_THREADS = 4;

let extractor = null;
let loading = null;
// 加载失败一次就别每条消息重试：包没装时 import 会稳定失败，
// 重试只会让每次检索都抛一个异常再被上层吞掉。装好包后重启插件即可。
let failed = false;

async function load(cfg, logger) {
  if (extractor !== null) return extractor;
  if (failed) return null;
  if (loading !== null) return loading;
  loading = (async () => {
    try { os.setPriority(0, 10); } catch { /* 权限不足时忽略，不影响功能 */ }
    const t = await import('@huggingface/transformers');
    const env = t.env;
    const local = cfg.embedding.localPath ? resolve(cfg.embedding.localPath) : join(PLUGIN_ROOT, 'models');
    if (existsSync(local)) {
      env.cacheDir = local;
      env.localModelPath = local;
      env.allowRemoteModels = false;
    } else {
      env.allowRemoteModels = cfg.embedding.allowRemote !== false;
      if (env.allowRemoteModels) env.remoteHost = 'https://hf-mirror.com';
    }
    const t0 = Date.now();
    extractor = await t.pipeline('feature-extraction', cfg.embedding.model, {
      dtype: cfg.embedding.dtype,
      session_options: { intraOpNumThreads: ONNX_THREADS, interOpNumThreads: 1 },
    });
    logger?.info?.(`meow-mind: embedding 加载 ${Date.now() - t0}ms（${ONNX_THREADS} 线程）`);
    return extractor;
  })();
  try {
    return await loading;
  } catch (e) {
    loading = null;
    failed = true;
    logger?.warn?.(`meow-mind: embedding 加载失败，本次运行降级纯 BM25（${e instanceof Error ? e.message : String(e)}）`);
    return null;
  }
}

export async function createEmbedder(cfg, logger) {
  let ready = false;
  const api = {
    ready: () => ready,
    async embed(text) {
      const ex = await load(cfg, logger);
      if (ex === null) return null;
      ready = true;
      const out = await ex([String(text).slice(0, 1000)], { pooling: 'cls', normalize: true });
      const dim = out.dims[out.dims.length - 1];
      return Float32Array.from(out.data.slice(0, dim));
    },
    async embedBatch(texts) {
      const ex = await load(cfg, logger);
      if (ex === null) return [];
      ready = true;
      const out = await ex(texts.map((t) => String(t).slice(0, 1000)), { pooling: 'cls', normalize: true });
      const dim = out.dims[out.dims.length - 1];
      const n = out.data.length / dim;
      const res = [];
      for (let i = 0; i < n; i++) res.push(Float32Array.from(out.data.slice(i * dim, (i + 1) * dim)));
      return res;
    }
  };
  return api;
}
