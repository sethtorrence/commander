# Research: Z.ai GLM-5.3-Flash

Researched 2026-10-01 for [issue #27](https://github.com/sethtorrence/commander/issues/27). Every claim cites a source; numbers are in the Sources list at the end.

## Question

Commander will be built with Z.ai's GLM-5.3-Flash as its model for now. What do Z.ai's API terms and the model itself mean for Commander? The sub-questions are data terms, Google Limited Use, the model's capabilities and price, a local option, and the licence.

## Short answer

- **The model exists under that exact name.** The API model codes are `glm-5.3-flash` and `glm-5.3-flashx` [1][3]. Open weights are on Hugging Face as `zai-org/GLM-5.3-Flash` under the MIT licence [5][6].
- **Data terms.** For API customers, Z.ai says it will not use End User Content to develop or improve its services unless you explicitly agree [8]. Its DPA says API content "is not saved on our servers" [9]. However, its own FAQ says part of each request "may be cached on our cloud platform", and that how long cached content is kept "has not yet been announced" [11]. Caching is automatic, and the docs show no way to turn it off [12]. Data is processed "generally" in Singapore [9]. There is no documented zero-retention option.
- **Google Limited Use.** The no-training part is met on paper. The no-retention part ("not be stored in conjunction with" a foundational model [14]) is not clearly met, because of the undisclosed cache retention. It is not safe to rely on this for Gmail data without written confirmation from Z.ai.
- **The model.** Context is 1M tokens and max output is 128K. It supports tool calling (up to 128 functions, `tool_choice: auto` only) and JSON mode via `response_format: json_object`; there is no JSON-schema mode. The endpoint is OpenAI-compatible at `https://api.z.ai/api/paas/v4/`. Price is $0.15 per 1M input tokens, $0.03 cached and $0.50 output; FlashX costs $0.37 / $0.075 / $1.25. GLM-5.3-Flash has **no free tier**; only the older GLM-4.7-Flash, GLM-4.5-Flash and GLM-4.6V-Flash are free [2]. Rate limits are not public; they are shown per account in the console [4b][11]. Thinking cannot be turned off [1].
- **Local option.** The weights are open, and llama.cpp support was merged on 2026-09-30 [16]. But the model has 320B total parameters, and the smallest Unsloth GGUF is 86.7 GiB [18]. That is above the author's 64 GB total memory, so **it cannot run locally on the Strix Halo machine**.
- **Licence.** The weights are under plain MIT, which allows commercial use and sale [6]. The **API** terms add real limits for a product that may be sold: the Agent must not make "decisions", AI output must be labelled, using Z.ai's name in marketing needs consent, and export needs consent [7][8].

## Data terms: training, retention, review, location

**Which terms apply.** The Privacy Policy covers individual users of Z.ai's chat services. It sends "enterprises or developers using the API Services" to the Data Processing Addendum (DPA) instead [9]. The Terms of Use (last updated 2026-04-14) add "Additional Terms for API Services", which win over the general Terms where the two conflict [7][8].

**Training.** Additional Terms §3(b) says: "We will only use End User Content as necessary to provide you with the API Services, comply with applicable law, enforce our policies, and prevent abuse. [We will not use End User Content to develop or improve Services, unless you explicitly agree to such use.]" [8]. The square brackets are in the published text, which looks like a drafting leftover. The main Terms IV.7 repeats the promise in bold: API content is not used "unless you explicitly agree" [7]. Note that the *individual-user* clause (IV.3(a)) does allow training on non-personal User Content [7]. Commander must therefore use API keys, not the consumer chat product.

**Retention.**
- DPA §4(b): "The Company do not store any of the content the Customer or its End Users provide or generate while using our Services ... processed in real-time ... and is not saved on our servers." [9]
- This conflicts with the Help FAQ: "A part of your request content may be cached on our cloud platform". Its retention rules, "including ... how long cached content is retained", "ha[ve] not yet been announced" [11].
- The Context Caching guide describes caching as "Implicit caching ... without manual configuration" [12]. The pricing page lists "Cached Input Storage" as "Limited-time Free" [2], which implies the cache is stored. None of these pages offers a way to turn caching off.
- DPA §4(c): other Customer Data (account and billing data, for example) is stored "temporarily" and deleted after the Terms end, unless the law requires otherwise [9].

**Human review.** No clause promises that no human will ever review content. Content may be used to "enforce our policies, and prevent abuse" [8], and Z.ai may "review your registration information and service usage" (Terms XII.8) [7]. The API can also end a response with `finish_reason: "sensitive"`, which means content filtering is applied [3].

**Location.** "Company generally provide the Services from Singapore ... Customer Data is generally processed in Singapore." Transfers abroad happen only under "legally recognized transfer mechanisms" [9]. The contracting entity is JINGSHENG HENGXING TECHNOLOGY PTE. LTD (Singapore), and the Terms are governed by Singapore law with SIAC arbitration [7][10].

**Zero-retention option.** None is documented. The docs index has no enterprise, retention or ZDR page [15], and no contract tier with ZDR is advertised. The only path is to ask Z.ai sales for a written commitment.

## Google Limited Use

**Google's requirements.**
- The Workspace API User Data and Developer Policy forbids "using user data to create, train, or improve a machine learning or artificial intelligence model beyond that specific user's personalized model" [13a].
- Google's OAuth FAQ adds: "Google User Data may not be used to train or improve foundational or frontier models or be stored in conjunction with such models". It defines a personalized model as one "run exclusively on-device or ... specifically tailored to only that end user" [14].
- Transfers to third parties are allowed only "to provide or improve user-facing features ... with the user's consent", or for security and legal reasons [13].
- Humans must not read the data, except with the user's affirmative agreement or for security, legal or aggregated-operations reasons [13].

**Do Z.ai's API terms meet this?**
- **No training: yes, on paper.** Additional Terms §3(b) and Terms IV.7 say there is no training unless you explicitly agree [7][8]. Commander must never opt in.
- **No retention or storage alongside the model: unclear.** The DPA says nothing is stored [9], but the FAQ says request content may be cached for an undisclosed time, with no opt-out [11][12]. Google bars data being "stored in conjunction with" a foundational model [14], and GLM-5.3-Flash served by Z.ai is a shared foundational model, not a personalized one. A cache of Gmail content with no stated time limit is the kind of storage Google is worried about.
- **Human review: probably acceptable.** Z.ai's abuse handling [8] falls under Google's "security purposes (for example, investigating abuse)" exception [13].

**What Commander would need:**
1. **The best fix within this choice of model:** run Gmail jobs on a model that counts as "personalized", meaning one that runs on-device [14]. GLM-5.3-Flash cannot run on the author's machine (see Local option), so this would have to be a different, smaller local model.
2. **Or** get written confirmation from Z.ai covering how long the prompt cache keeps data, a cache opt-out, and a no-retention commitment, and keep it as evidence for Google's OAuth verification and security assessment [13][14].
3. **Or** send Gmail jobs to a different cloud provider whose published terms promise no training and offer contractual zero retention. That needs its own research ticket.

Outlook, calendar, GitHub and Linear data are not covered by Google's policy. For those, only Z.ai's own terms apply.

## The model

| Property | Value | Source |
| :- | :- | :- |
| Model codes | `glm-5.3-flash`, `glm-5.3-flashx` (FlashX is about 200 tok/s) | [1][3] |
| Architecture | 320B total, 18B active MoE; 34 linear-attention (KDA) layers and 11 sparse-attention (DSA) layers | [1][5][16] |
| Context | 1M tokens (`max_position_embeddings: 1048576`) | [1][5a] |
| Max output | 128K (`max_tokens` up to 131072) | [1][3] |
| Input | text, image, video, file; output is text | [1] |
| Thinking | `thinking.type` must be `enabled`; "thinking cannot be disabled". `reasoning_effort` can be `low` / `high` / `max` (default `max`) | [1][3] |
| Tool calling | Yes. Up to 128 functions; `tool_choice` accepts only `auto`; `tool_stream` is recommended | [1][3] |
| Structured output | JSON mode, `response_format: {"type": "json_object"}`. There is no `json_schema` / strict-schema mode | [3][1b] |
| Endpoint | `https://api.z.ai/api/paas/v4` (Bearer key). OpenAI SDK works with `base_url="https://api.z.ai/api/paas/v4/"`; Z.ai notes "some scenarios" differ | [4][4a] |
| Price (per 1M tokens) | Flash: $0.15 input, $0.03 cached input, $0.50 output. FlashX: $0.37 / $0.075 / $1.25. Cache storage "Limited-time Free" | [2] |
| Free tier | **None for GLM-5.3-Flash.** Free models: GLM-4.7-Flash, GLM-4.5-Flash (text) and GLM-4.6V-Flash (vision) | [2] |
| Rate limits | Not published. "You can check the rate limits from here: https://z.ai/manage-apikey/rate-limits" (requires login) | [11][4b] |
| GLM Coding Plan | Includes GLM-5.3-Flash, but "can only make calls via the plan's quota in supported tools". **Commander cannot use it** | [1][4c] |

**Documentation inconsistencies:**
- The API reference places `glm-5.3-flash` under the "Vision Model" request schema. That schema has no `response_format` or `tool_stream` field, and says `response_format` is supported by "Only text models". Yet the model page lists structured output and recommends `tool_stream` [1][3].
- The same vision schema lists only user, system and assistant messages, with no `tool` role. Multi-turn tool calling (sending tool results back) needs a live test.
- OpenRouter lists a different price ($0.02 input / $0.2475 output) [19]. That is a third-party reseller price, not Z.ai's.

**Cost sketch (illustrative, not a quote):** Sorting 1,000 emails a day at about 3K input tokens and 1K output tokens each (thinking always adds output) works out to 3M × $0.15 + 1M × $0.50, roughly **$0.95/day**, before cache discounts [2].

## Local option

- **Weights are open.** `zai-org/GLM-5.3-Flash` is MIT-licensed [6]. It holds 321.3B parameters (mostly FP8), and the safetensors total 328 GB [5b].
- **llama.cpp support:** PR #27773, "add GLM-5.3-Flash (GLM5-Next) support", was merged on **2026-09-30** [16]. It is very new. Open issues include RPC, CUDA and CPU bugs, and multi-token prediction is still in a separate PR [17].
- **GGUF sizes** (Unsloth [18]): UD-IQ1_S is 86.7 GiB, UD-IQ1_M 90.9, UD-IQ2_XXS 94.9, UD-Q2_K_XL 101.3, UD-Q4_K_XL 186.0 and Q8_0 317.6 GiB. A third-party 50%-pruned "REAP50" variant is still at least 67.2 GiB (IQ3_M) [18a].
- **The author's machine:** about 64 GB of unified memory, of which about 33 GiB is usable by the GPU through Vulkan. Even the smallest 1-bit quant (86.7 GiB) is larger than *total* system memory, before counting the KV cache and the OS. **GLM-5.3-Flash cannot be the local-first model on this machine.** Running it would need about 96 GB of memory at minimum for heavily degraded 1–2-bit quants, and realistically 128 GB or more.
- Not checked: whether llama.cpp's Vulkan backend handles every new op (KDA, DSA indexer, mHC). This is moot given the size problem.

So "the same model in the cloud now, local later" does not work on this hardware. A local-first path needs a different, smaller model, or much more memory.

## Licence

**Weights (MIT) [6].** MIT allows use, modification, distribution, sublicensing and **sale**, provided the copyright notice is kept. The weights carry no use restrictions, unlike some other "open" model licences.

**API Terms (these apply while Commander calls Z.ai's API) [7][8]:**
- Integrating the API into your own apps for End Users is allowed (Additional Terms §1(a)). You must set up agreements with End Users and manage their use (§1(b)).
- **No "decision-making activities"** (Additional Terms §1(f)(iv), and Terms III.6(a) on high-risk automated decisions). This sits awkwardly with the Agent's "Auto" Autonomy level and the "Act for you" / "Delete" Action kinds. "Decision-making" is not defined.
- **AI output must be "prominently marked"** as AI-generated, and logs must be kept as the law requires (Terms III.5(d)). You must also disclose truthfully that Z.ai models are used (§1(d)).
- **No use of Z.ai's names or marks**, even "mention", in marketing without written consent (Terms V.2). "Powered by GLM" needs permission.
- **Export:** "you may not directly or indirectly export Z.ai products or any technology containing Z.ai products without ... the explicit prior consent of the Z.ai team" (Terms XIII §2). This is broad and unclear for a downloadable desktop app sold abroad.
- No training of competing models on outputs (§1(f)(xii)). There is a US-only bar on PHI, GLBA NPI and ITAR/EAR data (Terms III.11). No use for services requiring professional qualifications (finance, legal, medical and similar) (§1(f)(iii)).
- Governed by Singapore law, with SIAC arbitration [7].

**Corporate background (risk only, not legal advice).** The US Commerce Department added "Beijing Zhipu Huazhang Technology Co., Ltd." and affiliates to the Entity List on 2025-01-16 [20]. Z.ai is widely reported to be Zhipu's international brand, but Z.ai's own legal pages name only a Singapore entity [7][9]. Whether paying for, or redistributing, Z.ai services or weights creates US export-control exposure for a product sold later has not been checked here. It needs a lawyer.

## Implications for Commander

1. **Do not send Gmail content to the Z.ai API yet.** No-training is promised, but the undisclosed retention of the automatic prompt cache conflicts with Google's "not stored in conjunction with" rule. Either get written cache/ZDR terms from Z.ai, or send Gmail jobs to a local model or a ZDR provider. Outlook, calendar, GitHub and Linear jobs can use Z.ai under its no-training API terms.
2. **Put the model behind a per-Source routing seam** (for example, the Agent picks a provider per Source or job type), so that Gmail can go to a different backend without changing the rest.
3. **Use pay-as-you-go API keys, not the GLM Coding Plan or consumer chat.** The Coding Plan is limited to approved tools, and the consumer terms allow training.
4. **Design for JSON mode without schemas and for thinking that is always on.** Validate every structured reply (Bucket assignments, Todos) on Commander's side and retry when invalid. Set `reasoning_effort: low` for cheap sorting jobs, and budget for the extra thinking tokens.
5. **Make a live test the first spike.** Confirm `response_format` and `tool` role messages with `glm-5.3-flash` (the docs contradict each other), and read the account's actual rate limits in the console.
6. **Local-first needs a different model.** GLM-5.3-Flash (smallest GGUF 86.7 GiB) cannot fit in 64 GB. Pick a local model sized for about 33 GiB of GPU memory, separately.
7. **Before selling:** label AI output in the UI, avoid marketing that names Z.ai/GLM unless permission is given, get legal review of the "no decision-making" and export clauses against the Agent's Auto Autonomy level, and look at Entity List exposure.

## Sources

1. Z.ai docs, GLM-5.3-Flash/FlashX model page: https://docs.z.ai/guides/llm/glm-5.3-flash (also served at https://docs.z.ai/guides/vlm/glm-5.3-flash)
   1b. Z.ai docs, Structured Output: https://docs.z.ai/guides/capabilities/struct-output
2. Z.ai docs, Pricing: https://docs.z.ai/guides/overview/pricing
3. Z.ai API reference, Chat Completion: https://docs.z.ai/api-reference/llm/chat-completion
4. Z.ai API reference, Introduction (endpoint, auth): https://docs.z.ai/api-reference/introduction
   4a. Z.ai docs, OpenAI Python SDK: https://docs.z.ai/guides/develop/openai/python
   4b. Z.ai docs, Rate Limits (redirects to the login-gated https://z.ai/manage-apikey/rate-limits): https://docs.z.ai/api-reference/rate-limit
   4c. Z.ai docs, GLM Coding Plan FAQ and Usage Policy: https://docs.z.ai/devpack/faq , https://docs.z.ai/devpack/usage-policy
5. Hugging Face model card: https://huggingface.co/zai-org/GLM-5.3-Flash
   5a. config.json: https://huggingface.co/zai-org/GLM-5.3-Flash/blob/main/config.json
   5b. Hugging Face API metadata (parameter counts, file sizes): https://huggingface.co/api/models/zai-org/GLM-5.3-Flash
6. LICENSE (MIT, Copyright (c) 2026 Z.AI Co., Ltd): https://huggingface.co/zai-org/GLM-5.3-Flash/blob/main/LICENSE
7. Z.ai Terms of Use (last update 2026-04-14): https://docs.z.ai/legal-agreement/terms-of-use
8. Z.ai Additional Terms for API Services (same page, section "Additional Terms for API Services"): https://docs.z.ai/legal-agreement/terms-of-use
9. Z.ai Privacy Policy and Data Processing Addendum for API Services (last update 2025-09-29): https://docs.z.ai/legal-agreement/privacy-policy
10. Z.ai Subscriptions, Fees, and Payment: https://docs.z.ai/legal-agreement/subscription-terms
11. Z.ai Help FAQ (caching retention, rate limits): https://docs.z.ai/help/faq
12. Z.ai docs, Context Caching: https://docs.z.ai/guides/capabilities/cache
13. Google API Services User Data Policy (Limited Use): https://developers.google.com/terms/api-services-user-data-policy
   13a. Google Workspace User Data and Developer Policy (last updated 2026-09-03): https://developers.google.com/workspace/workspace-api-user-data-developer-policy
14. Google Cloud Console Help, OAuth verification FAQ, "Limited Use" AI/ML questions: https://support.google.com/cloud/answer/13463817?hl=en
15. Z.ai docs index: https://docs.z.ai/llms.txt
16. llama.cpp PR #27773 "add GLM-5.3-Flash (GLM5-Next) support" (merged 2026-09-30): https://github.com/ggml-org/llama.cpp/pull/27773
17. llama.cpp open issues and PRs: #27917 (MTP), #28360, #28144, #28282, #29010: https://github.com/ggml-org/llama.cpp/pull/27917 , https://github.com/ggml-org/llama.cpp/issues/28360 , https://github.com/ggml-org/llama.cpp/issues/28144 , https://github.com/ggml-org/llama.cpp/issues/28282 , https://github.com/ggml-org/llama.cpp/issues/29010
18. Unsloth GGUF repo: https://huggingface.co/unsloth/GLM-5.3-Flash-GGUF
   18a. REAP50 pruned GGUF (third party): https://huggingface.co/patrickbdevaney/GLM-5.3-Flash-REAP50-GGUF
19. OpenRouter listing (third-party reseller, for contrast only): https://openrouter.ai/z-ai/glm-5.3-flash
20. Federal Register 2025-00704, "Addition of Entities to and Revision of Entry on the Entity List" (2025-01-16): https://www.federalregister.gov/documents/2025/01/16/2025-00704/addition-of-entities-to-and-revision-of-entry-on-the-entity-list

## Verification

Each load-bearing claim was checked again against the source's raw text, not against a summary:

- **Pricing:** re-read from the raw Markdown of the pricing page (`pricing.md`). The column headers and the GLM-5.3-Flash row ($0.15 / $0.03 / Limited-time Free / $0.50) match. The free Flash models are confirmed as GLM-4.7-Flash, GLM-4.5-Flash and GLM-4.6V-Flash. The first web search returned OpenRouter's $0.02 / $0.2475, which was **rejected** as a third-party price.
- **Training and retention:** quoted word for word from the raw Markdown of the Terms of Use and the Privacy Policy/DPA. Their dates are recorded above (2026-04-14 and 2025-09-29). The caching statement was quoted from the raw `help/faq.md`, and the caching guide was searched for "disable/opt/ttl/expire/retention", with no matches.
- **No ZDR:** the full docs index (`llms.txt`, 76 lines) was searched for enterprise/retention/security/compliance pages; only the Privacy Policy matched. A web search for "Z.ai zero data retention" found nothing first-party.
- **Context, architecture, licence:** context was checked against `config.json` (`max_position_embeddings: 1048576`). The licence was read from the raw `LICENSE` file and the README front matter (`license: mit`). The model card's "300,000 tokens" figure is the HLE evaluation setting, not the context limit.
- **GGUF sizes:** summed from the Hugging Face tree API, file by file per quant folder.
- **llama.cpp support:** the merge date was read from GitHub (`mergedAt: 2026-09-30T06:20:33Z`).
- **Google policy:** quoted from the raw HTML of the three Google pages. The "stored in conjunction with" wording comes from the OAuth FAQ, not from the main policy page.
- **Entity List:** checked against the Federal Register raw text, which lists "Beijing Zhipu Huazhang Technology Co., Ltd.". The link between Z.ai and Zhipu is **not** confirmed by a first-party source.
- **Not verified (needs a logged-in or live check):** the account's actual rate limits; whether `response_format` and `tool` role messages work with `glm-5.3-flash` in practice; the z.ai blog post, which renders with JavaScript and could not be fetched.
