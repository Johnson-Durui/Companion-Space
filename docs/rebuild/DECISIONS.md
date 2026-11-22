# 重塑决策

## 已定决策

| # | 决策 | 理由 | 依据 |
| --- | --- | --- | --- |
| 1 | 产品定位从"伴学搭子"改为"专属 AI 家教"；角色就是老师 | 所有者的目标是一对一教学；旧定位让提示词主动回避教学 | 所有者说明；`libs/prompts/system_core.md` |
| 2 | 保留底座、重建产品；在快照提交之上开分支 `rebuild/tutor` | 底座真实可用；产品层缺失 | 2026-11-16 审计 |
| 3 | 教学 = 备课（可复核）+ 导演（纯代码策略）+ 表达（模型流式） | 可测试、可解释；题目答案可靠 | `spec/teaching-engine.md` |
| 4 | 模型输出用标签流/标签块，不用 JSON 承载含 LaTeX 的内容 | JSON 转义会静默损坏公式 | 调研：多个项目的同类缺陷记录 |
| 5 | 掌握度用透明公式；计划用确定性算法 | 单学习者数据稀疏；需要可解释 | `spec/learner-model-and-planning.md` |
| 6 | 学生随时可"看答案"，之后必须跟一道同类题 | 只问不答的辅导产品被学生弃用 | 调研：Khanmigo 两年跟踪研究的报道（2026-09） |
| 7 | 前端改为 Vite 单页应用，由 Python 进程托管；运行时不需要 Node | 现有 Next.js 只是薄壳；一个进程一个端口 | 审计 |
| 8 | 零密码默认；密钥仍加密，数据密钥存系统凭据库；主密码可选 | 学习软件第一屏不该是保险箱 | 实测首屏 |
| 9 | 产品代码中没有 Mock；无密钥时提供"示例课回放" | "Mock 闭环必须通过"的旧红线催生了写死逻辑 | 审计 |
| 10 | 供应商走"预设 + 角色"；`live` 角色按预设关闭思考 | 主流模型默认开启思考，延迟不可接受 | 调研快照 2026-11-16 |
| 11 | 零成本默认组合：智谱免费模型（对话/视觉）+ 硅基流动免费嵌入/识别/OCR；付费默认 DeepSeek | 目标用户预算接近零，且需大陆可达 | 调研快照 |
| 12 | 默认语音 `edge-tts`（零配置），必须带自动回退 | 免费且中文自然，但是未公开接口、无 SLA | 调研：2026-10 曾整体失效 |
| 13 | 默认语音识别走 OpenAI 兼容转写接口（硅基流动 SenseVoice 免费）；不依赖浏览器语音识别 | Chrome 的识别依赖 Google 服务，大陆不可用 | 调研 |
| 14 | 检索：trigram 全文 + numpy 余弦；嵌入可选 | 一门课只有几千块，暴力检索足够；少一个扩展依赖 | 调研 |
| 15 | 默认老师 = 6 位立绘老师 + 3 个许可清晰的 3D 示例角色；6 个脚本生成的模型下线；`Seed-san` 因条款存在冲突不再分发（许可风险决定，不因文件内嵌标志而放回） | 观感与许可 | 审计、调研 |
| 16 | 动作用自编关键帧数据；不提交 Mixamo / pixiv 官方 VRMA | 许可 | 调研 |
| 17 | 不提供"捏人"；提供"导入你自己的 VRM" | 旧捏人选项不匹配任何网格；VRoid 预设条款禁止做角色创建服务 | 审计、调研 |
| 18 | 删除：移动端配对、旧知识库导入、指标子系统、Live2D/Spine 桥、成人关系模式、SSRF 钉扎层 | 死代码或与目标用户不符 | 审计 |
| 19 | 测试只断言行为与不变量；真实模型评测与所有者实测是完成的必要条件 | 旧测试大量钉常量，验收建立在假路径上 | 审计 |
| 21 | 模型不输出提问标签、不出题、不编例题、不解题；提问由代码按导演的决定追加，题目与例题只来自教案里已复核的内容 | 让"教得对"由代码与复核保证，不取决于便宜模型的临场发挥 | 对抗评审 |
| 22 | 学生不回应永不记为"不会"（提醒一次后暂停）；语音识别出的客观题答案先预填确认，不直接判分；模型判分的证据打折 | 掌握度只认可靠的证据 | 对抗评审 |
| 23 | "已掌握"需要隔天的一次净对来确认；同一天内最高只到"今天学会了，待复习确认" | 防止十分钟前才学的内容被判为掌握后再也不测 | 对抗评审 |
| 24 | 评测防自证：金标先提交、留出课程只跑一次、不变量由代码计算、评分模型独立；所有者实测是最终门 | 写评测的与被评测的是同一个代理 | 对抗评审 |
| 25 | M1 直接删除旧对话栈（不移植到新接口）；写死的课堂在 M0 删除 | M0 之后已无客户端调用它们；移植是浪费 | 对抗评审 |
| 26 | 迁移器先改造（v5 之后不再重跑基础建表脚本、迁移前自动备份），再写任何删表/删列迁移 | 否则被删的表会被重新建出来，甚至启动失败 | 对抗评审（已核对代码） |
| 27 | 官方 3D 角色走"角色制作支线"：代理操作 VRoid Studio 出底模（只能点界面，它没有脚本接口），所有者挑选定稿，配色/贴图/压缩/检查由代码对导出的 VRM 做后处理；先做 1 个角色当试验再决定是否批量 | 起点是专业部件而不是代码拼的几何体；界面操作慢且偏脆，所以只让它做非它不可的部分 | 所有者提议；调研（Codex 的 Windows 桌面操作自 2026 年年中可用，前台运行） |
| 28 | 免提语音使用固定版本 `@ricky0123/vad-web` 0.0.31 与 Silero V5；模型、AudioWorklet 和 ONNX WASM 均由本机应用提供 | 免提需要 300 ms 预滚、连续帧与稳定的本地端点检测；运行时不依赖 CDN | 上游浏览器集成文档；包许可 ISC，ONNX Runtime 与 Silero 许可 MIT |
| 20 | 不参考、不引入 GPL/AGPL 代码；可借鉴设计并可按许可复用的开源项目：OpenMAIC（v0.3.0 起 MIT：动作词表与"发出即走/等待完成"规则）、DeepTutor（Apache-2.0：确定性掌握闸门、真题仿写思路）、ChatVRM 与 airi（MIT：口型、眨眼、表情缓动的算法） | 许可兼容且有现成的好设计 | 调研 |

