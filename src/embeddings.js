// Optional local embeddings via transformers.js (ONNX, prebuilt binaries —
// still no compilation step). If the optional dependency is missing or the
// model cannot be loaded (e.g. offline first run), callers fall back to
// keyword search.
import os from 'node:os';
import path from 'node:path';

const MODEL = 'Xenova/all-MiniLM-L6-v2';

let loader = null; // Promise<{embed, dim} | null>

export function getEmbedder() {
  if (!loader) {
    loader = (async () => {
      try {
        const t = await import('@huggingface/transformers');
        // keep the model cache outside node_modules so reinstalls reuse it
        t.env.cacheDir = path.join(os.homedir(), '.codegraph', 'models');
        const extractor = await t.pipeline('feature-extraction', MODEL, { dtype: 'q8' });
        const probe = await extractor('probe', { pooling: 'mean', normalize: true });
        const dim = probe.dims[probe.dims.length - 1];
        return {
          dim,
          model: MODEL,
          /** texts: string[] -> Float32Array of length texts.length * dim (normalized) */
          async embed(texts) {
            const out = await extractor(texts, { pooling: 'mean', normalize: true });
            return new Float32Array(out.data);
          }
        };
      } catch {
        return null;
      }
    })();
  }
  return loader;
}

export function cosineTopK(queryVec, matrix, dim, k) {
  const n = matrix.length / dim;
  const scored = [];
  for (let i = 0; i < n; i++) {
    let s = 0;
    const off = i * dim;
    for (let j = 0; j < dim; j++) s += queryVec[j] * matrix[off + j];
    scored.push({ index: i, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}
