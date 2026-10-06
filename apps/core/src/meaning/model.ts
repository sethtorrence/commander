import type { ModelFile } from './download';

/*
  The embedding model search by meaning runs (#73), pinned: the repository revision and each file's
  size and SHA-256, so what is downloaded is exactly what was chosen and checked.

  IBM's granite-embedding-97m-multilingual-r2 (Apache-2.0, released April 2026), as int8 ONNX from
  onnx-community's conversion: 97M parameters, 384-dimensional embeddings, CLS pooling, normalised.
  It is the small model of the Granite R2 multilingual pair (pruned and distilled from the 311M one
  #6 named), scoring 50.1 on MTEB English retrieval and 60.3 on multilingual (311M: 52.6 and 65.2) at
  about a third of the size and cost per Item; Tagalog is among its 52 best-supported languages. The
  download is about 123 MB (the 311M model's int8 is 346 MB, Qwen3-Embedding-0.6B's over 600 MB).
*/

export type EmbeddingModel = {
  // Stored with every embedding: one made by another model (or revision) counts as missing.
  id: string;
  // As Settings shows it.
  name: string;
  // Where the files are downloaded from: `${baseUrl}/${file.path}`.
  baseUrl: string;
  files: readonly ModelFile[];
  // The ONNX graph and the tokenizer among the files.
  onnx: string;
  tokenizer: string;
  tokenizerConfig: string;
  dimensions: number;
  // Longer texts are cut to this many tokens (time to embed grows with length).
  maxTokens: number;
  // How similar (cosine) an Item must be to what was typed to be found by meaning: at least
  // `minSimilarity`, and within `margin` of the nearest (this model's similarities crowd together
  // between about 0.65 and 0.9, so the nearest says what near means for each query).
  minSimilarity: number;
  margin?: number;
};

const REPO = 'onnx-community/granite-embedding-97m-multilingual-r2-ONNX';
const REVISION = '536a9f241cb3f02a9c5995a1e708c784bd274859';

export const GRANITE_97M: EmbeddingModel = {
  id: `granite-embedding-97m-multilingual-r2@${REVISION.slice(0, 7)}/int8`,
  name: 'Granite Embedding 97M Multilingual R2',
  baseUrl: `https://huggingface.co/${REPO}/resolve/${REVISION}`,
  files: [
    {
      path: 'config.json',
      size: 1215,
      sha256: 'ae74d55a56f779774cb9a8e63d3c2da9ae1af83c00229ffdff43d0b38407a0ee',
    },
    {
      path: 'special_tokens_map.json',
      size: 871,
      sha256: '013787ee251ff611722479197c00853b62113ad303cb0a36524231783c676c69',
    },
    {
      path: 'tokenizer_config.json',
      size: 12860,
      sha256: '6ed69389e30a8ecabfce2f9ebcdf0c908b34056f24d994340f2f216521c057d5',
    },
    {
      path: 'tokenizer.json',
      size: 25301671,
      sha256: '51947676cae1f991fa51c6b9a24e14ee5460e5f0b9f692f13bb3159829d1592a',
    },
    {
      path: 'onnx/model_quantized.onnx',
      size: 97858099,
      sha256: '704c1ebca5fbb7cd83ced41827658ac4c9990c64f7f2874d22b78044e5022e22',
    },
  ],
  onnx: 'onnx/model_quantized.onnx',
  tokenizer: 'tokenizer.json',
  tokenizerConfig: 'tokenizer_config.json',
  dimensions: 384,
  maxTokens: 512,
  // Measured on work-like Items: a related Item scores 0.78–0.87, unrelated ones 0.65–0.77.
  minSimilarity: 0.74,
  margin: 0.035,
};

/** The model's download size, in bytes. */
export const downloadBytes = (model: EmbeddingModel) => model.files.reduce((sum, file) => sum + file.size, 0);
