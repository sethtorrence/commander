# Local AI models for the Agent

Research for wayfinder ticket #6. Researched 2026-10-01. Feeds #12 (Tech stack and local database), #16 (Email Buckets) and #19 (Agent jobs and model choice).

Citations are numbered `[n]` and listed under [Sources](#sources). Sources marked **(secondary)** are independent benchmarks or write-ups, not the owner of the fact. Vendor benchmark numbers are **self-reported** and were not reproduced. Facts about the author's machine marked **(observed)** were read from the machine itself on 2026-10-01 (sysfs, `free`, `pacman -Q`, `lsmod`), not from a web source.

## Question

Which local model runtimes and models can run the Agent on the author's machine (AMD Strix Halo, about 64 GB unified memory, Linux) and on more typical tester hardware, and how good are they at the Agent's jobs?

The ticket asks for:

1. Runtimes: llama.cpp (Vulkan/ROCm), Ollama, LM Studio, vLLM and others. The state of Strix Halo support. Embedding a runtime inside a desktop app versus requiring a separate install.
2. Open-weight models that fit, with throughput (tokens/sec) and memory use.
3. Evidence of quality at the Agent's jobs: sorting email into Buckets, extracting Todos from notes and email, summarizing GitHub activity, proposing calendar events, structured (JSON) output, tool calling.
4. Minimum hardware for an acceptable experience (8/16/32 GB laptops, Apple Silicon, NVIDIA), and when to fall back to a cloud API key.
5. Local embedding models for search, if useful.

## Short answer

- **One engine sits under almost everything: llama.cpp.** Ollama, LM Studio, Lemonade, node-llama-cpp and Docker Model Runner all run GGUF models through it [16][20][23][25][29]. It is MIT-licensed [88]. It ships prebuilt Vulkan, ROCm, CUDA and Metal binaries [4]. Its `llama-server` exposes OpenAI-compatible endpoints (chat completions, JSON-schema output, tools, embeddings) and an Anthropic-compatible `/v1/messages` endpoint [1]. vLLM is a server-class engine: Linux-only on ROCm and pinned to Python 3.12 wheels [22]. It is the wrong fit for a desktop app.
- **Strix Halo works well today through Vulkan (Mesa RADV).** AMD's ROCm 10.0.0 (2026-08-25) officially supports gfx1151, but only on Ubuntu 26.04 and 24.04.4 [31]. Arch ships ROCm 7.2.4 [37]. Community benchmarks show Vulkan as the simpler default. ROCm is faster at prompt processing (about +20%) and slower at generation (about −25%), and which wins depends on the model [38][39]. The Agent's jobs are prompt-heavy (long input, short JSON output), so ROCm's prefill edge matters. Measure both.
- **The author's machine is capped by a kernel default, not by the hardware.** It currently exposes 4 GiB of VRAM carve-out plus 29.2 GiB of GTT to the GPU **(observed)**. AMD recommends a small BIOS carve-out and raising the TTM/GTT limit with `amd-ttm` [33]. Without that change, about 33 GiB is GPU-addressable.
- **Models (all Apache-2.0 unless noted).**
  - Author's machine: Qwen3.6-35B-A3B (22 GB Q4) or Gemma-4-26B-A4B (17 GB Q4). Both are MoE models generating about 53–60 tok/s with about 1,000–1,200 tok/s prompt processing on Strix Halo [38]. They come out roughly as fast as a 4B dense model and much stronger.
  - Dense 27–31B models (Qwen3.6-27B, Qwen3.8-27B, Gemma-4-31B, Muse Glimmer 30B) score higher on independent reliability tests but generate at about 11–12 tok/s. Speculative decoding (MTP) roughly doubles that [38].
  - gpt-oss-120b (63.4 GB) and Qwen3.5-122B-A10B (about 77 GB) do not fit in 64 GB [61][54].
  - 16 GB testers: Qwen3.5-4B, Gemma-4-E4B, Granite-4.2-3B/8B, or LFM2.5-8B-A1B (LFM2.5 has a $10M revenue cap on its license [58]).
- **Quality: no public benchmark measures email Bucket sorting, Todo extraction, GitHub summaries or calendar proposals directly.** Proxy evidence agrees on four points:
  - Single-turn function calling by 8B-class open models is about as accurate as frontier models. On BFCL's "live" category, Qwen3-8B scores 80.5% against Claude Opus 4.5's 79.8%. Multi-turn is where they fall apart: 41.8% against 68.4% [63].
  - Grammar-constrained decoding makes parseable JSON a given, and in one study raised task accuracy [64].
  - Embedded prompt injections in untrusted text succeeded against some current local models in an independent test [38].
  - Even frontier models do badly at end-to-end calendar-write agent tasks [67].

  So build the Agent as many small, single-shot, schema-constrained calls with thinking off, and let deterministic code do validation, date math and scheduling.
- **Hardware floor.**
  - 16 GB of RAM or unified memory is the practical floor for a local default (4B-class model).
  - 8 GB machines should default to a cloud key or a no-LLM mode.
  - 32 GB unified memory, or a 12–24 GB NVIDIA GPU, runs the 20–35B MoE class.
  - Fall back to a cloud key on weak hardware, for multi-step tool use, for very long inputs, and to escalate low-confidence items. Always make it explicit opt-in: email content leaving the machine is covered by Google's Limited Use rules [77][78].
- **Embeddings are worth it, and cheap.** Qwen3-Embedding-0.6B or granite-embedding-311m-multilingual-r2 (both Apache-2.0) [80][81], stored in SQLite with `sqlite-vec` (pre-v1, brute-force KNN is stable, ANN is alpha) [83] next to FTS5 [84].

## 1. Runtimes

### 1.1 What each runtime is

| Runtime | License | What it is | Strix Halo (gfx1151) | API surface | Can Commander ship it? |
|---|---|---|---|---|---|
| **llama.cpp / `llama-server`** | MIT [88] | C/C++ inference engine and HTTP server for GGUF models | Vulkan works on any Vulkan driver. The prebuilt Linux ROCm binary includes `gfx1151` in its GPU targets [6] | OpenAI-compatible `/v1/chat/completions`, `/v1/responses`, `/v1/embeddings`, Anthropic-compatible `/v1/messages`, rerank, router mode for several models, sleep-on-idle [1] | Yes. Prebuilt binaries: Linux Vulkan 30 MiB, Linux CPU 16 MiB, macOS arm64 11 MiB, Linux ROCm 231 MiB, Linux CUDA 145 MiB plus a 419 MiB CUDA runtime [4] |
| **Ollama** | MIT [88] | Model manager and server wrapping llama.cpp (and MLX on Apple Silicon) [15][16] | Lists "Ryzen AI Max+ 395" under ROCm. Needs the ROCm v7 driver on Linux. Vulkan is "enabled by default when the backend is installed" [7] | Native API, OpenAI-compatible, Anthropic-compatible `/v1/messages` [13]. Structured outputs through a JSON schema in `format` [8]. Tool calling [9] | Possible, but on Linux it installs as a systemd service [12]. Usually a separate install |
| **LM Studio** | Proprietary. Licensed for "personal and / or internal business purposes" [17] | Desktop app plus headless daemon `llmster` (from 0.4.0) [21] | Not documented in system requirements [18] | REST, `lmstudio-js`, `lmstudio-python`, OpenAI- and Anthropic-compatible endpoints, structured output, tool use, JIT load with idle TTL [19][21] | **No.** Terms forbid distributing it and forbid integrating "other than through Company published interfaces" [17]. Commander may only talk to a copy the User installed |
| **vLLM** | Apache-2.0 [88] | High-throughput serving engine | ROCm build lists "Ryzen AI MAX / AI 300 Series (gfx1151/1150)" and needs ROCm 7.0.2+. Linux-only. ROCm wheels only for Python 3.12 [22] | OpenAI-compatible | Not sensible for a desktop app |
| **Lemonade Server** | Apache-2.0 [88] (sponsored by AMD [23]) | Local server bundling llama.cpp (Vulkan/ROCm), FastFlowLM (NPU), whisper.cpp and more | Explicitly targets Ryzen AI. XDNA2 NPU support on Linux [23] | OpenAI-compatible at `localhost:13305/v1` [23] | Separate install |
| **FastFlowLM** | MIT orchestration. NPU kernels are binaries, "free for any use, including commercial use" [24] | LLMs on Ryzen AI XDNA2 NPUs. Linux since March 2026 [24] | Supports Strix Halo's NPU [24] | Through Lemonade [24] | Niche. Small model list [24] |
| **node-llama-cpp** | MIT [88] | Node.js bindings to llama.cpp. v3.22.1, 2026-09-28 [25][27] | Prebuilt `linux-x64-vulkan`. **No ROCm prebuilt** [27] | In-process JS API. JSON-schema grammar, function calling, embeddings [25] | Yes, in-process. Electron: main process only, and the binaries must stay outside the asar [26] |
| **Docker Model Runner** | Part of Docker | llama.cpp and vLLM behind Docker [29] | Linux CPU, CUDA, ROCm, Vulkan [29] | OpenAI- and Ollama-compatible [29] | Needs Docker Desktop or Engine. Not a tester-friendly dependency |

### 1.2 State of Strix Halo support (as of 2026-10-01)

**Hardware.** The Ryzen AI Max+ 395 has a 256-bit LPDDR5x-8000 memory interface (up to 128 GB) and a Radeon 8060S with 40 RDNA 3.5 CUs [30]. That works out to 256 GB/s theoretical bandwidth (256 bits × 8000 MT/s ÷ 8). Token generation on this chip is bandwidth-bound [38].

**The author's machine (observed).**

- Ryzen AI Max+ 395, kernel 7.2.6-arch2-1.
- 58 GiB of RAM visible to the OS.
- `mem_info_vram_total` = 4.0 GiB and `mem_info_gtt_total` = 29.2 GiB, with no TTM or GTT kernel parameters set.
- Mesa 26.2.3 with `vulkan-radeon` (RADV) installed.
- The `amdxdna` NPU driver is loaded and `/dev/accel/accel0` exists.

**Memory configuration.**

- AMD's Strix Halo guide (ROCm 10.0.0 docs) recommends keeping the BIOS VRAM reservation small, "for example, 0.5 GB". Instead, raise the TTM page limit (`/sys/module/ttm/parameters/pages_limit`) with the `amd-ttm` tool from `amd-debug-tools`; a reboot is needed. The default GTT is about 50% of system RAM [33].
- `amdgpu.gttsize` is deprecated and "will be removed in the future" [35].
- On this machine, raising the limit to roughly 44–48 GB would leave about 10–14 GB for the OS, Commander and a browser. That figure is an estimate.

**Kernel.** AMD lists kernel fixes required for gfx1151. For distributions other than Ubuntu the minimum is `6.18.4` or later [33]. The author's 7.2.6 is newer.

**ROCm.**

- ROCm 10.0.0, released 2026-08-25, lists "AMD Ryzen AI Max+ 395 (Radeon 8060S) (gfx1151)" as supported. The only Linux distributions listed for it are Ubuntu 26.04 (GA 7.0 kernel) and Ubuntu 24.04.4 (OEM 6.17) [31].
- The frameworks AMD lists are PyTorch, TensorFlow, JAX and vLLM. llama.cpp and Ollama are not in AMD's matrix [31].
- **Recent change:** ROCm jumped from the 7.x series to 10.0 and is now built on "TheRock" [32].
- The older "ROCm on Radeon and Ryzen" matrix (7.2.1) lists Ryzen AI Max with PyTorch only, on Ubuntu 24.04.4 [34].
- Arch's `rocm-hip-runtime` is 7.2.4 (packaged 2026-06-02) [37], so the author's distro is behind AMD's supported release.
- llama.cpp's release CI builds its Linux ROCm binary against AMD's ROCm 10.0.0 pip wheels, with `gfx1151` in `AMDGPU_TARGETS` [6]. That binary can be used without a system ROCm install matching AMD's matrix. Verify this on the machine.
- llama.cpp's build guide documents HIP builds and a `GGML_CUDA_ENABLE_UNIFIED_MEMORY=1` option that lets an integrated GPU share main memory on Linux. It does not mention gfx1151 [3].

**Vulkan.**

- AMD discontinued its AMDVLK Vulkan driver in September 2025 and now backs Mesa RADV as the supported open driver [36].
- Independent Strix Halo benchmarks call RADV the "recommended default" (128 GB machine, August–September 2026) [38].
- Arch packages `ollama-vulkan` and `ollama-rocm` 0.35.0 (2026-09-30) [37].

**Vulkan versus ROCm (secondary).**

- One test (2026-08-03, Qwen3-Coder-30B-A3B Q4_K_S): ROCm 1,345 tok/s prompt and 73.7 tok/s generation; Vulkan 1,115 tok/s prompt and 97.7 tok/s generation. That is ROCm "20.56% faster at prompt processing and 24.64% slower at generation" [39].
- A larger model (Qwen3.5-122B-A10B) showed the same split [39].
- An August 2025 snapshot found Vulkan faster on every model tested then [40]. ROCm has improved since, so treat older guidance as stale.
- Instability under ROCm is still reported: an "illegal memory access" after about 68 minutes on one model [38].

**NPU.** The XDNA2 NPU works on Linux through FastFlowLM and Lemonade [23][24]. The model list is small (for example Llama 3.2 1B and Qwen3 4B) [24]. This is an optional, low-power path, not the main one.

### 1.3 Embedding a runtime in the desktop app versus a separate install

| Option | How | For | Against |
|---|---|---|---|
| **A. Bring your own server** | User installs Ollama, LM Studio or Lemonade. Commander stores a base URL | Zero bundling. The runtime handles GPU detection, model downloads and updates. Same client code also reaches cloud APIs | Extra install step for testers. Version drift. Ollama's default context is 4k on machines with under 24 GiB VRAM, which silently truncates long inputs unless set [11]. LM Studio cannot be bundled [17] |
| **B. Bundle `llama-server` as a sidecar process** | Ship the right binary per platform. Tauri has a first-class `externalBin` sidecar mechanism [28]. Electron can spawn a child process | Commander pins the engine version. HTTP boundary isolates crashes. Router mode serves several models from a directory. `--sleep-idle-seconds` unloads models and KV cache when idle [1]. `--fit` (default on) sizes settings to device memory [1]. Small for Vulkan and Metal [4] | Commander owns backend choice per machine (Vulkan, CUDA, Metal, ROCm), model downloads and updates. New model architectures need a newer engine build. CUDA bundles are large (about 560 MiB with runtime) [4] |
| **C. In-process bindings** | node-llama-cpp in the Node or Electron main process [25][26] | No separate process. Typed JS API with grammar and JSON-schema enforcement [25] | Electron main process only [26]. No ROCm prebuilt [27]. A native crash or memory spike shares the app's process. Engine updates are gated on the binding's release cadence |

Notes for the decision:

- **The OpenAI-compatible HTTP API is the common interface.** llama-server, Ollama, LM Studio, Lemonade and Docker Model Runner all speak it [1][13][19][23][29]. llama-server and Ollama also speak the Anthropic Messages API [1][13]. A single provider-agnostic client covers options A and B plus a cloud key.
- **`--jinja` is now on by default in llama-server** [1]. The older function-calling doc still says to pass it [2]. Tool calling depends on the model's chat template, and the doc warns that extreme KV-cache quantization (`-ctk q4_0`) "can substantially degrade the model's tool calling performance" [2].
- **Recent changes:**
  - llama.cpp began semver releases in August 2026 (v0.1.2 on 2026-08-18, v0.5.0 on 2026-09-23). The rolling `bNNNNN` builds are now marked pre-release [5].
  - Ollama v0.35.0 (2026-09-28) added a "decision models" endpoint, `/v1/systemone` [14].
  - Ollama v0.40.0-rc0 (2026-09-25, pre-release) runs supported models on MLX by default on Apple Silicon [15].
  - Ollama v0.34.4 (2026-09-23) made "structured outputs on thinking models … apply in a single pass" [16].

## 2. Open-weight models that fit

### 2.1 The current model landscape (October 2026)

The landscape moved fast in 2026: Qwen went 3.5, then 3.6, then 3.8 within six months [41], and Gemma 4 moved to Apache-2.0 [48]. Plan for model swaps.

| Family | Sizes relevant here | Released | License | Notes |
|---|---|---|---|---|
| **Qwen3.5** | 0.8B, 2B, 4B, 9B dense; 27B dense; 35B-A3B MoE; 122B-A10B MoE; 397B-A17B MoE [41] | 2026-02-16 to 03-02 [41] | Apache-2.0 [42] | Hybrid Gated DeltaNet plus attention, 262K context, vision [42]. Thinking on by default for 4B and up; disable with `chat_template_kwargs: {"enable_thinking": false}` [42][43]. 2B is non-thinking by default [44] |
| **Qwen3.6** | 35B-A3B MoE, 27B dense [41] | 2026-04-16 and 04-22 [41] | Apache-2.0 [45] | Successor to 3.5 at the same sizes [45] |
| **Qwen3.8** | 27B dense (also 2.4T-A95B, and Flash-Next at about 180B) [41][61] | 2026-08-14 [41] | Apache-2.0 for 27B [46] | Thinking on by default, can be disabled per request [46] |
| **Gemma 4** | E2B, E4B, 26B-A4B MoE, 31B dense; 12B "Unified" (2026-06-03) [47] | 2026-03-31 [47] (blog dated 2026-04-02 [48]) | **Apache-2.0** (changed from the Gemma terms) [48][50] | "Native support for function-calling, structured JSON output" [48]. Thinking only when `<\|think\|>` starts the system prompt [50] |
| **gpt-oss** | 20b (21B, 3.6B active), 120b (117B, 5.1B active) [51][52] | 2025-08-05 [52] | Apache-2.0 plus usage policy [51] | MXFP4. 20b "within 16GB memory". Requires the harmony response format. Low/medium/high reasoning [51]. Still OpenAI's latest open-weight LLMs as of this date [53] |
| **IBM Granite 4.2** | 3B, 8B, 30B dense [55] | 2026-08-25 [55] | Apache-2.0 [55] | Reasoning with tool calling. Thinking on by default, with non-thinking and low-effort modes [55] |
| **Ministral 3** | 3B, 8B, 14B [56][59] | 2025-12-02 [56] | Apache-2.0 [56][59] | "Function calling and JSON outputting", 256k context [59] |
| **LFM2.5 (Liquid AI)** | 8B-A1B MoE (1.5B active), 2.6B [57] | 2026-05-28 (8B-A1B) | **LFM Open License v1.0**: commercial rights end above $10M annual revenue [58] | Pythonic tool calls between special tokens by default [57]. Built for CPU and edge |
| **Muse Glimmer (Meta)** | 30B dense [60] | August 2026 [60] | Apache-2.0 [60] | Aimed at agents "on consumer hardware", under 20 GB quantized [60] |
| Too big for 64 GB | Mistral Small 4 (119B-A6B, Apache-2.0, 2026-03-16) [62]; gpt-oss-120b; Qwen3.5-122B-A10B | | | See 2.3 |

### 2.2 Throughput and memory on Strix Halo

All figures are **secondary**. They come from one independent tester on a 128 GB Ryzen AI Max+ 395 (Vulkan RADV, llama.cpp `llama-bench`, 512-token prompt and 128-token generation, page updated August–September 2026) [38], unless marked. "Size" is the GGUF file size reported there. Runtime memory adds KV cache and compute buffers on top.

| Model | Type | Size | Prompt tok/s (pp512) | Gen tok/s (tg128) |
|---|---|---|---|---|
| Gemma-4-E2B | dense ("4.6B" per tester) | 2.9 GiB | 3,382 | 109 |
| Granite-4.1-3B | dense | 2.0 GiB | 2,278 | 88.7 |
| Qwen3.5-4B | dense | 4 GiB | 1,375 | 38 |
| Gemma-4-E4B | dense ("7.5B" per tester) | 4.7 GiB | 1,828 | 59 |
| Granite-4.1-8B | dense | 5.1 GiB | 936 | 38.6 |
| Qwen3.5-9B | dense | 5.6 GiB | 972 | 36 |
| Gemma-4-12B (Q8) | dense | 13.6 GiB | 716 | 14.0 |
| Gemma-4-26B-A4B | MoE, 4B active | 16 GiB | 1,196 | 52.9 |
| Qwen3.5-35B-A3B | MoE, 3B active | 21 GiB | 1,017 | 60 |
| Qwen3.6-35B-A3B | MoE, 3B active | 20.8 GiB | 1,029 | 60 (67 with MTP n=3) |
| Qwen3.6-27B | dense | 16.4 GiB | 322 | 12.0 (21.3 with MTP n=3) |
| Gemma-4-31B | dense | 17.5 GiB | 261 | 11.1 (24.5 with MTP drafter) |
| Granite-4.1-30B | dense | 16.5 GiB | 275 | 11.8 |
| Qwen3-Coder-30B-A3B Q4_K_S [39] | MoE, 3B active | 17.46 GB | Vulkan 1,115 / ROCm 1,345 | Vulkan 97.7 / ROCm 73.7 |

Reading the table:

- **MoE models with about 3–4B active parameters are the sweet spot on unified-memory machines.** They generate about 5× faster than dense 27–31B models at similar file sizes [38].
- **Speculative decoding (MTP) is lossless.** Every token is still drawn from the main model's distribution. It gives about 1.8–2.4× on dense models and about 1.2–1.4× on MoE models [38]. Mainline llama.cpp supports MTP for Qwen3.5 and 3.6 (merged 2026-05-16) and a separate drafter file for Gemma 4 (merged 2026-06-07) [38].
- **Bandwidth sets the ceiling on generation.** Generation speed is at most memory bandwidth divided by the bytes of weights read per token. For Qwen3.5-9B: 256 GB/s ÷ 6.0 GB ≈ 43 tok/s, against 36 measured. For MoE models only the active experts are read, which is why 35B-A3B decodes faster than 9B dense.
- **Prompt processing matters more than generation for the Agent.** Classification and extraction send in thousands of tokens and get back tens. Pick models and backends on pp numbers.
- **Thinking mode is expensive.** One model averaged 43 s per call with thinking on, against about 4–8 s for non-thinking models on the same automation suite [38].

**Fit on the author's 64 GB machine.**

- At the current default (about 33 GiB GPU-addressable, **observed**), every model in the table fits at Q4.
- Q8 of the 35B-A3B models (36.9 GB [61]) needs the GTT limit raised.
- gpt-oss-120b is 63.4 GB (MXFP4) [61]. llama.cpp's guide puts it at about 64.0 GB total at 8k context [54]. **Does not fit.**
- Qwen3.5-122B-A10B Q4_K_M is about 76.6 GB [61], and Mistral Small 4 Q4 is about 69–70 GB [38]. **Neither fits.**
- gpt-oss-20b is 12.1 GB [61], about 14.9 GB total at 8k context [54]. It fits easily. No current Strix Halo throughput figure was found for it.

### 2.3 Download sizes of candidate GGUFs (Hugging Face, Q4_K_M unless noted) [61]

| Model | Size |
|---|---|
| Qwen3.5-0.8B | 0.5 GB |
| Qwen3.5-2B | 1.3 GB |
| Qwen3.5-4B | 2.7 GB (Q8_0 4.5 GB) |
| Gemma-4-E2B | 3.1 GB |
| Gemma-4-E4B | 5.0 GB |
| LFM2.5-8B-A1B | 5.2 GB |
| Ministral-3-8B | 5.2 GB |
| Granite-4.2-8B | 5.3 GB |
| Qwen3.5-9B | 5.7 GB (Q8_0 9.5 GB) |
| gpt-oss-20b | 12.1 GB (MXFP4) |
| Gemma-4-26B-A4B | 16.9 GB (Q8_0 26.9 GB) |
| Qwen3.8-27B | 16.5 GB |
| Qwen3.6-27B | 16.8 GB |
| Muse Glimmer 30B | 16.8 GB |
| Gemma-4-31B | 18.3 GB |
| Qwen3.6-35B-A3B | 22.1 GB (Q8_0 36.9 GB) |

## 3. Evidence of quality at the Agent's jobs

**Caveat up front.** No public benchmark found scores local models on email-to-Bucket sorting, Todo extraction from notes, GitHub activity summaries, or calendar-event proposals. The evidence below is proxy evidence: vendor benchmarks, an independent function-calling leaderboard, independent research preprints, and one independent automation-reliability suite. The decision should rest on a small eval set built from the author's own data (see Implications).

### 3.1 Structured (JSON) output

- **All three main runtimes can constrain decoding to a JSON schema.** llama-server accepts `response_format` with `json_schema` [1]. Ollama takes a JSON schema in `format` [8]. LM Studio enforces `response_format` with llama.cpp grammars for GGUF and Outlines for MLX [20]. node-llama-cpp has `createGrammarForJsonSchema()` [25].
- **Caveats:**
  - LM Studio warns "not all models are capable of structured output, particularly LLMs below 7B parameters" [20].
  - Ollama recommends also putting the schema in the prompt and using a low temperature [8].
  - Until v0.34.4 (2026-09-23), Ollama's structured outputs on thinking models were not single-pass [16].
- **Constrained decoding helped accuracy and exposed llama.cpp coverage gaps.** JSONSchemaBench (independent, January 2025, Llama-3.1-8B) found constrained decoding "achieves higher performance than the unconstrained setting" on its reasoning tasks (for example GSM8K 80.1% unconstrained against 83.8% with Guidance) [64]. llama.cpp's JSON-schema coverage was the weakest of the open engines then: empirical coverage 0.38–0.95 depending on dataset, with failures mostly at schema compilation [64]. llama.cpp has kept improving its JSON-schema handling ("Improve JSON Schema and PEG handling", v0.5.0 [5]), so re-check this. Keep the Agent's schemas simple: flat objects, enums, short strings, no exotic keywords.
- **Prompting strategy can matter more than model size.** LLMStructBench (independent, February 2026, 22 open models from 0.6B to 70B) found "choosing the right prompting strategy is more important than standard attributes such as model size". Gemma3-12B ranked in the top three, ahead of several 70B models [65]. Forcing valid JSON shifts errors "toward incorrect field values", so code must still validate meaning, not just shape [65].
- **Reliability without constraints (secondary).** In an independent automation suite (strict JSON envelopes, extraction and classification with exact ground truth, format contracts, robustness), Qwen3.6-27B returned every call machine-usable and 96.9% parseable with "zero recovery". Gemma-4-31B QAT had the best strict parse rate at 98.5%. Qwen3.8-27B scored 62.5/65 with 98.5% usable output. These runs parse raw output, with no constrained decoding reported [38]. With grammar constraints, parse failures should approach zero, which leaves semantic accuracy as the open question.
- **Thinking leaks.** Qwen3.6 models, even with `enable_thinking:false`, sometimes leaked planning notes into free-text output [38]. Constrained decoding prevents this for JSON jobs.

### 3.2 Tool calling

**Independent leaderboard.** BFCL V4 was last updated 2026-04-12 and covers older-generation open models only: no Qwen3.5/3.6/3.8, Gemma 4 or gpt-oss [63].

| Model (BFCL V4 [63]) | Overall | Live (single-turn, real-world) | Multi-turn | Irrelevance detection |
|---|---|---|---|---|
| Claude-Opus-4.5 (FC) | 77.47% | 79.79% | 68.38% | 84.72% |
| Claude-Haiku-4.5 (FC) | 68.70% | 78.68% | 53.62% | 85.11% |
| Qwen3-8B (FC) | 42.57% | 80.53% | 41.75% | 79.07% |
| Qwen3-30B-A3B-Instruct-2507 (FC) | 41.39% | 77.94% | 30.00% | 79.90% |
| Qwen3-4B-Instruct-2507 (FC) | 35.68% | 76.39% | 22.12% | 84.93% |
| Gemma-3-12b-it (Prompt) | 30.43% | 74.24% | 5.75% | 70.29% |

**Takeaway:** small open models already match frontier models on single, well-specified calls (the "live" column). They fall far behind on multi-turn, memory and web-search agent tasks [63]. The Agent's jobs should be shaped as single calls.

**Vendor self-reported scores for current models.** These were run with each vendor's own settings, mostly thinking on, and are not comparable across vendors.

| Model | IFEval | BFCL-V4 | τ²-bench | Source |
|---|---|---|---|---|
| Qwen3.5-35B-A3B | 91.9 | 67.3 | 81.2 | [42] |
| Qwen3.5-9B | 91.5 | 66.1 | 79.1 | [43] |
| Qwen3.5-4B | 89.8 | 50.3 | 79.9 | [43] |
| Qwen3.5-2B (thinking) | 78.6 | 43.6 | 48.8 | [44] |
| Qwen3.5-0.8B (thinking) | 44.0 | 25.3 | 11.6 | [44] |
| Gemma-4-31B / 26B-A4B / 12B | — | — | 76.9 / 68.2 / 69.0 | [49] |
| Gemma-4-E4B / E2B | — | — | 42.2 / 24.5 | [49] |
| Granite-4.2-3B | IFBench 74.33 | 52.41 | τ³ 45.78 | [55] |
| LFM2.5-8B-A1B | 91.84 | 49.73 (v3: 64.79) | Telecom 88.07 / Retail 39.82 | [57] |
| gpt-oss-20b (low/med/high) | — | — | τ-bench Retail (v1) 35.0 / 47.3 / 54.8 | [52] |

Qwen3.6-35B-A3B reports TAU3-Bench 67.2 and MCPMark 37.0, against 67.5 and 18.1 for Gemma4-31B in the same table [45].

### 3.3 Sorting email into Buckets (classification)

- **Zero-shot classification by small models is mediocre when there are many labels.** An independent study (2026-07-29) evaluated 41 open-weight models from 135M to 9B on eight zero-shot intent-classification datasets. The best aggregate score was 0.660 (Mistral-7B-Instruct-v0.3). "Instruction-tuned 3B models can outperform several evaluated 7B base models", and instruction tuning mattered more than parameter count [66]. Intent datasets have many labels. Commander will likely have a handful of Buckets with written descriptions, an easier setting, but there is no published number for it.
- **Confidence scores are available.** llama-server can return per-token probabilities (`n_probs`) [1], so a Bucket choice can carry a probability. Ollama v0.35.0 (2026-09-28, three days old) added `/v1/systemone` "decision models". They return a choice, per-option probabilities and a confidence for "ticket triage … and content classification". This is Ollama-specific and new; currently the only models are Bespoke Labs' Nimble and Together AI's Tev1 [14].
- **Classification and extraction reliability (secondary).** In the independent suite, "Extraction & Classification" is one of four tiers. The best 26–31B models scored 59–64.5 of 65 overall. Quantization mattered: one Gemma-4-31B quant scored about 5 points below Google's QAT build at the same file size [38]. No per-tier numbers for small models were published [38].

### 3.4 Extracting Todos from notes and email

- This is structured extraction. The evidence in 3.1 applies: schema enforcement guarantees shape, and model choice plus prompting decide field accuracy [64][65].
- **Prompt injection is a real risk because email is untrusted input.** In the independent robustness tier [38]:
  - Gemma-4-26B-A4B (Q8) "fell for an embedded injection outright", returning a summary field containing the attacker's payload.
  - Qwen3.6-35B-A3B assigned "exactly the importance score the injection asked for".
  - Laguna S 2.1 resisted all three injection trials.

  OWASP's LLM01 calls this indirect prompt injection (input "from external sources, such as websites or files"). Its mitigations include defining and validating output formats with deterministic code, least privilege ("handle these functions in code rather than providing them to the model"), "require human approval for high-risk actions", and "segregate and identify external content" [69].

### 3.5 Summarizing GitHub activity

- This job is long-input. Prefill speed decides latency. On Strix Halo, MoE models process about 1,000–1,200 tok/s at short contexts [38], so a 20k-token digest takes tens of seconds. That is fine for a background job.
- Long-context quality varies by model. Vendors report LongBench v2 59.0 for Qwen3.5-35B-A3B [42], and MRCR v2 at 128k of 66.4% (Gemma-4-31B), 44.1% (26B-A4B) and 25.4% (E4B) [50].
- Generation speed falls at very long contexts on Vulkan for some models. In one case it fell from 13.3 to 8.3 tok/s between 75K and 188K tokens, while a ROCm build held about 34 tok/s [38]. Chunk the input (summarize per repository, then merge) rather than relying on a 100K+ prompt.

### 3.6 Proposing calendar events

- **Even frontier models are weak at end-to-end calendar actions.** EmailBench (independent, 2026-09-25) tested frontier models only, as tool-using agents over a synthetic mailbox and calendar. The best overall pass rate was 33.5% (Claude Sonnet 4.5). The same model passed "88.9% of folder tasks … compared with 16.7% of calendar-write tasks". The authors stress that "valid tool execution is not equivalent to task completion" [67]. No open-weight models were tested.
- **Wording changes break constraint handling.** SCHEDBench (independent, 2026-08-26) found models "not reliably invariant to semantically equivalent renderings of the same scheduling problem". Reordering constraints alone caused measurable shifts [68].
- **Implication:** the LLM should only extract an event candidate (title, participants, a date or time phrase, duration) into a schema. Deterministic code should resolve dates in the User's timezone, check free/busy and pick slots, and the result should stay a proposal under the Autonomy setting.

### 3.7 Thinking mode

- For the Agent's high-volume jobs, turn thinking off: Qwen `enable_thinking:false` [42], Gemma 4 by omitting `<|think|>` [50], llama-server `--reasoning off` or `--reasoning-budget` [1], Ollama `"think": false` ("if the model permits it") [87].
- The independent suite ran its automation tier with thinking suppressed because "latency and machine-usable envelopes matter" [38].
- It also found "thinking mode actively hurts" on a structured-output coding suite (Qwen3.5-9B scored 5 rather than 1 with thinking off) [38].
- Keep thinking for occasional hard jobs, such as a weekly synthesis.

## 4. Minimum hardware and cloud fallback

### 4.1 Reference throughput on other hardware

**Apple Silicon.** These are community-submitted results in the llama.cpp repo for LLaMA 7B Q4_0, the same test across chips [70].

| Chip | Bandwidth | Prompt tok/s | Gen tok/s |
|---|---|---|---|
| M1 (8-core GPU) | 68 GB/s | 118 | 14.2 |
| M2 / M3 (10-core) | 100 GB/s | 180–187 | 21–22 |
| M4 (10-core) | 120 GB/s | 221 | 24.1 |
| M4 Pro | 273 GB/s | 440 | 50.7 |
| M4 Max | 546 GB/s | 886 | 83.1 |
| M5 Max | 614 GB/s | 3,220 | 119.9 |

The base M5 (MacBook Air, 2026-03-03) has 153 GB/s and starts at 16 GB, configurable to 24 or 32 GB [72][73]. Apple does not document how much unified memory the GPU may wire by default. Metal reports a per-device `recommendedMaxWorkingSetSize` [74]. Secondary write-ups quote roughly two-thirds to three-quarters of RAM; one measured 78% on a 32 GB M2 Max [75].

**Vulkan scoreboard** (community-submitted, llama.cpp repo, Llama 2 7B Q4_0) [71]:

| GPU | Prompt tok/s | Gen tok/s |
|---|---|---|
| RTX 4090 | 9,452 | 188 |
| RTX 5090 | 10,382 | 264 |
| RX 7900 XTX | 3,727 | 183 |
| Intel Iris Xe (i7-1185G7 laptop) | 106 | 5.9 |

**gpt-oss-20b** (llama.cpp guide) [54]: about 221 tok/s on an RTX 4090, and about 30–67 tok/s on an RTX 3060 12 GB with MoE layers offloaded. Devices with under 16 GB VRAM need some MoE layers on the CPU (`--n-cpu-moe`) [54][1].

Memory bandwidth is the main predictor of generation speed [70].

### 4.2 What "acceptable" means for the Agent: per-item cost estimate

These are **estimates**, computed from the cited throughput above. Assumptions: a Bucket call is about 1,500 prompt tokens (instructions plus Bucket definitions plus a truncated email) and about 40 output tokens. llama-bench numbers are best case.

| Machine and model | Per email | 300 emails/day | 10,000-email backfill |
|---|---|---|---|
| Strix Halo, Qwen3.6-35B-A3B [38] | ≈ 1.5 s + 0.7 s ≈ 2 s | ≈ 10 min | ≈ 6 h |
| Strix Halo, Qwen3.6-27B dense [38] | ≈ 4.7 s + 3.3 s ≈ 8 s | ≈ 40 min | ≈ 22 h |
| M1, 7B-class [70] | ≈ 12.7 s + 2.9 s ≈ 16 s (a 4B model is roughly half) | ≈ 80 min | ≈ 2 days |
| 2020 Intel laptop iGPU, 7B-class [71] | ≈ 14 s + 7 s ≈ 21 s | ≈ 105 min | ≈ 2.4 days |

llama-server reuses the KV cache for a shared prompt prefix by default (`cache_prompt`) [1]. Putting fixed instructions first and the email last reduces repeated prefill. Verify this per model architecture. Running parallel slots also raises throughput.

**Conclusion:** live sorting of incoming mail is feasible on every tier above 8 GB. Backfill must be bounded (recent window only), or done by a cheaper first pass such as embeddings plus kNN (section 5) on weak machines.

### 4.3 Hardware tiers

| Tier | Realistic local model | Experience | Recommendation |
|---|---|---|---|
| **8 GB RAM, no discrete GPU** | 1–3 GB models: Qwen3.5-2B, Gemma-4-E2B [61] | Weak tool-use scores: Qwen3.5-2B τ² 48.8 [44], Gemma-4-E2B τ² 24.5 [49]. Competes with the OS, browser and Commander for memory | Default to a cloud key, or a no-LLM mode (rules plus embeddings) |
| **16 GB (x86 laptop iGPU, or Apple 16 GB)** | 3–5 GB models: Qwen3.5-4B, Gemma-4-E4B, Granite-4.2-3B/8B, LFM2.5-8B-A1B [61] | OK for single-shot Bucket and Todo jobs with constrained JSON. Seconds to tens of seconds per item. Long summaries are slow | **Practical floor for a local default** |
| **32 GB unified (Apple) or 32 GB plus iGPU** | 16–22 GB MoE: Gemma-4-26B-A4B (16.9 GB), Qwen3.6-35B-A3B (22.1 GB) [61] | Good. On a 32 GB Mac the default GPU limit may not hold 22 GB (secondary [75]), so prefer the 26B-A4B | Local default. Cloud for heavy synthesis is optional |
| **NVIDIA 8 GB VRAM** | 4–9B Q4 fully on GPU. Larger MoE with `--n-cpu-moe` if system RAM is 32 GB or more [1][54] | Fast for small models | Local default with a 4–9B model |
| **NVIDIA 12–16 GB** | gpt-oss-20b (12.1 GB) [61], 26B-A4B with partial offload | Good | Local default |
| **NVIDIA 24 GB+ / 64 GB+ unified (author)** | Anything up to 35B-A3B Q8, or 27–31B dense | Best local experience | Local only. Cloud as opt-in for hard jobs |

Commander should detect the tier at first run (RAM, GPU, Vulkan/Metal/CUDA availability) and run a short micro-benchmark with a real Agent prompt before picking a default.

### 4.4 When to fall back to a cloud API key

Fall back, per job and opt-in, when any of these hold:

1. The machine is below the 16 GB floor, or the micro-benchmark misses a latency budget.
2. The job needs multi-turn, multi-tool autonomy. That is where local models trail most: BFCL multi-turn 41.8% for Qwen3-8B against 68.4% for Claude Opus 4.5 [63].
3. The input is very long (an org-wide GitHub digest) and local prefill would exceed the budget.
4. The local result is low-confidence. Escalate only those items (hybrid), using the probabilities from 3.3.
5. The User prefers cloud.

Hard constraints on fallback:

- Content leaves the machine.
  - Anthropic says it does not, by default, use API inputs or outputs to train its models [76].
  - OpenAI says API data "is not used to train or improve OpenAI models (unless you explicitly opt in)", and keeps abuse-monitoring logs "for up to 30 days" [77].
- For Gmail data, Google's Limited Use rules allow transfers to third parties only "to provide or improve … user-facing features that are visible and prominent in the requesting application's user interface and only with the user's consent" [78].
- Google's Workspace policy (updated 2026-09-03) forbids using user data "to create, train, or improve a machine learning or artificial intelligence model beyond that specific user's personalized model" [79].

Cloud fallback for email must therefore be a visible, consented feature. Per-user learning, such as a Bucket classifier trained on one User's own corrections, stays within the "personalized model" carve-out [79].

## 5. Local embedding models for search

**Is it useful?** Yes, on four counts:

- Hybrid search across email, Daily Notes, Todos, Linear and GitHub (vectors plus SQLite FTS5 keyword search [84]).
- Linking a suggested Todo to an existing Linear issue or duplicate Todo.
- A cheap per-User Bucket classifier (kNN over the User's corrected examples) as a first pass before the LLM.
- Retrieval for "what's happening with X" summaries.

Embedding models are 0.1–0.6B parameters, well over 10× smaller than the chat models above. That is arithmetic from parameter counts; no throughput figure was measured here.

| Model | Params | Dims | Max input | License | Reported quality |
|---|---|---|---|---|---|
| **Qwen3-Embedding-0.6B** | 0.6B | up to 1,024 (MRL) | 32K | Apache-2.0 | MTEB multilingual 64.33, English v2 70.70. Instruction-aware (+1–5%) [80] |
| **granite-embedding-311m-multilingual-r2** (2026-04-29) | 311M | 768 | 32,768 | Apache-2.0 | Multilingual MTEB retrieval 65.2. ONNX, OpenVINO, llama.cpp [81] |
| granite-embedding-97m-multilingual-r2 | 97M | — | — | Apache-2.0 | Tiny option [82] |
| **EmbeddingGemma-300M** (2025-09-04) | 308M | 768, truncatable to 512/256/128 | 2,048 | **Gemma terms** (not Apache) | MTEB multilingual 61.15, English 69.67, code 68.76. QAT Q4/Q8 checkpoints [85][47] |
| jina-embeddings-v5-text-nano/small (2026-01) | 212M / 596M | — | — | **CC-BY-NC-4.0**, so unusable if monetized | — [82] |

**Runtimes.** llama-server with `--embedding`, `--pooling` and `/v1/embeddings`, plus `--rerank` [1]. Ollama's embeddings API [86]. LM Studio `/v1/embeddings` [19]. Or ONNX in process.

**Storage.**

- `sqlite-vec` is Apache-2.0 and pure C, and runs "anywhere SQLite runs". It is "pre-v1, so expect breaking changes" [83].
- The latest stable release is v0.1.9 (2026-03-31). ANN indexes (IVF and DiskANN) exist only in the v0.1.10 alphas (latest 2026-05-18) [83].
- Brute-force KNN is fine at personal scale (estimate): 200k items × 768 dims × 4 bytes ≈ 614 MB as float32, ≈ 154 MB as int8, ≈ 19 MB as binary vectors, all supported types [83].
- Store the model id and dimension with each vector so a model change triggers re-embedding.

## Implications for the decisions

### #12 Tech stack and local database

- **AI boundary: one provider-agnostic HTTP client** speaking OpenAI-compatible chat completions (with `response_format: json_schema`, tools and logprobs) and `/v1/embeddings`. This reaches llama-server, Ollama, LM Studio, Lemonade and Docker Model Runner, and cloud providers [1][13][19][23][29]. Do not bind to Ollama's or LM Studio's native APIs for core jobs.
- **Runtime packaging:**
  - For v1 on the author's machine, use a configurable base URL pointing at an external server: Ollama from Arch's `ollama-vulkan`/`ollama-rocm` [37], or a llama.cpp build.
  - Keep "bundle `llama-server` as a sidecar" as the tester path. Vulkan and Metal builds are about 11–30 MiB [4], and Tauri supports sidecars natively [28].
  - In-process node-llama-cpp is viable only if the shell is Node or Electron, and it lacks ROCm [26][27].
  - LM Studio can never be bundled [17].
- **Process model:** the Agent is a background worker with a durable job queue. Items take 1–20 s each locally (section 4.2), and the runtime should release memory when idle (`--sleep-idle-seconds` [1]; Ollama unloads after 5 minutes by default [10]).
- **Local database:** SQLite with FTS5 [84] plus `sqlite-vec` [83] covers search. Pin the `sqlite-vec` version, because it is pre-v1 and ANN is alpha.
- **Machine setup outside the app (author):** raise the GTT/TTM limit with `amd-ttm` [33]. Decide Vulkan (default) versus ROCm 10 per model after a quick benchmark. Arch's ROCm is 7.2.4 [37], and AMD supports gfx1151 only on Ubuntu [31].

### #16 Email Buckets

- **Shape:** one schema-constrained call per email, thinking off. Output: Bucket id from an enum, a short reason, optional extracted fields. Bucket definitions in a fixed prompt prefix. Few-shot examples from the User's own corrections.
- **Confidence:** take probabilities from logprobs (`n_probs` [1]), or from Ollama's new decision-model API [14]. Map them to the Autonomy setting: high confidence acts, middle proposes, low leaves the email in the inbox or escalates to the cloud if opted in.
- **Keep the Bucket count small and the descriptions explicit.** Zero-shot accuracy of 9B-and-under models on many-label tasks is mediocre [66].
- **Learning:** an embeddings kNN classifier over the User's corrected examples is cheap, private, and inside Google's "personalized model" carve-out [79]. Use it as a first pass, or as a tie-breaker.
- **Safety:** treat email as untrusted. The classification call gets no tools, its output is limited to the enum, and Agent side effects (labels and moves that two-way sync writes back to the Source) go through the Autonomy setting [69]. At least two current local models followed an embedded injection in an independent test [38].
- **Backfill:** bound LLM sorting to a recent window. 10k emails takes about 6 h on Strix Halo and days on a 16 GB laptop (section 4.2).
- **Before choosing a model,** build a labelled eval set of about 200–500 of the author's own emails. No public benchmark matches this job.

### #19 Agent jobs and model choice

- **Default model on the author's machine:** Qwen3.6-35B-A3B (22 GB Q4, about 60 tok/s, about 1,000 tok/s prefill) or Gemma-4-26B-A4B (17 GB Q4, about 53 tok/s, about 1,200 tok/s prefill) [38][61]. Pick between them on the eval set.
  - For quality-sensitive summaries, a dense 27–31B model (Qwen3.6-27B, Qwen3.8-27B, Gemma-4-31B, Muse Glimmer 30B) with MTP, at about 21–25 tok/s [38].
  - An embedding model alongside: Qwen3-Embedding-0.6B or granite-embedding-311m-r2.
- **Defaults for testers by tier** (section 4.3): 4B-class at 16 GB, 26B/35B MoE at 32 GB and up, cloud or no-LLM at 8 GB.
- **Job design:**
  - Single-shot, schema-constrained calls with thinking off for Buckets, Todo extraction and event-candidate extraction.
  - Chunked map-reduce for GitHub summaries.
  - Deterministic code for dates, timezones, free/busy, dedupe and slot-finding.
  - No long autonomous tool loops on local models [63][67][68].
- **Licensing filter, given possible monetization:** prefer Apache-2.0 models (Qwen3.5/3.6/3.8, Gemma 4, gpt-oss, Granite, Ministral, Muse Glimmer). Avoid LFM2.5 (revenue cap [58]), jina v5 (non-commercial [82]) and possibly EmbeddingGemma (Gemma terms [85]).
- **Make the model a setting, not a constant.** Qwen shipped three generations in six months [41], and llama.cpp keeps fixing per-model chat-template and tool parsers (v0.5.0 lists Gemma 4 and qwen3-coder parser fixes [5]). Pin model files by hash and re-run the eval set on any swap.
- **Cloud fallback** per job and opt-in, for the cases in 4.4.

## Not fully answered

- **No direct benchmark** of local models on email Bucket sorting, Todo extraction, GitHub summaries or calendar proposals. Only proxies exist (section 3). An eval on the author's data is needed.
- **Current-generation throughput on typical 16 GB x86 laptops** (Intel Lunar Lake or AMD Strix Point iGPUs, CPU-only) was not found in primary or current sources. Section 4 extrapolates from older 7B data [70][71] and bandwidth.
- **gpt-oss-20b throughput on Strix Halo** was not found in current sources.
- **Apple's default GPU memory cap** is not documented by Apple. Only secondary measurements exist [75].
- **ROCm 10 on Arch with gfx1151** is untested here. AMD supports Ubuntu only [31].

## Sources

Runtimes

1. llama.cpp `llama-server` README (flags, OpenAI/Anthropic endpoints, `response_format`, `n_probs`, `cache_prompt`, `--sleep-idle-seconds`, `--fit`, `--n-cpu-moe`, embeddings/rerank): https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md
2. llama.cpp function calling doc: https://github.com/ggml-org/llama.cpp/blob/master/docs/function-calling.md
3. llama.cpp build doc (Vulkan, HIP, UMA env var): https://github.com/ggml-org/llama.cpp/blob/master/docs/build.md
4. llama.cpp build b11317 assets and sizes (2026-10-01): https://github.com/ggml-org/llama.cpp/releases/tag/b11317
5. llama.cpp v0.5.0 release notes (2026-09-23) and release list: https://github.com/ggml-org/llama.cpp/releases/tag/v0.5.0
6. llama.cpp release workflow (ROCm 10.0.0 wheels, `gfx1151` in targets): https://github.com/ggml-org/llama.cpp/blob/master/.github/workflows/release.yml
7. Ollama hardware support: https://docs.ollama.com/gpu
8. Ollama structured outputs: https://docs.ollama.com/capabilities/structured-outputs
9. Ollama tool calling: https://docs.ollama.com/capabilities/tool-calling
10. Ollama FAQ (keep_alive, binding, privacy): https://docs.ollama.com/faq
11. Ollama context length defaults: https://docs.ollama.com/context-length
12. Ollama on Linux: https://docs.ollama.com/linux
13. Ollama Anthropic compatibility: https://docs.ollama.com/api/anthropic-compatibility
14. Ollama v0.35.0 (decision models, 2026-09-28): https://github.com/ollama/ollama/releases/tag/v0.35.0
15. Ollama v0.40.0-rc0 (MLX default on Apple Silicon, pre-release, 2026-09-25): https://github.com/ollama/ollama/releases/tag/v0.40.0-rc0
16. Ollama v0.34.4 (structured outputs on thinking models; updated llama.cpp/MLX/XGrammar): https://github.com/ollama/ollama/releases/tag/v0.34.4
17. LM Studio app terms (version 2026-08-23): https://lmstudio.ai/app-terms
18. LM Studio system requirements: https://lmstudio.ai/docs/app/system-requirements
19. LM Studio local server/API: https://lmstudio.ai/docs/developer/core/server
20. LM Studio structured output: https://lmstudio.ai/docs/developer/openai-compat/structured-output
21. LM Studio headless (llmster): https://lmstudio.ai/docs/developer/core/headless
22. vLLM GPU installation (ROCm): https://docs.vllm.ai/en/latest/getting_started/installation/gpu.html
23. Lemonade Server: https://github.com/lemonade-sdk/lemonade
24. FastFlowLM: https://github.com/FastFlowLM/FastFlowLM
25. node-llama-cpp guide: https://node-llama-cpp.withcat.ai/guide/
26. node-llama-cpp in Electron: https://node-llama-cpp.withcat.ai/guide/electron
27. node-llama-cpp on npm (v3.22.1, prebuilt packages): https://www.npmjs.com/package/node-llama-cpp
28. Tauri 2 sidecars: https://v2.tauri.app/develop/sidecar/
29. Docker Model Runner: https://docs.docker.com/ai/model-runner/

AMD / Strix Halo / platform

30. AMD Ryzen AI Max+ 395 product page: https://www.amd.com/en/products/processors/laptop/ryzen/ai-300-series/amd-ryzen-ai-max-plus-395.html
31. ROCm 10.0.0 compatibility matrix: https://rocm.docs.amd.com/en/latest/compatibility/compatibility-matrix.html
32. ROCm 10.0.0 release notes: https://rocm.docs.amd.com/en/latest/about/release-notes.html
33. AMD Strix Halo system optimization (ROCm 10.0.0 docs): https://rocm.docs.amd.com/en/latest/how-to/system-optimization/strixhalo.html
34. ROCm on Radeon and Ryzen, Linux support matrix (7.2.1): https://rocm.docs.amd.com/projects/radeon-ryzen/en/latest/docs/compatibility/compatibilityryz/native_linux/native_linux_compatibility.html
35. Linux kernel amdgpu module parameters: https://docs.kernel.org/gpu/amdgpu/module-parameters.html
36. AMDVLK repository (discontinuation notice): https://github.com/GPUOpen-Drivers/AMDVLK
37. Arch Linux packages: https://archlinux.org/packages/extra/x86_64/rocm-hip-runtime/ , https://archlinux.org/packages/extra/x86_64/ollama-vulkan/ , https://archlinux.org/packages/extra/x86_64/ollama-rocm/ , https://archlinux.org/packages/extra/x86_64/vulkan-radeon/
38. **(secondary)** Strix Benchmarks, independent tester, 128 GB Ryzen AI Max+ 395, updated August–September 2026: https://slb350.github.io/strix-benchmarks/ (methodology: https://slb350.github.io/strix-benchmarks/methodology/)
39. **(secondary)** "llama.cpp: Vulkan vs ROCm on Strix Halo", 2026-08-03: https://www.soothill.io/blog/2026/08/03/llamacpp-vulkan-vs-rocm-strix-halo/
40. **(secondary)** llm-tracker Strix Halo notes (August 2025, stale): https://llm-tracker.info/_TOORG/Strix-Halo

Models

41. Qwen release timeline (QwenLM/Qwen3.8 README): https://github.com/QwenLM/Qwen3.8
42. Qwen3.5-35B-A3B model card: https://huggingface.co/Qwen/Qwen3.5-35B-A3B
43. Qwen3.5-9B model card: https://huggingface.co/Qwen/Qwen3.5-9B
44. Qwen3.5-2B model card: https://huggingface.co/Qwen/Qwen3.5-2B
45. Qwen3.6-35B-A3B model card: https://huggingface.co/Qwen/Qwen3.6-35B-A3B
46. Qwen3.8-27B model card: https://huggingface.co/Qwen/Qwen3.8-27B
47. Gemma releases: https://ai.google.dev/gemma/docs/releases
48. Gemma 4 announcement: https://blog.google/innovation-and-ai/technology/developers-tools/gemma-4/
49. Gemma 4 model card (benchmarks incl. Tau2): https://ai.google.dev/gemma/docs/core/model_card_4
50. Gemma 4 26B-A4B model card: https://huggingface.co/google/gemma-4-26B-A4B-it
51. gpt-oss-20b model card: https://huggingface.co/openai/gpt-oss-20b
52. gpt-oss model card PDF (2025-08-05; Table 3): https://cdn.openai.com/pdf/419b6906-9da6-406c-a19d-1bb078ac7637/oai_gpt-oss_model_card.pdf
53. OpenAI on Hugging Face (model list): https://huggingface.co/openai
54. llama.cpp guide: running gpt-oss (memory, performance): https://github.com/ggml-org/llama.cpp/discussions/15396
55. Granite 4.2 3B model card: https://huggingface.co/ibm-granite/granite-4.2-3b
56. Mistral 3 announcement (Ministral 3, 2025-12-02): https://mistral.ai/news/mistral-3
57. LFM2.5-8B-A1B model card: https://huggingface.co/LiquidAI/LFM2.5-8B-A1B
58. LFM Open License v1.0: https://www.liquid.ai/lfm-license
59. Ministral 3 8B model card: https://huggingface.co/mistralai/Ministral-3-8B-Instruct-2512
60. Muse Glimmer 30B model card: https://huggingface.co/meta-models/Muse-Glimmer-30B
61. Hugging Face file listings (GGUF sizes), via the Hub API: https://huggingface.co/ggml-org/gpt-oss-120b-GGUF , https://huggingface.co/ggml-org/gpt-oss-20b-GGUF , https://huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF , https://huggingface.co/unsloth/Qwen3.6-27B-GGUF , https://huggingface.co/unsloth/Qwen3.8-27B-GGUF , https://huggingface.co/unsloth/Qwen3.5-9B-GGUF , https://huggingface.co/unsloth/Qwen3.5-4B-GGUF , https://huggingface.co/unsloth/Qwen3.5-2B-GGUF , https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF , https://huggingface.co/unsloth/Qwen3.5-122B-A10B-GGUF , https://huggingface.co/unsloth/gemma-4-26B-A4B-it-GGUF , https://huggingface.co/unsloth/gemma-4-31B-it-GGUF , https://huggingface.co/unsloth/gemma-4-E4B-it-GGUF , https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF , https://huggingface.co/LiquidAI/LFM2.5-8B-A1B-GGUF , https://huggingface.co/ibm-granite/granite-4.2-8b-GGUF , https://huggingface.co/unsloth/Ministral-3-8B-Instruct-2512-GGUF , https://huggingface.co/meta-models/Muse-Glimmer-30B-GGUF , https://huggingface.co/Qwen/Qwen3.8-Flash-Next
62. Mistral Small 4 announcement (2026-03-16): https://mistral.ai/news/mistral-small-4

Quality evidence

63. Berkeley Function Calling Leaderboard V4 (last updated 2026-04-12), page and data: https://gorilla.cs.berkeley.edu/leaderboard.html , https://gorilla.cs.berkeley.edu/data_overall.csv
64. JSONSchemaBench (arXiv 2501.10868, January 2025): https://arxiv.org/abs/2501.10868
65. LLMStructBench (arXiv 2602.14743, February 2026): https://arxiv.org/abs/2602.14743
66. "Selecting Open-Weight Language Models for Zero-Shot Intent Classification" (arXiv 2607.27421, 2026-07-29): https://arxiv.org/abs/2607.27421
67. EmailBench (arXiv 2609.31906, 2026-09-25): https://arxiv.org/abs/2609.31906
68. SCHEDBench (arXiv 2608.00991v2, 2026-08-26): https://arxiv.org/abs/2608.00991
69. OWASP Top 10 for LLM Applications, LLM01 Prompt Injection: https://genai.owasp.org/llmrisk/llm01-prompt-injection/

Hardware

70. llama.cpp discussion #4167, Apple Silicon performance (community-submitted): https://github.com/ggml-org/llama.cpp/discussions/4167
71. llama.cpp discussion #10879, Vulkan scoreboard (community-submitted): https://github.com/ggml-org/llama.cpp/discussions/10879
72. Apple newsroom: MacBook Air with M5 (2026-03-03): https://www.apple.com/newsroom/2026/03/apple-introduces-the-new-macbook-air-with-m5/
73. Apple: MacBook Air (13-inch, M5) tech specs: https://support.apple.com/en-us/126320
74. Apple Metal `recommendedMaxWorkingSetSize`: https://developer.apple.com/documentation/metal/mtldevice/recommendedmaxworkingsetsize
75. **(secondary)** "iogpu.wired_limit_mb on Mac" (2026-08-15): https://modelpiper.com/blog/iogpu-wired-limit-mb-mac

Cloud and data policy

76. Anthropic Privacy Center, "Is my data used for model training?": https://privacy.claude.com/en/articles/7996868-is-my-data-used-for-model-training
77. OpenAI, data controls in the OpenAI platform: https://developers.openai.com/api/docs/guides/your-data
78. Google API Services User Data Policy (Limited Use): https://developers.google.com/terms/api-services-user-data-policy
79. Google Workspace User Data and Developer Policy (updated 2026-09-03): https://developers.google.com/workspace/workspace-api-user-data-developer-policy

Embeddings and storage

80. Qwen3-Embedding-0.6B model card: https://huggingface.co/Qwen/Qwen3-Embedding-0.6B
81. granite-embedding-311m-multilingual-r2 model card: https://huggingface.co/ibm-granite/granite-embedding-311m-multilingual-r2
82. Hugging Face model metadata (licenses, parameter counts): https://huggingface.co/ibm-granite/granite-embedding-97m-multilingual-r2 , https://huggingface.co/jinaai/jina-embeddings-v5-text-small , https://huggingface.co/jinaai/jina-embeddings-v5-text-nano
83. sqlite-vec README, releases v0.1.9 (2026-03-31) and v0.1.10-alpha.4 (2026-05-18): https://github.com/asg017/sqlite-vec , https://github.com/asg017/sqlite-vec/releases
84. SQLite FTS5: https://www.sqlite.org/fts5.html
85. EmbeddingGemma-300M model card: https://huggingface.co/google/embeddinggemma-300m
86. Ollama embeddings: https://docs.ollama.com/capabilities/embeddings
87. Ollama thinking: https://docs.ollama.com/capabilities/thinking
88. Repository licenses (GitHub API `license.spdx_id`, checked 2026-10-01): Ollama MIT https://github.com/ollama/ollama , vLLM Apache-2.0 https://github.com/vllm-project/vllm , Lemonade Apache-2.0 https://github.com/lemonade-sdk/lemonade , node-llama-cpp MIT https://github.com/withcatai/node-llama-cpp , FastFlowLM MIT https://github.com/FastFlowLM/FastFlowLM , llama.cpp MIT https://github.com/ggml-org/llama.cpp
