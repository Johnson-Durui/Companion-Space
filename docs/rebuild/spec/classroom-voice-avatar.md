# 规格 · 界面、白板、语音与形象

> 目标观感：**打开就是"和一位老师视频上课"**，而不是管理后台。现有前端（表单卡片、五个能力绑定表、三个重复的启动页）整体弃用，只移植零件。
> 版本号为 2026-11-16 调研快照，实施时以官方文档的最新稳定版为准，并写入 `DECISIONS.md`。

## A. 前端工程

- 技术：Vite 8 + React 19 + TypeScript（**固定 `~5.9`**：`openapi-typescript` 7.x 与 TypeScript 7 不兼容）+ React Router 8（声明式 `BrowserRouter`；包名是 `react-router`，已无 `react-router-dom`）+ TanStack Query 5（服务端数据）+ Zustand 5（课堂运行态）+ Tailwind CSS 4（`@tailwindcss/vite` 插件，无需配置文件）+ Vitest。
- 接口：只用 `packages/api-client`（`openapi-fetch` + 生成类型）。删除手写 DTO 与手写校验编解码器。
- 目录：

```
apps/web/src/
  app/            路由表、布局、错误边界、查询客户端
  features/
    onboarding/   欢迎 · 选老师 · 连接模型
    courses/      课程首页 · 导入向导 · 分析进度 · 课程地图
    learner/      访谈 · 起点诊断 · 画像
    plan/         计划时间线
    classroom/    舞台 · 白板 · 输入条 · 时间线执行器 · 备课页 · 下课页
    review/       复习队列 · 错题本 · 练习/模考
    characters/   角色库 · 导入 VRM · 声音
    settings/     模型 · 语音 · 安全 · 数据 · 用量
  audio/          采集、帧器、播放队列、VAD（移植并重构自 realtime-audio*.ts）
  live/           WebSocket 连接、LSP 事件编解码、重连
  ui/             基础组件（按钮、卡片、抽屉、芯片、进度、空状态）
  styles/         tokens.css（色板/字号/间距/圆角/阴影）
```

- 全局错误边界 + 每条路由的加载/错误/空状态；三维画布、KaTeX、Mermaid 各自有局部错误边界（渲染崩溃不得白屏）。
- 运行：开发 `vite`（`server.host: '127.0.0.1'`，代理 `/api` 与 WebSocket 到后端，不要开 `rewriteWsOrigin`）；生产由 FastAPI 托管 `apps/web/dist`（静态文件 + 非 `/api` 路径回退到 `index.html`；`index.html` 不缓存，带哈希的资源长缓存）。
- `AudioContext` 必须在用户点击后创建/恢复（自动播放策略）；`http://127.0.0.1` 属于安全上下文，麦克风与 AudioWorklet 可用；**不支持用局域网 IP 访问**（非安全上下文，麦克风不可用）。

### 设计系统

- 沿用现有青绿/米白/珊瑚色板（`foundation.css` 的色值迁入 `tokens.css`），补齐：字号阶（12/14/16/18/22/28/36）、间距阶（4 的倍数）、圆角（8/12/20）、两级阴影、深色舞台背景。
- 三个断点：`<760`（手机）、`760–1100`（平板）、`≥1100`（桌面）。JS 不再另用 `matchMedia` 判断布局。
- 语气：界面文案短、口语、第二人称；不出现"Vault / Provider / capability / session"等工程词。
- 每个涉及界面的里程碑结束时，用 Playwright 截取关键页面（桌面 1440×900、手机 390×844）存入 `docs/rebuild/review/<里程碑>/`，供所有者目视验收（截图不做像素断言）。

## B. 页面