### 定位（写入 `DECISIONS.md` 的"定位"条目）

- 已经是通用能力、不构成差异的：文档 → 幻灯片/讲解/测验/闪卡（OpenMAIC、NotebookLM 等）；带引用的资料问答；VRM 渲染、口型与表情；掌握度闸门与间隔复习（DeepTutor）。
- 本项目要占住的位置：**逐拍生成、可随时打断的一对一授课，且学习者模型会改变下一句讲什么**（OpenMAIC 是预生成的固定课，DeepTutor 以文字对话为主）；**基于学生自己的真题与教材得出的考情驱动计划**（开源项目中未见）；**按错因换讲法、不限次数的重教**；**零基础设施**（一个 Python 进程 + SQLite，没有 GPU 也能用，国内模型开箱即连）；**一位长期记得你的固定老师**。
- 清醒认识：3D 形象不是护城河（大项目随时能加）；护城河是这条回路的质量——响应延迟、板书内容的正确性、学习者模型是否真的改变了教学。这三项做不好，产品只是一个更慢的同类项目。

## M0 执行决定

- 移动端配对与成人偏好共同使用旧 vault 路由，放在同一组清理。保留既有数据库结构。浏览器凭据继续有效，旧移动端凭据在 owner token 与 WebSocket 票据的会话查询处拒绝。原受限成人关系角色一律拒绝启用。
- BGE 设置仍被检索适配器读取。默认走已有的 `local_hybrid` 嵌入和 `local` 排序。显式启用 BGE 时使用对应模型配置，保留原来的可选适配和依赖缺失回退。
- 旧互动白板依赖本阶段删除的课堂契约，随旧界面归档。共享包保留可复用的数学渲染。旧 E2E 和其中的 `dataset` 探针保存在归档目录，已退出活动工作区和 CI。
- 角色素材的实际旧路径位于 `apps/web/public/assets/characters/`。角色与动作文件按原字节移动；保留的 VRM 通过内嵌条款及许可表检查。首次加入 MIRA、KITE、CAEL、LYRA 四张立绘的提交是 `b2096ac`，逐项许可仍待确认。
- Windows 环境通过桌面目录联接访问 E 盘工作树。执行门时使用真实 E 盘路径和可用的本机回环连接，旧数据继续保存在原目录。

