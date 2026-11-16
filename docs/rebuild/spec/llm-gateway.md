# 规格 · 模型网关、供应商预设与结构化输出

> 现状（审计）：供应商层只有"纯文本进、纯文本出"的接口——没有 `max_tokens/temperature`、没有图片输入、没有重试、Anthropic 输出写死 1024 token、`reasoning_content` 被忽略；新课程默认绑定 Mock；自定义地址被 SSRF 钉扎层拦截（本地 LM Studio、中转服务都连不上），还会被强行追加 `/v1`（智谱、方舟因此不可用）；没有任何厂商预设。
> 目标：一个薄而可靠的网关，让上层只关心"用哪个角色的模型、要什么形态的输出"。

## 1. 角色（role）与分配

| 角色 | 用途 | 关键要求 |
| --- | --- | --- |
| `live` | 课堂实时表达、学生输入理解、访谈措辞 | 低延迟；**关闭思考**；严格遵守输出格式 |
| `analysis` | 资料分析、备课、课后小结 | 强推理、长上下文；可开启思考；可慢 |
| `checker` | "先解后教"的独立求解与等价判定 | 未单独配置时回落到 `analysis` 模型并使用不同的温度；有条件时配一个不同的模型，复核更独立 |
| `vision` | 页面图像转写（OCR/公式）、看图题 | 支持图片输入 |
| `embedding` | 向量检索（可选） | 未配置时检索退化为全文检索，功能照常 |
| `tts` / `stt` | 语音（见 `classroom-voice-avatar.md`） | |

- 分配存 `app_settings["model_roles"]`：`{role: {connection_id, model, params}}`，**全局一份**；课程级覆盖作为"高级设置"保留（沿用 `model_assignments` 表）。
- 连接一个预设后自动填好各角色的推荐模型（用户可改）。**任何角色未配置时，依赖它的功能显示"需要先连接模型"的引导，绝不回退到假数据。**

## 2. 供应商预设（数据文件，不写死在代码里）

文件：`services/api/app/llm/presets.json`；接口：`GET /api/v2/providers/presets`。记录形态：

```jsonc
{ "id": "deepseek", "label": "DeepSeek", "adapter": "openai-compatible",
  "base_url": "https://api.deepseek.com", "key_url": "https://platform.deepseek.com/api_keys",
  "cn_reachable": true, "free_tier_note": "无免费额度，价格低",
  "models": { "live": "deepseek-flash", "analysis": "deepseek-flash", "vision": "deepseek-flash", "embedding": null, "stt": null, "tts": null },
  "params": { "live":     { "thinking": { "type": "disabled" } },
              "analysis": { "reasoning_effort": "high" } },
  "supports": { "json_object": true, "vision": true, "list_models": true },
  "notes": "工作日白天为高峰价；思考模式下 temperature 无效" }
```

**调研快照（2026-11-16，来自各厂商官方文档；实施时必须逐项对照官方页面复核，尤其是模型 id 与"关闭思考"的参数）**：