| 路由 | 页面 | 要点 |
| --- | --- | --- |
| `/welcome` | 欢迎 | 三步：选老师（卡片 + 3D/立绘预览 + 试听）→ 连接模型（M8 起另有"看示例课"入口）→ 新建课程 |
| `/` | 首页 | 今天的课（大按钮"继续上课"）· 到期复习 N 张 · 我的课程卡片（进度环、距考试天数） |
| `/courses/new` | 导入向导 | 多文件拖拽；每个文件一行：名称、识别出的角色（可改）、年份（真题）；"开始分析"前显示预估 |
| `/courses/:id` | 课程首页 | 标签页：计划 / 课程地图 / 资料 / 进度 |
| `/courses/:id/analysis` | 分析进度 | 阶段条 + 实时计数 + 可读文案；失败阶段可重试 |
| `/courses/:id/map` | 课程地图 | 单元折叠列表，知识点行：名称、考试权重条、考情徽标（常考/上升/新考法）、掌握状态色点；右侧抽屉：摘要、出处页（点开原页图）、对应真题、前置/后继；可改名/合并/删除/调重要度 |
| `/courses/:id/interview` | 访谈与诊断 | 老师形象 + 对话气泡 + 快捷芯片；诊断题用与课堂相同的作答控件；"不会"按钮醒目 |
| `/courses/:id/plan` | 计划 | 时间线：每节课标题、时长、日期、"为什么先学它"；顶部一句话总览与取舍说明；可置顶/顺延/"我会了" |
| `/lessons/:id` | 课堂 | 见 C |
| `/review` | 复习 | 到期卡片翻面自评；错题重做；本周统计 |
| `/characters` | 老师 | 角色卡片、导入 VRM、选择声音并试听、人设与默认讲课风格 |
| `/settings` | 设置 | 模型连接（预设/Key/测试/角色分配）· 语音 · 安全（可选主密码）· 数据（目录、导出、清除）· 用量 |

## C. 课堂界面

```
桌面（≥1100）
┌──────────────────────────────────────────────────────────────────────────────┐
│ ← 高等数学 · 第3课 极限的直观含义     ●●○○ 环节      12:30   讲法：循循善诱 ▾   下课 │
├────────────────────────────┬─────────────────────────────────────────────────┤
│                            │  白板（米色纸面，可滚动；块按时间线逐个出现）            │
│     老师（半身，3D）         │   ┌ 标题 ┐                                        │
│                            │   │ 公式 │ ← 激光笔/标注                           │
│  ┌──────────────────────┐  │   │ 图表 │                                        │
│  │ 字幕：正在说的这一句     │  │   │ 题目控件（选项/填空）                          │
│  └──────────────────────┘  │                                                 │
│  澄羽 · ● 正在讲             │                                                 │
├────────────────────────────┴─────────────────────────────────────────────────┤
│ 🎤 按住说话 │ 输入你的回答或问题…            发送 │ 没听懂 │ 举个例子 │ 给点提示 │ 看答案 │ ⋯ │
└──────────────────────────────────────────────────────────────────────────────┘
舞台 : 白板 ≈ 36 : 64；手机：舞台在上（16:10，滚动白板时缩成右上角小窗），白板在中，输入条固定在底部
```

- **输入条**：按住说话（默认）/ 免提（开关，带电平表）/ 文字；快捷动作：没听懂、举个例子、给点提示、看答案；⋯ 里有：再讲一遍、讲慢点、讲快点、我会了、休息一下。每个按钮对应 `teaching-engine.md` §5.2 的一个 `quick_action`。
- **"给点提示"与"看答案"在有题目时始终可用**：只问不答会把学生赶走。要提示不扣分（只是这道题不再算"净对"）；看答案后老师立即示范解法（该题不计入掌握证据），随后必须跟一道同类题确认。
- **口头或打字回答选择题、数值题**：识别出的答案先预填进作答控件，显示"你的答案：B · 2 秒后提交 · 改"，倒计时结束才提交——语音识别的结果不直接判分。
- **白板交互**：点某一行 →"从这里开始没跟上"（即 `locate` 动作）或"问这一行"；连续两次没听懂后，白板上出现不打断讲课的提示"点一下从哪一行没跟上"；题目块内直接作答；出处角标点开原页图。
- **暂停**：学生没回应时老师提醒一次，再没回应课堂自动暂停，画面显示"我等你，回来点继续"。
- **状态可见**：老师状态点（在讲/在听/在想/等你回答）；环节进度点；掌握度变化在下课页集中展示，课堂中不打分数。
- **备课页**：老师待机动画 + "正在备课：整理第 12–13 页 · 准备检查题 · 复核答案 2/6"。
- **下课页**：学到了什么 / 做得好的 / 还不稳的 / 下次先复习；掌握度变化条；新增复习卡数量；"下一节""回首页"。
- **无语音时**：字幕就是主通道，每句按字数停留（中文约 150 ms/字，最少 1.5 秒，随语速设置缩放），其余行为完全一致。