## M1 执行决定

- v6 先备份旧库再迁移。显式清除旧移动会话及其票据、自动模型绑定和已退役连接，兼容早期没有完整外键约束的库。原 v1–v5 迁移及 v5 建表、兼容脚本冻结。旧对话、消息和记忆的表及读接口留在仓储层。
- 凭据使用系统凭据库，确实不可用时使用当前用户专属的 `key.bin`。凭据写入后无法读回确认时返回错误，防止留下两份可用的同一密钥。关闭主密码时轮换 DEK，使中断写入不会削弱旧密文的密码保护。Windows 备用文件用操作系统 SID 设置显式 ACL，原子写使用临时文件描述符、同步及替换。[Microsoft icacls](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/icacls)
- 自定义地址保留供应商原路径，已有的 URL 内嵌凭据、查询串和片段限制继续生效。明确的本地兼容地址允许空 Key，远程连接按适配器校验。已核对供应商原生文档，来源随 `presets.json` 保存。模型目录变化快，方舟和部分兼容供应商使用手填或发现结果。旧资料入库继续使用 `ingestion_jobs` 与显式课程绑定。
- 角色的第二版内容由独立接口读取。旧角色 API 只接触原配方，以免旧的编辑接口覆盖新内置老师。标识、默认讲法和默认音色由本次内容包首次导入，后续由项目所有者复核。新角色的 3D 预览安排在 M6。
- Python 依赖锁定 `keyring==25.7.0`（MIT，复用系统凭据库）、`edge-tts==7.3.1`（LGPL-3.0 原样安装，默认在线试听）、`aiohttp==3.14.5`（Apache-2.0 与 MIT，Edge 网络错误类型）、`numpy==2.5.5`（BSD-3-Clause，分批嵌入张量）、`json-repair==0.64.9`（MIT，仅在严格 JSON 解析失败时复核修复）。试听不依赖独立 TTS 服务，失败时由浏览器接手并显示原因。[Keyring](https://pypi.org/project/keyring/25.7.0/) [Edge TTS 许可](https://github.com/rany2/edge-tts/blob/7.3.1/LICENSE) [aiohttp](https://pypi.org/project/aiohttp/3.14.5/) [NumPy](https://pypi.org/project/numpy/2.5.5/) [JSON Repair](https://pypi.org/project/json-repair/0.64.9/)
- 前端使用 Vite 8、声明式 React Router 8、TanStack Query 5、Zustand 5、Tailwind 4 与 TypeScript 5.9。React/React DOM 统一锁在 19.2.9，兼容路由器和保留的三维渲染依赖，避免重复运行时。精确依赖与许可随 npm 锁文件记录。新界面沿用旧色板与立绘，数据和契约直接由 FastAPI 提供。[Vite](https://vite.dev/guide/) [React Router](https://reactrouter.com/start/declarative/installation) [Tailwind CSS](https://tailwindcss.com/docs/installation/using-vite) [TanStack Query](https://tanstack.com/query/latest/docs/framework/react/installation)

## M2 执行决定

- 资料解析锁定 `pypdfium2==5.15.2`（BSD-3-Clause / Apache-2.0，PDF 页面渲染）、`python-pptx==1.0.2`（MIT，PPTX 文本、备注、表格与图片）、`python-docx==1.2.0`（MIT，DOCX 标题、段落与表格）、`Pillow==13.0.0`（MIT-CMU，图片校验和 JPEG 输出）与 `python-multipart==0.0.34`（Apache-2.0，FastAPI 文件上传）。现有 `pypdf` 继续负责 PDF 文字层与书签。所有直接依赖及其 `lxml`、`XlsxWriter` 传递依赖均已用 Windows CPython 3.14 二进制解析验证。PDFium 的支持层 API 可能在大版本变化，代码使用 5.x 的逐页 `PdfPage.render()`，不使用已移除的文档批量渲染接口。[pypdfium2](https://pypi.org/project/pypdfium2/5.15.2/) [python-pptx](https://pypi.org/project/python-pptx/1.0.2/) [python-docx](https://pypi.org/project/python-docx/1.2.0/) [Pillow](https://pypi.org/project/pillow/13.0.0/) [python-multipart](https://pypi.org/project/python-multipart/0.0.34/) [FastAPI 文件上传](https://fastapi.tiangolo.com/tutorial/request-files/)

## M3 执行决定

- 所有者要求开启 M3。M2 待办保留在进度记录，M3 先实现可独立验证的画像、课程报名和掌握度计算。
- `PUT /api/v2/courses/{course_id}/enrollment` 支持手动编辑课程设置。访谈与诊断状态取自数据库，保存设置时保留已有状态。
- 掌握度更新以学习者规格 §2.2 的不变量为准，获得三级提示后的错误与重试也保持原概率。客观单选至少需要两个选项。

## M4a 执行决定

- SQLite v9 把旧复习项移入 review_cards，保留 legacy_source_session_id 供旧对话查询。保存教案前按课程核验题库身份，课堂绑定该版本。资料重新分析替换题库后，作答仍根据已保存的复核快照结算。
- 命令行入口先提交完整教学拍，再显示输出。重启后重放尚未确认阅读的教学拍，或重发当前待答题。作答证据随课堂事件和状态共同提交。流式推送和生成中取消需要实时会话接入。

## M5 执行决定

- 开课入口允许从课程地图选择一个知识点，复用已有的备课、复核和课堂存储。该课单独放在按需计划中，便于重复进入同一课并保留断点。
- 语音客观题答案需要显式确认。播放使用浏览器 AudioContext，后端按合成器返回的采样率发送单声道 PCM。GPT-SoVITS 读取流式 WAV 头确定采样率，避免不同模型输出被固定速率播放。
- 可选离线语音识别锁定 `sherpa-onnx==2.0.1`（Apache-2.0，针对 CPython 3.14 有 Windows 轮子）。SenseVoice int8 模型由用户接受 FunASR 模型许可后下载并校验上游哈希。在本机运行识别并保存权重缓存，发布包省去运行时和模型。在线识别继续用已配置的模型角色。[Sherpa Python 包](https://pypi.org/project/sherpa-onnx/2.0.1/) [SenseVoice 模型许可](https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE)

## 角色子系统纯视频重塑决定（2026-11-19，V1–V3）

- 取代旧决策 #15/#16/#17/#27 与支线 C（VRoid Studio）：**彻底移除 3D VRM 渲染、Three.js / `@pixiv/three-vrm` / `@react-three/fiber` / `wlipsync` 与独立悬浮窗**，统一采用嵌入式竖屏微信视频通话框 `<TutorVideoBox>` 与纯视频驱动架构（规格见 `docs/rebuild/spec/tutor-video-avatar.md`）。
- 三个历史 VRM 示例模型与角色卡归档至 `assets-archive/retired-vrm/`，旧数据库中的 `schema_version: 2` 角色透明升级，指向退役 VRM 的默认老师或课堂记录自动确定性回退至内置二次元老师（优先沐音 `tutor-echo` / 星澜 `tutor-nova`），绝不删除 `storage/` 或历史行。
- 画风与模板优先级：**二次元画风优先**（配套 `.tutorpack` 单图/8 片段循环包与 ComfyUI 1→8 工作流模板）；**本地 GPU Sidecar 模板优先**（独立 Apache-2.0 目录 `sidecars/local-gpu-avatar/`，支持 WebRTC + Windows 零编译 `ws_frames` 双传输，主仓严守 Apache-2.0 不引入 GPL/AGPL 代码或 GPU 依赖）。
- 课堂新增副轨 150ms 抢断微动作与客观题确定性秒判 `judge.preview`（非落库、不泄答案、不改掌握度不变量），以及 15 秒无交互纯视觉安静伴学态 `idle_companion`。

## 体验重塑 U0 执行决定（2026-11-21）

- **`feedback_reaction` 姿态与 `think_chin` 片段播放方式**：`poseToClipSlot("feedback_reaction")` 不再映射到一次性表扬片段，改为返回基础待机片段 `idle_breathe`，且 `LoopPackVideoDriver.setPose("feedback_reaction")` 保持当前正在播放的片段不变；所有一次性反应片段只由 `triggerInstantAction` 决定。`think_chin` 保持**循环播放**（不加入 `ONE_SHOT_CLIPS`），与素材规范（3s loop）、"给点提示 / 举个例子"等待期以及 U2a 的思考相位一致；当老师开始讲解或恢复倾听时平滑切换离开。

## 体验重塑 U1 执行决定（2026-11-22）

- **依赖核对与锁定**：
  - `@base-ui/react@1.9.0`（MIT，支持 React 19，单包覆盖 Dialog、AlertDialog、Menu、Popover、Tooltip、Select、Switch、Slider、Tabs 等无样式可访问原语）。
  - `lucide-react@1.77.0`（ISC，统一描边风格图标，经 `apps/web/src/ui/icons.ts` 单点导出）。
  - `clsx@2.1.1`（MIT，类名拼接）。
  - `happy-dom@21.0.4`（MIT，仅开发依赖，供 Vitest 组件行为单测使用）。
  - React / React DOM 在 U1 保持 `19.2.9` 不升级，路由进入转场先采用 CSS 淡入动画，React ViewTransition 留待 U7 评估。
- **字体采用 OFL-1.1，按素材许可处理，可逆**：锁定开发依赖 `@fontsource-variable/geist@5.3.0` 与 `@fontsource-variable/noto-sans-sc@5.3.1`（均为 SIL OFL 1.1），由 `scripts/generate-fonts-css.mjs` 生成并提交 `apps/web/src/styles/fonts.css`（`font-display: fallback`），两份许可全文存放在 `assets/fonts/LICENSES/` 并随 `scripts/build-portable.ps1` 一起分发，同时登记在 `assets/THIRD_PARTY_NOTICES.md`。通过 `data-font="system"` 保留切回系统字体栈的对比与可逆能力。
- **Tailwind v4 token 到工具类的映射命名**（在 `apps/web/src/styles/theme.css` 的 `@theme` 与 `@theme inline` 中一次定型，后续里程碑不得另起别名）：
  - 表面背景：`bg-surface-page`、`bg-surface-card`、`bg-surface-sunken`、`bg-surface-overlay`、`bg-scrim`、`bg-board-focus`。
  - 前景文字：`text-fg-primary`、`text-fg-secondary`、`text-fg-tertiary`、`text-fg-disabled`。
  - 边框：`border-line-subtle`、`border-line-default`、`border-line-control`。
  - 老师强调色：`bg-accent` / `text-accent` / `border-accent`、`bg-accent-strong` / `text-accent-strong` / `border-accent-strong`、`bg-accent-soft` / `text-accent-soft`、`text-accent-on-dark` / `bg-accent-on-dark`、`text-on-accent`。
  - 状态色（`ok` / `retry` / `warn` / `danger` / `info`）：`bg-<k>`、`text-<k>`、`border-<k>`、`bg-<k>-soft`、`text-<k>-text`。
  - 掌握度：`text-mastery-unseen/learning/fragile/mastered`、`bg-mastery-unseen/learning/fragile/mastered`。
  - 字阶：`text-caption`（12/18）、`text-ui`（14/22）、`text-body`（16/26）、`text-title`（20/28）、`text-headline`（28/36）、`text-display`（40/48）、`text-board`（17/30）。
  - 圆角：`rounded-sm`（6px）、`rounded-md`（10px）、`rounded-lg`（16px）、`rounded-xl`（24px）；阴影：`shadow-1`、`shadow-2`、`shadow-3`；时长：`duration-instant/fast/base/slow/page`；缓动：`ease-out/in-out/sheet`；层级：`z-sticky/dock/overlay/modal/toast`；断点：768 / 1100 / 1600。
- **舞台与纸面补齐的语义 token**（均纳入对比度单测）：
  - 纸面（`[data-surface="paper"]`）在书桌下 `--surface-page/--surface-card` 为 `#FFFDF6`、`--surface-sunken` 为 `#F5F1E4`、`--surface-overlay` 为 `#FFFFFF`、`--border-subtle` 为 `#E9E3D3`、`--border-default` 为 `#CFC7B4`；在深色舞台内（`[data-surface="stage"] [data-surface="paper"]`）降一档为 `--surface-page/--surface-card: #F6F2E6`、`--surface-sunken: #ECE6D6`、`--surface-overlay: #FAF7EE`、`--border-subtle: #DED7C4`、`--border-default: #C4BBA6`。两者共用 `--text-tertiary: #606A71`（对两档纸面对比度均 ≥ 4.8:1）、`--text-disabled: #959CA2`、`--border-control: #7D848B`（对两档纸面对比度均 ≥ 3.4:1）以及全套浅色状态色与浅色阴影，防止从外层舞台继承深色状态色。
  - 深色舞台（`[data-surface="stage"]`）补齐状态浅底（各提亮状态色 16% 混入 `#171B22`）、纯黑加倍不透明度三档阴影与 `--board-focus`（`--accent-on-dark` 16% 混入 `#171B22`）。

## 体验重塑 U2a 执行决定（2026-11-22）

- **单一编排映射层（删除 `reduceChoreographer`）**：原 `packages/avatar-engine/src/choreographer.ts` 中仅由单测调用的 `reduceChoreographer` 状态机已移除，统一改为由纯函数 `lessonPhase(input)` 决定 16 个显式课堂相位，再经 `choreographer.ts` 的唯一映射函数 `phaseToTutorPose(phase, ctx)` 驱动姿态与 `poseToClipSlot` 片段，消除双状态机并存。
- **新增 `"thinking"` 姿态与外部 Sidecar 协议兼容**：`TutorPose` 新增 `"thinking"` 并映射到 `think_chin` 循环片段；`LocalSidecarVideoDriver.setPose` 向外部 Sidecar 进程发送控制消息时将 `"thinking"` 映射为协议已有的 `"idle_companion"`，不改动对外 Sidecar 协议。
- **视频框样式迁入形象包**：原 `apps/web/src/features/classroom/classroom.css` 中的 `.tvb-*` 样式已迁移至 `packages/avatar-engine/src/video-box.css` 并经 `@companion-space/avatar-engine/video-box.css` 导出，且全量使用语义 token（零硬编码十六进制色）。

## 体验重塑 U2b 执行决定（2026-11-22）

- **后端进程重启后的课堂恢复核实（任务 5）**：已在 `services/api/tests/test_u2b_lobby_resilience.py` 用全新的 `ServiceContainer` 挂载同一 SQLite 数据库完成两种模式的验证：
  - **未设主密码**：`lessons`（含 `state`、`board`、`seq`、`gen`）与 `lesson_events` 完整持久化在 SQLite；进程重启后前端在重连前调用 `POST /api/v2/session/bootstrap` 返回 `state="ready"` 并重新签发会话 Cookie，随后按既有 `after_seq` 重连 WebSocket，直接从断线前的要点与作答态无缝继续。
  - **已设主密码**：进程重启后主密钥（DEK）不在内存，原请求返回 `401` 且 `bootstrap` 返回 `state="locked"`；前端识别后退出无休止重连，在舞台遮罩给出明确的「服务已重启，需要重新解锁」提示与「去解锁」按钮（失效会话缓存切入解锁屏，解锁成功后自动回到原 `/lessons/:lessonId` 课堂并续上事件流）。
- **循环短片空闲预取与解码首帧再切换（任务 4）**：`LoopPackVideoDriver` 在挂载后利用空闲时机预取全部已就绪槽位片段（卸载时通过 `AbortController` 取消），切换槽位时保持前一个 `<video>` 可见直至新 `<video>` 触发 `loadeddata`/`canplay`（附 3 秒防卡死兜底），同时完整保留基于 `gen` 的过期指令丢弃与测试覆盖。
- **示例课声音（默认决定 D11）**：本里程碑暂通过免配置试听通路 `/api/v2/tts/preview` 逐句合成当前所选老师的语音；离线或不可用时降级为浏览器朗读并在顶栏标注「浏览器朗读」，待 U3 统一迁入 B13 课堂外老师语音接口。

## 体验重塑 U3 执行决定（2026-11-22）

- **资料阅读 4 大阶段与既有 10 段分析的映射**：课程准备第 2 步默认只向学生呈现四个粗阶段，底层 10 段技术明细收进可展开「详情」，对应关系如下：
  1. **读资料**：`parse`（解析页面）、`structure`（提取结构）、`index`（建立索引）。
  2. **整理知识点**：`kp_extract`（抽取知识点）、`kp_reduce`（归并去重）。
  3. **看真题**：`exam_extract`（识别真题）、`item_verify`（核验题干答案）、`exam_stats`（统计考点权重）。
  4. **准备摸底题**：`diag_pool`（生成摸底池）、`brief`（汇总课程简报）。
- **课堂外老师语音统一（B13）**：新增 `POST /api/v2/voice/speak`（复用课堂 `resolve_tts`，遵守长度上限并在不可用时返回结构化原因与错误码），将 `/api/v2/voice/preview`、`/api/v2/tts/preview` 统一至同一合成核心；今天页问候、课程准备访谈、候课试听与示例课（D11 离线回退浏览器朗读）全部通过 `useTutorSpeech` 调用该通路。
- **称呼优先级与泛称兜底（D3）**：`resolveLearnerNickname` 优先采用学习者画像中的称呼；仅当其为空且老师资料里的 `address_user_as` 不是泛指人称代词（`你` / `您`）时才回退，避免首页问候出现「下午好，你。」的生硬句式。

## 体验重塑 U4 执行决定（2026-11-22）

- **六位内置老师互异默认音色（B8 U4）**：将澜音（`tutor-lanyin`）默认 Edge 音色从与初棠重复的 `zh-CN-XiaoxiaoNeural` 调整为 `zh-TW-HsiaoChenNeural`，六位内置老师（雪川 `Yunjian` / 沈砚 `Yunxi` / 岚玥 `Xiaoyi` / 初棠 `Xiaoxiao` / 青衡 `Yunyang` / 澜音 `HsiaoChen`）现两两互异；通过 `_edited_fields` 追踪用户改过的字段，对既有数据库安装执行无覆盖缺省合并（仅在未编辑过 `voice` 且与旧重复默认值一致时自动升级），不覆盖用户自选音色。
- **局部更新与内置恢复默认**：`PUT /api/v2/characters/{character_id}` 改为完整局部更新，不提交 `preferred_tier` 时绝不篡改 `_tier_explicit`；新增 `POST /api/v2/characters/{character_id}/reset` 恢复内置清单默认人设与音色并清除该角色在 `voice_settings.characters` 中的旧覆写，自定义角色返回结构化 `400 tutor_reset_builtin_only`。
- **同屏单视频协调器（I16）**：在 `packages/avatar-engine/src/video-coordinator.ts` 新增全局 `tutorVideoCoordinator`，由 `LoopPackVideoDriver`（附 `IntersectionObserver` 离屏暂停与 `visibilitychange` 后台暂停）与画廊卡片悬停预览共同抢占释放，保证任一页面同时播放的老师 `<video>` 不超过一个。
- **Tailwind v4 断点统一使用 `rem`**：`apps/web/src/styles/theme.css` 将自定义断点从 `px` 统一改为等价的 `rem`（`md: 48rem` / `lg: 68.75rem` / `2xl: 100rem`），避免 Tailwind v4 因混用 `rem` 与 `px` 导致 `sm:` 媒体查询晚于 `lg:` 生效。

## 体验重塑 U5 执行决定（2026-11-22）

- **复习会话独立快照查询键（I14 防早退）**：复习会话 `/courses/:courseId/review/session` 与候课热身分别使用独立查询键 `["review-session-snapshot", courseId]` 与 `["lobby-warmup-snapshot", courseId, planItemId]`，确保单张卡片答后触发 `["courses", courseId, "review"]` 缓存失效时不会卸载当前卡片、打断答后反馈停顿（I14）。
- **手写 SVG 图表全量语义变量化**：`apps/web/src/ui/charts/` 8 个组件（`MasteryGrid`、`WeightBar`/`MasteryBar`、`ScoreBar`、`ScoreRing`、`StudyCalendar`、`WeeklyMinutes`、`SegmentProgress`、`PrereqChain`）零第三方图表库、零硬编码十六进制色，四态掌握度同步区分颜色与独立 SVG 几何形状（实心勾圆 / 半实圆 / 警告三角 / 虚线空圆）。
- **跨课程「这一周」汇总接口**：新增只读 `GET /api/v2/learner/week-summary` 一次返回近 7 天学习活跃格、本周总分钟数、已完成节数与连续学习天数，避免今天页对多门课程发起 N+1 进度查询。

## 体验重塑 U6 执行决定（2026-11-22）

- **白板多步推导自适应节奏与内容增长跟随**：`packages/board/components.tsx` 的 `steps` 块采用自适应行间间隔 `clamp(45ms, 280ms, 1100ms / (lines - 1))`（减少动态效果下瞬时全显），同时 `BoardPanel` 对内部内容容器挂载 `ResizeObserver`，确保逐行显现或函数图/流程图异步渲染拉高页面时在自动跟随态持续滚入最新行（满足 I7 且不打断手动上滚）。
- **麦克风上下文预热复用与安全释放**：确认 `MicrophoneCapture.start()` 原先每次按住说话都重建 `AudioContext` 并通过 Blob URL 重新执行 `audioWorklet.addModule()`，确实会引入首音节延迟；改为进入语音课时通过 `warmup()` 预加载并缓存 `AudioContext` + `AudioWorklet` 模块，松开时仅停止 `MediaStream` 轨道并 `suspend()`（立刻熄灭系统麦克风灯），切走标签页或卸载时 `dispose()` 彻底关闭上下文。
- **白板模块样式零硬编码色值**：彻底清理 `packages/board/board.module.css` 中的全部十六进制色并改用设计系统语义变量，从 `apps/web/tests/styles-tokens.test.ts` 的 `HEX_ALLOWED_FILES` 遗留白名单中提前移除该文件。