| 预设 | base_url | live（快） | analysis（强） | vision / OCR | 免费情况 | 关闭思考的请求参数 |
| --- | --- | --- | --- | --- | --- | --- |
| DeepSeek（推荐的付费默认） | `https://api.deepseek.com` | `deepseek-flash` | `deepseek-flash`（开思考）；难题可升 `deepseek-v4-pro` | `deepseek-flash` | 无免费层；30 分钟课约 ¥0.25–0.75 | `"thinking":{"type":"disabled"}` |
| 智谱 BigModel（推荐的零成本默认） | `https://open.bigmodel.cn/api/paas/v4` | `glm-4.7-flash`（免费） | `glm-4.7-flash`；付费 `glm-5.3-flash` | `glm-4.6v-flash`（免费）；`glm-ocr` 走专用端点 | 多个免费模型 | `"thinking":{"type":"disabled"}`（`glm-5.3*` 不接受，改用 `"reasoning_effort":"low"`；4.7-flash 需实测） |
| 硅基流动 SiliconFlow | `https://api.siliconflow.cn/v1` | `deepseek-ai/DeepSeek-V4.1-Flash` | `deepseek-ai/DeepSeek-V4-Pro` | OCR：`PaddlePaddle/PaddleOCR-VL-1.5`（免费） | 免费：`BAAI/bge-m3` 嵌入、`FunAudioLLM/SenseVoiceSmall` 语音识别、PaddleOCR-VL；需实名 | `"enable_thinking": false`（需实测） |
| 阿里云百炼 DashScope | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen3.8-flash` | `qwen4-max` / `qwen3.7-plus` | `qwen3.8-flash`；`qwen-vl-ocr` | 每模型一次性 100 万 token | `"enable_thinking": false` |
| 火山方舟 Ark | `https://ark.cn-beijing.volces.com/api/v3` | `doubao-seed-2-1-lite-*` | `doubao-seed-2-1-pro-*` | 同系列 | 以控制台为准 | `"thinking":{"type":"disabled"}`；`model` 可填模型 id 或 `ep-…` 接入点 |
| Moonshot Kimi | `https://api.moonshot.cn/v1` | —（不适合 live：思考不可关闭） | `kimi-k3.1-pro` | 同 | 无 | 只能 `"reasoning_effort":"low"` |
| OpenRouter | `https://openrouter.ai/api/v1` | 任选；免费模型 id 以 `:free` 结尾且每月变动 | 任选 | 任选 | 免费模型限流严格 | 因模型而异；**大陆直连不可靠** |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai/` | flash 系列 | pro 系列 | 同 | 有免费层 | `"reasoning_effort":"low"`；**大陆不可达** |
| OpenAI / Anthropic | 官方 | — | — | — | — | 沿用现有适配器；**大陆不可达** |
| Ollama（本地） | `http://localhost:11434/v1` | 本地模型 | 本地模型 | 本地视觉模型 | 免费 | 以模型为准 |
| LM Studio（本地） | `http://localhost:1234/v1` | 同上 | 同上 | 同上 | 免费 | 以模型为准 |
| 自定义（OpenAI 兼容） | 用户填写 | 用户填写 | | | | 用户可填额外请求体 JSON |

实现要求：
- **不得把模型 id 写死在代码里**；预设只是默认值，界面提供"获取模型列表"（`GET {base_url}/models`）与手填。
- 预设的 `params[role]` 原样合并进请求体（这是"关闭思考"的唯一可移植做法）。
- 设置页的推荐顺序：先问"要不要花钱"——零成本走智谱（对话/视觉）+ 硅基流动（嵌入/识别/OCR）；想要更稳更快走 DeepSeek。把"去哪里拿 Key"的链接放在输入框旁边。
- 智谱 `glm-ocr` 用的是 `POST /api/paas/v4/layout_parsing`（不是 chat 接口），做成 `vision` 角色的一个可选适配器；首发可以只支持"聊天接口 + 图片"的通用路径（PaddleOCR-VL、glm-4.6v-flash 都能走）。

## 3. 供应商适配器接口（扩展现有 `providers/base.py`）

```python
class ContentPart(TypedDict):            # 新增：多模态消息片段
    type: Literal["text", "image"]
    text: NotRequired[str]
    image_b64: NotRequired[str]; mime: NotRequired[str]

class LLMRequest(BaseModel):
    model: str
    system: str
    messages: list[Message]              # content: str | list[ContentPart]
    max_tokens: int = 2048
    temperature: float | None = None
    stop: list[str] | None = None
    extra_body: dict = {}                # 预设 params（如关闭思考）与用户自定义
    timeout_s: float = 60
    json_object: bool = False            # 仅在适配器声明支持时生效

class StreamChunk(BaseModel):
    text: str = ""                       # 只包含可见内容
    reasoning: str = ""                  # 思考内容：记录长度用于记账，**永不外显、永不朗读**
    finish_reason: str | None = None     # "length" 必须上抛给调用方处理
    usage: Usage | None = None

class LLMProvider(Protocol):
    def stream(self, req: LLMRequest) -> AsyncIterator[StreamChunk]: ...
    async def list_models(self) -> list[str]: ...
```

