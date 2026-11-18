# 开源生态调研（2026-07-30）

> 三路并行调研：同类项目竞争格局、可再分发的二次元形象素材、捏人与角色驱动技术方案。
> 数据来源：GitHub 页面 / GitHub API / npm registry / 官方许可页逐一核实；VRM 模型的许可以**文件内嵌 VRM meta 实测**为最硬证据。GitHub 访问全程正常；vroid.pixiv.help 与 booth.pm 的 WebFetch 受阻，前者已用浏览器核实原文，后者（BOOTH 商品页条款）标注为"未直接核实"。

## 一、竞争格局：没有人做"伴学"这个交叉点

现有项目清晰分成两个阵营，各自缺对方的另一半：

### AI 伴侣 / 虚拟角色阵营（有形象和语音，无知识库/学习）

| 项目 | Stars | 许可证 | 活跃度 | 要点 |
|---|---|---|---|---|
| [moeru-ai/airi](https://github.com/moeru-ai/airi) | 45.6k | MIT | 当天有 push | 自托管虚拟伴侣，VRM+Live2D、实时语音、浏览器端 VAD/ASR、xsAI 多厂商 BYOK。**无任何知识库/RAG** |
| [SillyTavern](https://github.com/SillyTavern/SillyTavern) | 31.3k | AGPL-3.0 ⚠️ | 活跃 | 角色卡生态（Character Card V2/V3 规范值得兼容）、Lorebook 注入机制。代码不可抄 |
| [xszyou/Fay](https://github.com/xszyou/Fay) | 13.4k | GPL-3.0 ⚠️ | 活跃 | 中文数字人框架，有知识库但商业数字人导向，非二次元非浏览器 |
| [Open-LLM-VTuber](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber) | 12.9k | 自定义 ⚠️ | v1.x 维护模式 | **可打断语音对话管线的最佳同构参考**（VAD 触发中断 ASR→LLM→TTS 全链）。Python 后端。学架构不抄码 |
| [Shaunwei/RealChar](https://github.com/Shaunwei/RealChar) | 6.2k | MIT | 半年一次提交 | FastAPI+WS+React，栈与我们同构，基本停更 |
| [semperai/amica](https://github.com/semperai/amica) | 1.6k | MIT | 停滞一年 | Next.js+three-vrm，表情/情绪引擎、多 TTS 适配层可搬 |
| [tegnike/aituber-kit](https://github.com/tegnike/aituber-kit) | 1.0k | 非商用自定义 ⚠️ | 活跃 | 功能最全（VRM+Live2D+多厂商），**代码不可进 Apache-2.0 仓库** |
| [jofizcd/Soul-of-Waifu](https://github.com/jofizcd/Soul-of-Waifu) | 954 | GPL-3.0 ⚠️ | 活跃 | 全双工语音+话题档案记忆，Qt 桌面 |
| [pixiv/ChatVRM](https://github.com/pixiv/ChatVRM) | 846 | MIT | **已归档** | 多数 VRM 项目的祖先，代码最精简：情感标签→表情映射、RMS 口型、AutoBlink。**可直接搬码** |
| [meet447/MeuxCompanion](https://github.com/meet447/MeuxCompanion) | 68 | MIT | 活跃 | 自托管 anime 伴侣 web 应用，证明赛道有人但没人做学习 |

### AI 学习 / 教学阵营（有 RAG/引用/测验，无二次元形象）

| 项目 | Stars | 许可证 | 活跃度 | 要点 |
|---|---|---|---|---|
| [HKUDS/DeepTutor](https://github.com/HKUDS/DeepTutor) | 31.2k | **Apache-2.0** | 每日 push | **最大竞争威胁 + 最大代码来源**：FastAPI+Next.js 同栈同许可证；多引擎 RAG 可插拔、引用回溯（Memory Graph）、测验生成、Chart.js/SVG 可视化 + Math Animator、TTS/STT、BYOK。无二次元形象、无通话形态 |
| [ahmedEid1/lumen](https://github.com/ahmedEid1/lumen) | 76 | GPL-3.0 ⚠️ | 活跃 | 一句话生成课程+课程域 RAG+引用审计+BYOK 密钥"写入即忘"。思路可学 |
| [Open-TutorAi/open-tutor-ai-CE](https://github.com/Open-TutorAi/open-tutor-ai-CE) | 86 | BSD-3 | 活跃 | 唯一"RAG+avatar+语音"三合一的教育项目（arXiv 2602.07176），但 avatar 非二次元、社区极小 |
| [SimonsTang/feifei-companion](https://github.com/SimonsTang/feifei-companion) | 114 | Apache-2.0 | 一般 | 中文 K12"学伴"概念，提示词体系非完整产品 |

### 结论

1. **"知识库 RAG 引用 × VRM 捏人 × 可打断语音通话 × 浏览器自托管"这个交叉点目前是空档**。伴侣阵营头部项目定位是 VTuber/桌宠/角色扮演，无意做学习；学习阵营没有二次元基因。
2. **差异化成立，窗口期约 6–12 个月**。最大威胁是 DeepTutor（若它加个 VRM 前端，学习侧功能清单差异被抹平）——所以壁垒要建在**融合体验**上：角色人格驱动的教学法、可打断的通话式讲解节奏、对话中画图分步演示、捏人+角色卡生态兼容，而不是 RAG 功能清单。
3. **最值得深挖源码**：Open-LLM-VTuber（打断管线，仅学架构）、DeepTutor（Apache-2.0 可直接借码：RAG 抽象、引用回溯、可视化/数学动画）、AIRI（MIT，浏览器 VRM 舞台生命周期）；辅助 ChatVRM（MIT，最快理解表情映射）。
4. **许可证红线**：可复用代码的只有 MIT（AIRI、amica、ChatVRM、RealChar、MeuxCompanion）与 Apache-2.0（DeepTutor）；AGPL/GPL/aituber-kit 非商用许可的项目只能看设计。

## 二、形象素材：可以直接打包进仓库的清单

### ✅ 可直接进仓库（附 `assets/THIRD_PARTY_NOTICES.md` 逐模型声明）

1. **VRM1_Constraint_Twist_Sample**（pixiv，VRM 1.0）——**首选默认模型**。文件内嵌 meta 实测：可再分发、可改后再分发、everyone、企业商用可、**无需署名**。就是 three-vrm 官方示例那只粉白发少女，与技术栈同源。[仓库](https://github.com/vrm-c/vrm-specification/tree/master/samples)
2. **Seed-san**（VirtualCast，VRM 1.0，VRM Public License 1.0）——meta 实测可再分发可改可商用，**必须署名 VirtualCast, Inc.** 并附 [VPL 1.0](https://vrm.dev/en/licenses/1.0/) 链接。
3. **Sendagaya Shino / Sakurada Fumiriya / β Ver AvatarSample_1–4 / HairSample**（pixiv 官方 **CC0**，[官方 FAQ](https://vroid.pixiv.help/hc/en-us/articles/4402614652569) 核实）——一女（黑长直 JK）一男（金发温和系）颜值担当，零义务。注意是 VRM 0.x，three-vrm 运行时可直接加载，统一 1.0 需 UniVRM 转换。
4. （可选）**AvatarSample_A/B/C**——[pixiv 条款](https://vroid.pixiv.help/hc/en-us/articles/4402394424089)明示可编辑贴图并再分发、免费分发未被禁止，但禁止收费再分发、禁用于角色创建服务、条款声明可能变更。求稳可降级为文档推荐。
5. 自制程序化动画代码、自制/委托的 CC0 VRMA。

### 📄 只能文档推荐（用户自行下载）

- VRoid Project 官方 7 个 VRMA（BOOTH，禁再分发、需署名；条款原文未直接核实）。
- Mixamo 动画 + [bvh2vrma](https://github.com/vrm-c/bvh2vrma)/fbx2vrma 转换教程（工具 MIT；动画文件不可随仓库分发）。
- VRoid Hub / BOOTH 用户自选模型——**应用内做"导入你自己的 VRM"入口是最干净的架构**。
- つくよみちゃん官方插画（商用免联系但禁素材再分发）；itch.io 免费立绘包（逐资产核实，CC0 者可升级为打包）。
- [ToxSam/open-source-avatars](https://github.com/toxsam/open-source-avatars)（CC0/CC-BY 干净但多为欧美风，非日系）。

### ❌ 绝对不能碰

- **Live2D 全线**：示例模型禁再分发、桃濑日和禁改动、Cubism SDK 专有许可+营收门槛，与 Apache-2.0 结构性冲突。**放弃 Live2D 路线**。
- Charat 生成物（商用/再分发受限）。
- tk256ailab/vrm-viewer 里来源不明的 11 个 VRMA（仓库 MIT ≠ 资产干净）。
- 把 Mixamo 动画文件直接 commit 进仓库。
- 轻信 [madjin/vrm-samples](https://github.com/madjin/vrm-samples) README 的许可标注（已发现它把 VPL 的 Seed-san 误标 CC0）——一切以官方页面和文件内嵌 meta 为准。

## 三、捏人与驱动的技术路径

### 捏人（three-vrm 官方已确认换装只能应用层自行实现，[discussion #1098](https://github.com/pixiv/three-vrm/discussions/1098)）

- **首版方案（与 M5 的"部件组合制"完全匹配）**：全部候选部件做进一个 VRM 文件（Blender + [VRM-Addon-for-Blender](https://github.com/saturday06/VRM-Addon-for-Blender)，1.7k star，MIT/GPL 双许可，作工具用无许可问题：多套发型/服装网格挂同一 armature）→ 运行时按 manifest 做**网格 visibility 开关 + MToon 材质换色**（改 baseColor/shadeColor uniform 实现肤/发/瞳/服装色）。不破坏 springBone/expression 绑定，three-vrm 开箱支持。
- **升级路线**：部件库变大后移植 [M3-org/CharacterStudio](https://github.com/M3-org/CharacterStudio)（306 star，MIT，可直接搬码）的方案——manifest JSON 定义 traits、分文件 skinned GLB 部件挂共享骨骼、导出时合并蒙皮网格+纹理图集出单 draw call 的 VRM。核心已抽成不依赖 React 的 `CharacterManager` 类。VRM 1.0 支持度需实测。
- VRoid Studio 闭源；其 v2.0 的 XWear 换装格式无 web 开源加载器，首版不对接、持续观察。
- 部件库制作工作流：VRoid Studio 捏底模+多套发型服装 → 导出 VRM → Blender 拆部件、统一 armature、规范命名 → 输出资产包。**仓库自带部件必须自制或 CC0**（VRoid Studio 预置素材再分发条款需单独确认）。

### 口型 + 动作

- **口型首版**：ChatVRM 式"音频 RMS → `aa` 表情"（MIT，几十行可直接搬），正好匹配我们"下行音频 RMS 驱动"的设计。**升级路线**：[mrxz/wLipSync](https://github.com/mrxz/wLipSync)（MIT，uLipSync 的 WASM+AudioWorklet 移植，MFCC→五元音，输出正好对上 VRM 的 aa/ih/ou/ee/oh 五口型）。
- **四态动作**：[@pixiv/three-vrm-animation](https://github.com/pixiv/three-vrm)（npm 3.5.5，2026-07 刚发版）加载 4 组 VRMA + `AnimationMixer.crossFade` 切换；叠加程序化层：AutoBlink 眨眼 + `vrm.lookAt.target` 视线 + spine 正弦呼吸（参考 ChatVRM/amica 的 MIT 实现）。表情/弹性骨骼用 three-vrm 内置 `VRMExpressionManager`/springBone，不引额外依赖。
- met4citizen/TalkingHead（1.4k star）不推荐：面向 GLB/RPM 骨骼，与 three-vrm 管线冲突。SillyTavern/Extension-VRM 的四态状态机设计最像我们的需求，但 GPL 只能看。
- **不存在覆盖捏人+驱动的"一整套"项目**。最优拼法：捏人抄 CharacterStudio、驱动抄 ChatVRM、工程参考 amica（三者全 MIT）。

### AI 生成捏人（远期观察，不进 v0.1）

- [hyz317/StdGEN](https://github.com/hyz317/StdGEN)（388 star，Apache-2.0，CVPR 2025）：单图生成身体/服装/头发**分层**的 3D 二次元角色——分解式输出与我们部件思路同构，但无绑骨/VRM 导出、需 CUDA。当前"图→静态网格"离"文生可驱动 VRM"还差绑骨/表情/拓扑三道坎。

## 对执行方案的影响（建议后续更新 docs/plan/v0.1-execution-plan.md 的 M5）

1. M5 的部件组合制可细化为上述"单 VRM 多网格开关"首版方案，并把 CharacterStudio 列为升级参考。
2. 仓库内置模型清单可直接采用第二节的 ✅ 清单（默认模型建议 VRM1_Constraint_Twist_Sample + Sendagaya Shino），`assets/THIRD_PARTY_NOTICES.md` 落地到 M5 验收。
3. 2D 兜底立绘素材源需要单独解决（itch.io 逐资产核实或自制），Live2D 路线正式关闭。
4. M6/M7 可评估直接借用 DeepTutor（Apache-2.0）的可视化/Math Animator/测验生成实现。
5. 建议深读源码顺序：ChatVRM → Open-LLM-VTuber（打断管线）→ DeepTutor（RAG/引用/可视化）→ AIRI（VRM 舞台）→ CharacterStudio（捏人）。