## D. 白板渲染（`packages/board`）

- 数据：`Board {pages: Page[]}`，`Page {blocks: Block[]}`，`Block {id, type, variant?, title?, content|spec, lines?, marks[]}`。`applyBoardEvent(board, event) -> board` 为纯函数；React 只做渲染。
- 块类型与实现：

| 类型 | 实现 | 说明 |
| --- | --- | --- |
| `title` `text` `list` `callout` | `react-markdown` + `remark-math` + `rehype-katex`（或 `streamdown`） | 行内公式 `$…$` |
| `math` `steps` | KaTeX（`throwOnError:false`，`trust:false`，`strict:'ignore'`） | 多行逐行渲染，行可寻址（`id.n`）；出错行显示原文 |
| `table` | Markdown 表格 | |
| `code` | `highlight.js` 或 `shiki`（按需加载） | 支持行高亮 |
| `diagram` | Mermaid（懒加载；`securityLevel:'strict'`；先 `mermaid.parse(text,{suppressErrors:true})` 再渲染） | 失败 → 一次自动修复 → 仍失败显示原文 |
| `plot` | `function-plot`（MIT，D3）+ `mathjs`（受限求值，禁用 import/evaluate 等） | 规格见 `teaching-engine.md` §8.1；表达式非法则显示原文 |
| `image` | `<img>` 指向 `/api/v2/materials/{id}/pages/{n}/image`（可带高亮框） | 学生自己资料的原页 |
| `question` | 自研控件：单选/多选/数值/短答，以及论述题的文本框（数学输入首发用普通文本框，`MathLive` 后置）；另有 `ack` 类提问的按钮组 | 由 `ask` 事件创建；提交后禁用并显示判定。**M3 先实现单选/多选/数值（诊断要用），M4 补齐其余** |

- 出现动画：块淡入上移 250 ms；`math/steps` 的新行用自左向右的 `clip-path` 展开（300–500 ms，模拟书写）；`mark` 用描边动画；`point` 是 1.2 秒的光点。尊重"减少动态效果"系统设置。
- 第二批（M7 之后按需）：`geometry`（JSXGraph，MIT 许可项）、`widget`（模型生成的可交互小演示：只在 `sandbox="allow-scripts"` 的 iframe 中运行，**绝不同时给 `allow-same-origin`**；由后端单独路由返回宿主文档并带 `Content-Security-Policy: default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'`）。
- 导出：一页白板 → Markdown（课堂笔记），M7。

## E. 语音链路

### E.1 服务端：分句流水线（替换现有"整段生成后合成一次"）

```
Realizer 流 → LSP 解析 → 每个 <say> 再按标点切成 TTS 片段（seg）
   → 合成队列（最多并行预取后 2 个片段，按序下发）
   → WebSocket：say{seg,text} → audio{seg,format,…}+二进制帧 … → audio{seg,last:true}
```

- 二进制帧头（16 字节）：`"CSA1"`(4) + `gen` u32 + `seg` u32 + `flags` u16 + 保留 u16；前端据此丢弃过期 `gen` 的帧（现状靠一个布尔量配对 JSON 头与二进制帧，打断时会串音，必须改掉）。
- 音频格式：`pcm_s16le`（24 kHz 单声道，流式边到边播）或 `mp3`（整段一个片段，前端 `decodeAudioData`）。两种都要支持。
- 被打断：取消该 `gen` 的 LLM 流与全部未完成合成任务。
- 可预测时预生成下一拍（例如 `EXPLAIN` 之后大概率是 `CHECK`），学生未打断则直接播放，降低拍间停顿；预生成的内容若因学生输入作废则丢弃。

### E.2 TTS 引擎（统一接口 `synthesize(text, voice, rate) -> AsyncIterator[AudioChunk]`，可选返回字边界）