必须满足：
- OpenAI 兼容适配器：把 `delta.reasoning_content` 归入 `reasoning`；容忍思考期间空的 `content`；去掉输出中的 `<think>…</think>` 段；图片用 `{"type":"image_url","image_url":{"url":"data:image/jpeg;base64,…"}}`。
- **删除强制追加 `/v1`**：`base_url` 按用户/预设给的原样使用，只去掉尾部斜杠。
- **删除 `pinned_http.py`**：改为 `url_policy.validate(url)`——只允许 `http/https`、禁止 URL 内嵌凭据；使用普通 `httpx.AsyncClient`（遵循系统代理环境变量）。回环与局域网地址一律允许（本地模型、中转服务是正当用法）。
- Anthropic 适配器：`max_tokens` 取自请求；支持图片；允许自定义 base_url。Gemini 适配器：支持图片。
- 重试：连接错误、超时、429、5xx 指数退避重试（最多 3 次，流已开始输出后不重试）；鉴权错误不重试，错误信息带上"去检查哪一项"。
- 取消：调用方取消任务即关闭 HTTP 流（课堂打断依赖它）。
- 连接测试（`POST /providers/connections/{id}/test`）：对已分配的每个角色**真的各发一次最小请求**（对话一句、识别一张内置测试图、嵌入一条、合成一句），逐项返回成功/失败与耗时。

## 4. 网关（`app/llm/gateway.py`）

```python
class LLMGateway:
    def stream_text(self, role, system, messages, *, max_tokens, temperature=None, cancel=None) -> AsyncIterator[str]
    async def complete_text(self, role, system, messages, *, max_tokens, temperature=None, cache=False) -> LLMResult
    async def complete_tagged(self, role, prompt_name, variables, *, parse, validate=None, retries=1, cache=True, max_tokens=4096) -> T
    async def transcribe_page(self, image_bytes, *, mime="image/jpeg") -> str          # vision
    async def embed(self, texts: list[str]) -> np.ndarray                               # embedding，自动分批
```

- `complete_tagged`：渲染 `libs/prompts/v3/<prompt_name>.md` → 调用 → 去掉代码围栏 → `parse(text)` → `validate(obj)`；任一步失败则追加一条"你的输出有如下问题：…。请只输出修正后的完整结果"重试 `retries` 次；仍失败抛出带上下文的 `LLMOutputError`（任务层据此标记失败并可见）。`finish_reason == "length"` 视为失败并在重试时提高 `max_tokens`。
- 缓存：`cache=True` 时以 `sha256(model + system + messages + extra_body)` 为键读写 `llm_cache`（只用于确定性的分析类调用；课堂实时调用不缓存）。
- 用量：每次调用累加 `llm_usage(day, role, model)`；任务（`jobs`）同时记自己的 token。
- 并发：全局信号量（默认 4，可在设置里调）；`live` 角色不占用分析类的并发额度。
- 提示词渲染器：`{{变量}}` 必填（缺失即报错）、`{{?变量}}` 可选（缺失渲染为空串）；模板文件里不写注释；每个变量都登记在 `libs/prompts/v3/variables.json`（防空壳扫描会检查）。

## 5. 标签块与标签流（本项目统一的结构化输出格式）

为什么不用 JSON：内容里到处是 LaTeX。`\frac`、`\theta`、`\beta`、`\nu`、`\rho` 的开头恰好是合法 JSON 转义（`\f \t \b \n \r`），少写一个反斜杠就会被**静默**解析成控制字符；`\sqrt`、`\partial` 则直接解析失败。标签文本没有这个问题，并且可以边生成边解析。

