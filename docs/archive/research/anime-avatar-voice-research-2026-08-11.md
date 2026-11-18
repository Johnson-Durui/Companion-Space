# 二次元角色形象与声音调研（2026-08-11）

## 结论

本轮采用 `research-swarm-full` 的 8 平台口径，结论状态为 **partial**：GitHub、YouTube、Bilibili、Hugging Face 与通用网页取得直接证据；X、抖音只能读取公开索引；小红书缺少可用登录态与原生后端，因此没有把它作为决策证据。

最稳妥的产品方向不是继续堆高音调或下载更多人物模型，而是：

1. 让角色形象、性格、声音风格组成可选择的完整预设，同时继续允许用户逐项修改。
2. 表情和动作保持小幅、与 listening / thinking / speaking 状态一致；不要持续夸张表演。
3. “可爱声音”做成可选风格，优先自然节奏、低延迟、可打断和本机隐私，而不是把所有声音统一升高。
4. 默认只接入许可已核实且固定版本的资产；声优克隆、知名 IP 模型、许可不清的数据集与未固定版本的远程资产均不进入默认路径。

## 平台覆盖

| 平台 | 状态 | 后端 / 证据 | 结论用途 |
| --- | --- | --- | --- |
| GitHub | available | 官方仓库与项目发布页 | VRM 规范、运行时、开源候选与许可证 |
| YouTube | available | `yt-dlp` 原生搜索元数据 | 桌面伴侣、本地 TTS、角色定制的市场信号 |
| Bilibili | available | B站公开搜索 API | 国内用户对桌宠、Live2D、低延迟语音与“活人感”的关注 |
| Hugging Face | available | 官方模型卡与文件树 | Kokoro、Qwen3-TTS、Piper 的许可证和体积 |
| 通用 Web | available | 官方文档、论文、Jina/Web 搜索 | Windows 本机语音、Web Speech、VRM 许可与 HCI 证据 |
| X / Twitter | degraded | [HanaVerse 公开帖](https://x.com/ashdebugs/status/2033185351788044372)、[Voxta 公开回复页](https://x.com/VoxtaAi/with_replies)，未登录 | local-first、Live2D + voice 的开发者信号；不作统计结论 |
| 抖音 | degraded | [公开精选页](https://jingxuan.douyin.com/m/video/7639631482675367187) / 索引 | 可爱桌宠、点击反馈、任务状态的创作者信号 |
| 小红书 | auth-required | 未读取 Cookie、未绕过登录 | 无可用原生样本，不参与决策 |

## 角色形象发现

- B站公开搜索中，“把二次元伙伴带到现实桌面”“活人感 AI 陪伴”“互动桌宠”等标题反复出现，说明用户关注的不只是立绘，而是可见状态、桌面互动和持续陪伴。例如：[二次元伙伴桌面化](https://www.bilibili.com/video/BV1o8u86iEA2)、[超具活人感的 AI 陪伴智能体](https://www.bilibili.com/video/BV1R9G46PEqh)、[互动桌宠](https://www.bilibili.com/video/BV1g6NA63EuT)。这些是创作者/市场信号，不是代表性调查。
- YouTube 原生搜索同样把桌面伴侣、角色定制和本地 TTS 放在显著位置：[Build Your Perfect AI Companion](https://www.youtube.com/watch?v=A6xzpdJAIl8)、[How I Programmed My Own AI Waifu](https://www.youtube.com/watch?v=yWfStYXsPho)、[Local TTS voices tutorial](https://www.youtube.com/watch?v=asQINiJqvBg)。
- 研究综述表明，具身代理的面部、声音、服装和性格会共同影响互动感；但更多表情不必然更自然，关键是社会语境和情绪匹配：[Frontiers engaging interactive systems review](https://www.frontiersin.org/journals/computer-science/articles/10.3389/fcomp.2023.1138501/full)、[embodied-agent uncanny-valley review](https://pmc.ncbi.nlm.nih.gov/articles/PMC12493983/)。
- VRM 不能只凭扩展名判断可再分发；许可设置会分别控制再分发、修改和角色化使用，必须保留模型内嵌元数据与来源记录：[VRM license settings](https://vrm.dev/en/vrm/meta/license/)、[VRM Public License 1.0](https://vrm.dev/en/licenses/1.0/)。

### 候选资产决策

| 候选 | 决策 | 原因 |
| --- | --- | --- |
| 仓库现有 Sendagaya Shino / Sakurada Fumiriya | 保留并继续内置 | CC0；现有校验、通知和运行时均已覆盖 |
| 仓库现有 Seed-san / Constraint Sample | 保留并继续内置 | VRM Public License 1.0；已记录内嵌权限，Seed-san 需署名 VirtualCast |
| VRoid AvatarSample_A/B/C | 暂不新增 | 官方允许多种使用，但不是 CC0，且对付费再分发有单独约束；现有 4 个 VRM 已约 53 MB，新增价值不足 |
| Polygonal Mind 100Avatars / Kenney 角色包 | 仅保留为未来参考 | CC0 友好，但审美与当前日系 VRM 不一致，会扩大资产与 QA 面 |
| 粉丝模型、知名 IP 二创、来源不清的“免费模型” | 禁止内置 | 无法可靠证明角色、服装、纹理与再分发权利 |

现有许可台账位于 `assets/THIRD_PARTY_NOTICES.md` 与 `apps/web/public/assets/characters/models/manifest.json`。

## 声音发现

- Windows 官方列出的简体中文本机 TTS 包括男性 **Kangkang** 和女性 **Huihui / Yaoyao**：[Microsoft 支持的语言和声音](https://support.microsoft.com/zh-CN/accessibility/windows/narrator/appendix-a-supported-languages-and-voices)。
- Web Speech API 可以区分本机与远程声音；本机声音通常避免额外网络延迟、带宽和费用。声音列表也可能通过 `voiceschanged` 异步到达：[SpeechSynthesisVoice.localService](https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesisVoice/localService)、[voiceschanged](https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesis/voiceschanged_event)。
- “可爱”不能等同于无限提高音调。语速、停顿、自然度和轮次衔接都会影响感知质量；实时伴侣还需要可打断和明确状态：[speech rate / naturalness study](https://pubs.asha.org/doi/10.1044/2019_AJSLP-MSC18-18-0052)、[conversation responsiveness study](https://doi.org/10.1016/j.ijhcs.2024.103222)。
- Azure 官方中文神经语音支持 cheerful、gentle、chat、calm 等风格，说明用“情绪/节奏预设”表达角色比用声优姓名更稳妥：[Azure Speech language and voice support](https://learn.microsoft.com/zh-cn/azure/ai-services/speech-service/language-support)。本项目不暗中调用 Azure；正式默认改为本机运行的固定 Qwen 声线。

### 本地 TTS 候选决策

| 候选 | 决策 | 原因 |
| --- | --- | --- |
| 浏览器 / Windows 本机 SpeechSynthesis | 仅保留兼容模式 | 零新增权重，但不同 Windows 音色自然度差异大，实听仍有明显系统合成感；只有用户显式绑定 Mock TTS 时启用 |
| Kokoro-82M-v1.1-zh | 暂不内置，保留未来可选下载 | Apache-2.0 且中文可用，但官方包约 394 MB；第三方 int8 ONNX 仍约 127 MB，并引入新的浏览器推理依赖与性能 QA |
| Qwen3-TTS 12Hz 0.6B CustomVoice | 已接入高质量本地默认 | Apache-2.0、官方固定声线、中文自然度与可懂度更适合实时伴侣；约 2.5 GB，首次启动下载固定 revision，使用 NVIDIA GPU sidecar |
| Piper `zh_CN-huayan` | 禁止内置 | 模型卡明确将训练来源许可标为 Unknown；当前引擎还带 GPL-3.0 义务 |
| 任何声优/真人参考音频克隆 | 禁止内置 | 身份、人格权、数据许可和误导风险不可接受 |

候选一手来源：[Kokoro Chinese model card](https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh)、[Kokoro files](https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh/tree/main)、[Kokoro ONNX conversion](https://huggingface.co/onnx-community/Kokoro-82M-v1.1-zh-ONNX/tree/8b6f9672edefb3e00d1a946d79bb702c02519389/onnx)、[Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS)、[Piper Huayan model card](https://huggingface.co/rhasspy/piper-voices/blob/main/zh/zh_CN/huayan/medium/MODEL_CARD)、[current Piper upstream](https://github.com/OHF-Voice/piper1-gpl)。

## 本轮落地

1. 角色工作室新增 **Focus Spark** 预设，直接复用已内置的 Seed-san VRM、CC0 动作和现有角色配方数据流。
2. 角色工作室新增原创角色方向横幅，用于解释“选形象，也选相处节奏”；它不代表任何现成 IP，也不替代实际 VRM 预览。
3. 新增独立 `builtin-neural-tts` 连接，运行 `Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice`，公开模型名固定为 `qwen3-tts-0.6b-customvoice`，模型 revision 固定为 `85e237c12c027371202489a0ec509ded67b5e4b5`。
4. 内置 Serena、Vivian、Dylan、Eric、Uncle_Fu 五个官方固定声线；不接收参考音频、不提供声音克隆、不抓取视频或任意 URL。
5. 默认空间的 bootstrap TTS 会精确迁移到神经语音；用户显式选择的 Mock、远程或自定义 TTS 保持不变。旧 Mock 模式仍可显式选择，并清楚标为“兼容系统朗读”。
6. 神经语音由只在 Compose 内网暴露的 GPU sidecar 输出 24 kHz、单声道、PCM16 音频；模型缓存独立于应用 `storage/`，避免进入日常数据备份。

## 原创视觉资产

- 项目路径：`apps/web/public/assets/characters/art/original-study-companions.png`
- 生成方式：Codex 内置 `image_gen`
- 用途：角色工作室目录横幅
- 来源边界：全新原创构图；未输入、复制或修改第三方角色图片；未指定画师风格或现成 IP。
- 最终提示词摘要：三位 20 多岁的原创二次元学习伙伴，分别呈现温柔黑色短发导师、元气青绿色高马尾教练、沉静银发夜读伙伴；宽幅 3:1，角色位于右侧，左侧留 UI 空间；珊瑚到深青色光线；现代动画插画、干净赛璐璐与柔光；无文字、无商标、无性化、无知名 IP 或画师模仿。

## 后续边界

- 若未来提供 Kokoro，应做成明确的 CPU 兼容选项，固定模型提交与哈希，并默认禁用声音克隆；不能静默替代 Qwen 或 Mock。
- 视频中的台词不能作为任意文本 TTS，也通常没有可再分发的声音权利，因此本项目不收集视频音轨做默认声线。
- 若未来继续加 VRM，应先验证二进制内嵌元数据、来源文件、SHA-256、商业/再分发/修改与署名条件，再进入仓库。
- 小红书、X 和抖音仍需在用户明确控制的公开登录态下补做原生评论样本；在此之前，不把公开索引当作用户偏好统计。