| 引擎 | 定位 | 说明 |
| --- | --- | --- |
| `edge`（`edge-tts` ≥ 7.3.1） | **零配置默认** | 免费、中文自然（如 `zh-CN-XiaoxiaoNeural`、`zh-CN-XiaoyiNeural`、`zh-CN-YunxiNeural`）；输出 MP3；可取 `WordBoundary` 时间戳；每句约 1 秒握手。**这是微软未公开的消费端接口，没有 SLA，2026-10 曾整体失效数日**：任何 403/429/无音频/超时都判为"引擎不可用"，自动切换到下一级并在界面提示。实施前核对该包的许可（LGPL 类许可只能作为未修改的依赖使用） |
| `openai_compat`（已有适配器） | 低价云端 | 硅基流动 `/v1/audio/speech`（如 `FunAudioLLM/CosyVoice2-0.5B:anna`，`response_format:"pcm"`、`sample_rate:24000`、`stream:true`）等 |
| `elevenlabs`（已有） | 高品质 | 大陆网络不可靠 |
| `local_neural`（已有 Qwen3-TTS sidecar） | 本地 GPU 可选 | 默认关闭 |
| `gpt_sovits`（新增适配器） | 本地二次元音色 | 对接用户自己启动的 GPT-SoVITS `api_v2.py`（`POST /tts`，`media_type:"raw"`，`streaming_mode`）；本项目不分发任何音色模型 |
| `browser`（`speechSynthesis`） | 最后兜底 | 仅当以上都不可用 |

- 回退链：角色指定引擎 → 默认引擎 → `browser` → 纯字幕。每次降级都要在界面上说明原因与修复入口。
- 每个角色保存 `voice = {engine, voice_id, rate, pitch}`；切换引擎后若该音色不存在，回落到该引擎的默认音色并提示（现状会把音色 id 发给不认识它的供应商）。

### E.3 STT 与端点检测

| 引擎 | 定位 | 说明 |
| --- | --- | --- |
| `openai_compat`（已有 `/audio/transcriptions`） | **默认**（连接了硅基流动时免费：`FunAudioLLM/SenseVoiceSmall`） | 整句识别；带语言提示 |
| `local_sherpa`（可选扩展 `[local-stt]`：`sherpa-onnx`） | 离线 | 模型首次使用时从上游下载并展示其许可（SenseVoice 权重为 FunASR 模型许可，非 Apache——**不得随仓库或安装包分发**）；备选纯 Apache 的流式 zipformer |
| 无 | — | 麦克风按钮置灰并提示"连接语音识别后可用"，文字输入始终可用 |

- 不使用浏览器 `SpeechRecognition` 作为默认（Chrome 依赖 Google 服务，大陆不可用）。
- 采集：沿用 AudioWorklet 采集与 16 kHz 帧器（降采样前加低通）；`getUserMedia({audio:{echoCancellation:true, noiseSuppression:true, autoGainControl:true}})`。
- **按住说话**是默认且最可靠的方式。**免提**模式用 `@ricky0123/vad-web`（Silero VAD，ISC；模型与 wasm 资源必须随应用自托管，不走 CDN）：语音起点带 300 ms 预滚，静音 700–900 ms 判定结束；说话期间**连续上传全部帧**（现状只上传超过能量阈值的帧，导致字头被切）。
- 打断：免提模式下检测到 ≥300 ms 语音即本地停播并上报；若连续两次"打断后识别为空"（多半是外放回声），自动关闭语音打断并提示"建议戴耳机"。
- 音频帧到达服务端时不得触发数据库读写。

### E.4 前端 `SpeechOutput`

- 片段队列按 `seg` 顺序在 `AudioContext` 时钟上无缝排程；提供 `onSegmentStart/End`（驱动时间线与字幕）、`stop(gen)`、以及一个始终连接的 `AnalyserNode`/口型节点输出（供形象使用，**不经过 React 状态**）。
- 断线重连：WebSocket 断开后自动重连并用 `GET /lessons/{id}/events?after=seq` 补齐；不再"断线即结束会话"。标签页隐藏时暂停课堂而不是关闭连接。

### E.5 延迟目标（推荐预设 + 默认语音；在所有者机器上实测并如实记录）