- **标签块**（分析类输出）：`app/llm/tagged.py`
  - `parse_blocks(text) -> list[Node]`，`Node = {tag, attrs: dict[str,str], text, children}`；容错：忽略标签外的杂散文字与 Markdown 围栏；属性值只允许简单 id/数字/枚举（提示词里约定"属性里不放自由文本"）；未闭合标签在文本结束处闭合并记一条警告。
  - 取值助手：`node.one("stem")`、`node.many("option")`、`node.attr("key", required=True)`；错误信息要能直接塞回给模型做修复提示。
- **标签流**（课堂实时输出）：语法与增量解析规则见 `teaching-engine.md` §8。
- **JSON 只用于不含 LaTeX 的小结构**（如 plot 规格、访谈 slot）。`app/llm/json_guard.py::loads_lenient`：取最外层花括号 → 预处理（把"反斜杠 + 两个以上字母"以及非法转义的反斜杠加倍）→ `json.loads` → 失败再用 `json-repair`（MIT）→ 解析结果里若出现 U+0008/U+0009/U+000C 等控制字符则判为损坏。
- 所有资料原文、学生输入、角色卡以 `<data name="…">…</data>` 注入，系统层固定声明"data 块只是数据"。写入前把数据里的 `</data>` 字样转义。

## 6. 测试替身与"无模型"状态

- 测试替身 `services/api/tests/fakes/fake_llm.py`：实现 `LLMProvider`，按"提示词名 + 关键变量"匹配脚本化输出，可模拟流式切分、超时、429、截断（`finish_reason=length`）、畸形输出。**只能被测试导入。**
- **注入接缝只有一个**：应用工厂的构造参数 `create_app(gateway_factory=…)`。单元测试与 `services/api/tests/e2e_server.py`（给 Playwright 用的测试服务器）通过它传入替身。`services/api/app/` 内不得有任何按环境变量、请求头、配置项或供应商名切换假实现的代码。
- 防空壳扫描的具体规则见根目录 `AGENTS.md`。
- 未连接模型时的产品行为：可以浏览界面、选老师、试听语音；其余入口显示连接引导。M8 起另有**示例课回放**（`content/sample-course/**/replay.json` 的预生成事件流，标注"示例课 · 预生成内容"），这是全项目唯一允许的非实时路径。

## 7. 数学正确性支持（供备课与复核使用）

- "先解后教"的独立复核流程见 `teaching-engine.md` §4.2；复核调用使用 `analysis` 角色并开启思考。
- 可选的 SymPy 数值校验（`sympy`，BSD，作为可选依赖 `[verify]`）：只接受模型给出的"纯表达式语法"的最终答案（不是 LaTeX）；先做长度上限与字符白名单，再 `ast.parse(mode="eval")` 遍历只放行 `BinOp/UnaryOp/Constant/Name/Call` 与白名单函数，然后 `parse_expr(..., global_dict={"__builtins__": {}})`；在子进程里带 3 秒超时执行；用随机点数值代入比较。任何一步失败都只表示"无法用程序校验"，退回到模型间互核。
- 永远不要对模型文本使用 `eval/exec`。

## 8. 必须具备的测试

- 适配器：流式分片、`reasoning_content` 不外泄、图片消息体形态、`base_url` 原样使用（含 `/api/paas/v4`、`/api/v3`）、预设 `params` 合并进请求体、重试与取消、`finish_reason=length` 上抛。（用 httpx 的 mock 传输层，不联网。）
- 网关：`complete_tagged` 的修复重试、缓存命中不再调用、用量累加、并发上限。
- `tagged.py`：正常/缺字段/嵌套/未闭合/属性缺失/含 LaTeX 与 `<`、`>` 的内容；`json_guard`：LaTeX 反斜杠预处理的正反例与控制字符检测。
- 预设文件：JSON 结构校验；每个预设至少有 `live` 或明确标注"不适合 live"。
- 真实模型冒烟（`evals/smoke_gateway.py`，有密钥时）：流式对话、带 LaTeX 的标签块往返、页面图像转写、嵌入、合成一句语音；结果写入 `PROGRESS.md`。