| 场景 | 目标（中位数） |
| --- | --- |
| 点选答案 → 老师开口 | ≤ 1.8 秒 |
| 说完一句话 → 老师开口 | ≤ 3.0 秒 |
| 打断 → 停止出声 | ≤ 300 毫秒 |
| 相邻两拍之间的停顿 | ≤ 1.2 秒 |

## F. 形象引擎（`packages/avatar-engine` 重构）

### F.1 保留与弃用

保留：VRM 加载/释放、包围盒测量与相机取景、表情能力探测、2D 回退路由、`teaching-cue` 类型。弃用：每帧把上臂固定为常量角度的代码、剥离手臂轨道的逻辑、5 口型时钟循环、为测试写的 `dataset` 遥测、"捏人"槽位系统、Live2D/Spine 桥。

版本：`three` 固定在 `@pixiv/three-vrm` 官方测试所用的小版本（当前 0.180.x）；`@pixiv/three-vrm` 与 `@pixiv/three-vrm-animation` 版本号保持一致；使用 `WebGLRenderer`（不用 WebGPU/NodeMaterial）。

### F.2 对外接口

```ts
<TutorAvatar model={url} framing="bust" audio={AudioNode|null} reducedMotion onReady onError ref={handle} />
handle.setActivity('idle'|'listening'|'thinking'|'speaking'|'waiting')
handle.setMood(emotion, intensity)              // 来自 say.emotion
handle.react('correct'|'incorrect'|'encourage'|'surprised'|'greet'|'farewell')
handle.gesture(name)                            // nod | shake | wave | think | point_board | cheer | shrug | write | explain
handle.lookAt('student'|'board', holdMs?)
handle.stop()
```

课堂的时间线执行器把 `cue/point/say` 事件翻译成这些调用；形象组件不读课堂状态。

### F.3 分层

1. **基础姿态**（永远不显示 T 字）：加载完成、首帧渲染之前就启动待机；上臂向身体侧收约 70–75°，肘微屈，手指自然弯曲。**只写归一化骨骼**（`humanoid.getNormalizedBoneNode`）；VRM 0.x 先 `VRMUtils.rotateVRM0`，手写四元数需翻转 x、z 分量（在一个 0.x 模型和一个 1.0 模型上目视核对）。
2. **待机程序动画**：呼吸（脊柱/胸 ±1.5°，约 4 秒周期）、重心微移、头部微动；随机眨眼（2–6 秒，偶尔连眨）；眼球微跳。
3. **手势层**：动作片段是**自己编写的关键帧数据**（JSON：`{name,duration,loop,tracks:[{bone,times,quat}]}`，只含用到的骨骼，6–12 个关键帧），运行时生成 `AnimationClip`；淡入 0.2 秒、淡出 0.3 秒；点头/摇头等小动作用叠加混合（必须先 `AnimationUtils.makeClipAdditive`）。首发集合：`explain_a/b/c`（讲解时的前臂节拍）、`point_board`、`think`、`nod`、`shake`、`cheer`、`wave`、`shrug`、`write`。不得提交 Mixamo 或 pixiv 官方 VRMA 文件；可选的 CC0 来源（Mesh2Motion、Quaternius UAL）转换后提交需附署名行。
4. **指向白板**：不做 IK；计算肩到目标方向，直接"瞄准"上臂（`setFromUnitVectors`），肘近乎伸直，食指伸出；身体转向白板一侧约 20°，0.25 秒缓入缓出。
5. **视线**：目标定义在相机空间。`student` = 相机；`board` = 画面内白板一侧的固定点。讲解时约 70% 看学生、30% 瞥白板；`point` 时看白板 1.2 秒；听学生说话时看学生并偶尔点头。
6. **表情**：情绪权重缓动（0.15–0.6 秒）；说话时情绪权重上限 0.6，避免 VRM 1.0 表情覆盖规则屏蔽口型；眨眼与情绪切换错开。
7. **口型**：从播放链路的 `AnalyserNode` 直接取信号。首发用音量驱动 `aa`（峰值经 S 形函数、低于阈值归零、指数平滑），随后升级为 `wlipsync`（MIT，AudioWorklet + WASM 的 MFCC 匹配；A/I/U/E/O 映射到 `aa/ih/ou/ee/oh`，只混合权重最高的两个，静音门限）。口型数据不经过 React 渲染。

### F.4 性能与降级

- `setPixelRatio(min(devicePixelRatio, 1.5))`（低档 1.0）；标签页隐藏时暂停；待机时限 30 fps；监听 `webglcontextlost/restored`。
- 加载后调用 `removeUnnecessaryVertices`、`combineSkeletons`、`combineMorphs`；低档关闭描边、弹簧骨减半更新。
- 帧率连续 5 秒低于 20 或 WebGL 不可用 → 切到 2D 立绘。
- **2D 回退**：分层贴图（睁眼/闭眼 × 闭嘴/半开/张开），眨眼用计时器、嘴型用同一个音量信号。用开发脚本对每个默认 VRM 离屏渲染出这组贴图并随模型提交（继承模型许可）；用户导入的模型在本机首次成功渲染时自动截取。

### F.5 角色与资产

- 角色 = `{name, appearance:{kind:'vrm'|'portrait', src, framing}, voice, persona:{relationship, traits[], catchphrases[], address_user_as}, default_style_id, license}`，存于现有 `character_packs.recipe_json`（`schema_version = 2`，旧配方里的外观槽位字段忽略）。**这套结构与 `GET /api/v2/characters` 在 M1 就要有**（欢迎页、访谈、课堂的角色卡、每角色音色都依赖它）；M6 做的是角色库页面、VRM 导入与编辑界面。
- **默认老师**以内容包提供（`content/characters/<id>.json`，首次启动导入）：
  - 6 位**立绘老师**：沿用现有 6 个角色的名字、设定与立绘（`assets/avatars/portraits/`），`appearance.kind = 'portrait'`；所有者用 VRoid Studio 做出对应的 3D 模型后再换成 3D。
  - 3 位 **3D 示例角色**（各有自己的名字与人设，不借用别的角色的立绘）：`VRM1_Constraint_Twist_Sample`（pixiv，VRM 1.0，VRM Public License 1.0，内嵌标志允许再分发）；`Sendagaya-Shino`、`Sakurada-Fumiriya`（pixiv 以 CC0 发布的 VRoid 示例模型，VRM 0.x；CC0 的依据是 pixiv 的帮助页，不是文件内嵌字段）。
  - **`Seed-san` 不再随仓库分发**：它的内嵌标志与 VRM 规范仓库的说明允许再分发，但作者 VirtualCast 自己公布的条款对分发未修改的数据有限制，两处冲突——这是所有者做出的许可风险决定，**不因"文件内嵌标志允许"而放回**。
  - 6 个脚本生成的模型下线（见 `architecture-and-data.md` §9.3）。
- 随仓库分发的角色素材放 `assets/avatars/`（`models/`、`portraits/`、`backgrounds/`），由后端以 `/static/avatars` 提供；目录内的 `LICENSES.md` 写明"本目录文件不适用 Apache-2.0"及每个文件的来源与许可。
- **许可单测规则**：VRM 1.0（`extensions.VRMC_vrm.meta`）要求 `allowRedistribution === true`；VRM 0.x（`extensions.VRM.meta`）要求 `licenseName` 是允许再分发的取值，或 `licenseName == "Other"` 且 `otherPermissionUrl` 的查询参数含 `redistribution=allow`；此外文件名必须登记在 `LICENSES.md` 中，且不在拒绝清单（`Seed-san.vrm`）里。
- **导入你自己的 VRM** 是一等功能：拖入文件 → 校验 → 显示作者与许可 → 自动取景 → 报告缺失的表情/口型（缺则降级）→ 选声音。应用不提供任何"编辑/导出模型"的功能（VRoid 预设条款禁止基于其数据做角色创建服务）。
- 真正贴合项目立绘的专属 3D 角色需要所有者用 VRoid Studio 制作（免费、有简体中文界面，1–2 小时一个；导出 VRM 1.0，目标 ≤8 MB、≤4 万面、贴图 ≤2048），见 `HUMAN-TASKS.md`。
