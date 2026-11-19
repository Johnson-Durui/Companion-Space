# 规格 · 纯视频微信通话框角色子系统（去 3D · 二次元优先 · 开源可插拔）

> **适用分支**：`rebuild/tutor`（衔接 1.0 RC 之后的角色子系统重塑）
> **读者**：执行实施任务的 Codex 与项目所有者。
> **优先级说明**：本文档针对角色子系统取代 `spec/classroom-voice-avatar.md` §F（3D VRM 形象）与 `spec/character-pipeline.md`（支线 C VRoid Studio 制作）；教学策略、白板、音频与学习者模型仍以 `spec/teaching-engine.md`、`spec/classroom-voice-avatar.md` §A–E、`spec/architecture-and-data.md` 为准。
> **核心前提**：教材、课件、真题始终由用户自行导入，教学引擎与角色渲染完全解耦；本文档只重塑“虚拟老师角色子系统”。

---

## 1. 设计决策与范围边界

| 决策项 | 结论 | 说明 |
| --- | --- | --- |
| **前端形态** | 唯一呈现为嵌入式竖屏微信视频通话框 `<TutorVideoBox>` | 桌面端占课堂左侧约 34%–36% 宽；移动端顶部紧凑窗，滚动白板时可收缩为页内右上角小窗。**不做独立桌面悬浮窗 / 跨应用置顶窗。** |
| **渲染路线** | 纯视频流优先（Video-First），彻底去除 3D VRM | 退役 `three`、`@pixiv/three-vrm`、`@pixiv/three-vrm-animation`、`@react-three/fiber`、`wlipsync`、`three-vrm-lip-sync`、WebGL 渲染与支线 C（VRoid Studio）。全档位统一渲染到标准 HTML5 `<video>` / 媒体表面。 |
| **默认画风** | **二次元画风优先** | 延续并升级仓库内已通过 Apache-2.0 核验的两位二次元老师：**沐音（`tutor-echo`）**与**星澜（`tutor-nova`）**；配套提供二次元向《1 张图 → 8 段教学循环短片》标准提示词包与 ComfyUI 工作流模板。 |
| **首批实时驱动模板** | **本地 GPU Sidecar 参考模板优先** | 提供 Apache-2.0 协议 SDK 与可运行的本地 GPU Sidecar 参考脚手架（`sidecars/local-gpu-avatar/`），给出面向 MuseTalk / LiveAct / FlashHead 等本地开源推理模型的清晰适配插槽；云端 BYOK（如 Vivix / Vidu-Q2）同步预留标准能力槽与计费熔断机制。 |
| **开源许可红线** | 主仓库严守 **Apache-2.0** | 严禁复制或引入任何 GPL / AGPL 源码（含 CyberVerse 等），严禁引入 Live2D / Cubism SDK。外部本地 GPU 模型一律通过**进程外 `TutorVideo Sidecar Protocol v1`**接入。 |
| **美术真实性红线** | **禁止用代码伪造角色视频** | Codex 只负责播放器、编排器、导入校验、打包 CLI、ComfyUI 模板与协议实现；绝不得用 canvas 色块或脚本拼图生成冒充二次元老师成品短片。自动化测试仅可在 `tests/` 临时目录构造最小有效媒体测试夹具。 |

---

## 2. 角色清单元数据 `TutorCharacterManifest v3` 与兼容规则

### 2.1 数据模型（后端 `services/api/app/services/tutor_catalog.py`）

新增 `schema_version: Literal[3] = 3` 的角色模型，同时在读取旧 SQLite 数据库时透明兼容 `schema_version == 2` 记录：

```python
VideoTier = Literal["static", "loop_pack", "local_sidecar", "cloud_live"]
ClipSlot = Literal[
    "idle_breathe",
    "listen_nod",
    "think_chin",
    "speak_explain_a",
    "speak_explain_b",
    "board_point",
    "react_praise",
    "react_comfort",
]
```

完整 JSON 结构（`content/characters/*.json` 与 `character_packs.recipe_json`）：

```json
{
  "schema_version": 3,
  "id": "tutor-echo",
  "name": "沐音",
  "appearance": {
    "kind": "portrait",
    "src": "/static/avatars/portraits/echo.png"
  },
  "video_avatar": {
    "aspect_ratio": "9:16",
    "preferred_tier": "static",
    "anchor_image": "/static/avatars/portraits/echo.png",
    "loop_pack": {
      "crossfade_ms": 180,
      "clips": {}
    },
    "local_sidecar": {
      "driver_id": null,
      "fps": 25,
      "resolution": "512x896"
    },
    "cloud_live": {
      "connection_id": null,
      "model": null,
      "idle_suspend_sec": 30,
      "max_session_minutes": 10,
      "max_session_cost_cny": 20.0,
      "action_prompts": {}
    }
  },
  "voice": {
    "engine": "edge",
    "voice_id": "zh-CN-XiaoxiaoNeural",
    "rate": 1.0,
    "pitch": 0
  },
  "persona": {
    "relationship": "擅长语言和表达的老师",
    "traits": ["自然", "耐心", "善于举例"],
    "catchphrases": [],
    "address_user_as": "你"
  },
  "default_style_id": "analogy",
  "license": "Apache-2.0",
  "pack_metadata": {
    "author": "Companion Space",
    "terms": "Apache-2.0",
    "license_url": null,
    "allow_redistribution": true,
    "source_kind": "builtin"
  }
}
```

### 2.2 向下兼容与退役 VRM 处理规则（强制）

1. **旧数据库 `schema_version == 2` 透明升级**：
   - `TutorCatalog._normalize_recipe(recipe)` 接受 `schema_version in (2, 3)`。
   - 若读到 `schema_version == 2` 且 `appearance.kind == "portrait"`：自动水合 `schema_version = 3`、`video_avatar.preferred_tier = "static"`、`video_avatar.anchor_image = appearance.src`，不丢弃用户修改过的 `name / persona / voice / default_style_id`。
2. **已退役的 VRM 角色（`tutor-constraint`、`tutor-shino`、`tutor-fumiriya` 及用户旧版导入的 `.vrm`）**：
   - 不再从 `content/characters/` 写入新数据库。
   - 若旧数据库中仍存在 `appearance.kind == "vrm"` 的行：**不得删除数据库行或 `storage/` 文件**，但在活跃角色列表 `list_characters()` 中过滤掉它们（或按 `include_retired=False` 默认隐藏）。
   - 若 `app_settings["default_character_id"]` 或 `lessons.character_id` 指向已退役的 VRM 角色：`get_character` / `_view` / `_open_plan_item` 必须确定性回退到第一位可用内置二次元老师（优先 `tutor-echo`，其次 `tutor-nova`，再次任意可用角色），绝不返回 500 或白屏。
3. **内置二次元角色的 `.tutorpack` 资源自动发现**：
   - 若 `assets/avatars/packs/<id>/manifest.json` 存在且通过校验，`seed()` 与内置角色水合逻辑可将内置角色默认的 `loop_pack.clips` 绑定到 `/static/avatars/packs/<id>/clips/...` 并默认启用 `preferred_tier = "loop_pack"`，但绝不覆盖用户主动保存过的 `persona`、`voice`、`default_style_id` 或 `preferred_tier`。
4. **保留 `appearance` 字段的兼容窗口**：
   - `appearance.kind` 改为 `Literal["portrait", "video_pack"]`（移除 `"vrm"`），`appearance.src` 指向 `video_avatar.anchor_image`，确保课程历史/欢迎页头像缩略图继续简洁读取。所有 OpenAPI 变更后必须运行 `npm run generate:api` 与 `npm run generate:api:check`。

---

## 3. 微信视频框界面规范（`<TutorVideoBox>`）

替换原有 `apps/web/src/features/classroom/classroom-avatar.tsx`，在 `packages/avatar-engine` 与 `apps/web/src/features/classroom/` 中实现 `<TutorVideoBox>`：

### 3.1 桌面端与移动端布局

- **桌面端（`>= 760px`）**：
  - `.lesson-surface` 维持两栏网格：`grid-template-columns: minmax(280px, 35fr) minmax(0, 65fr)`。
  - 左侧 `.lesson-stage` 呈现为圆角深色底竖屏微信视频框（内部核心视口推荐 `9:16` / `3:4` 自适应充满容器，`object-fit: cover; object-position: center 22%` 保证二次元人物头肩与手势区完整入镜）。
  - **顶部极简覆层**：
    - 左上角状态胶囊：呼吸圆点 + 当前状态（在讲 / 在听 / 在想 / 等你回答 / 已暂停），旁附极简档位小标（静态 / 短片 / 本地实时 / 云端实时）。
    - 右上角（仅 Tier 2/3 活跃时显示）：本地实时延迟或云端通话计时 + 预估费用胶囊，附一键切回免费档按钮。
  - **底部渐变字幕区**：
    - 同步逐句字幕（可点击一键折叠/展开字幕，默认展开），底部栏显示老师姓名、语音能量微动指示，以及 Tier 0/1 降级提示条（仅在从 Tier 2/3 自动降级时展示原因，清晰可关闭）。
- **移动端（`< 760px`）**：
  - 顶部显示紧凑圆角视频通话窗（`aspect-ratio: 4 / 3` 或 `16 / 10`）；当用户向下滚动长白板且视频框滚出视口时，允许使用页内 CSS `position: sticky` 缩略小窗（右上角 `108×144px` 微信同款小窗，点一下回到展开态）。**绝不涉及浏览器外系统悬浮窗。**
- **无障碍与低动效**：
  - 严格遵守 `@media (prefers-reduced-motion: reduce)`：关闭呼吸缩放动画，循环短片切换改为无闪烁直切或显示锚定静图。

---

## 4. 线上一对一双轨演出编排器（`AvatarChoreographer`）

将原有零散的 `avatarState` / `emotion` / `gaze` / `reactionKey` 升级为统一、纯函数可测的演出编排层（位于 `packages/avatar-engine/src/choreographer.ts`）。

### 4.1 六大教学姿态（`TutorPose`）与八段短片映射

| `TutorPose` | 触发来源（主轨） | 默认对应循环/单次短片 | 镜头与演出语义 |
| --- | --- | --- | --- |
| `greeting` | 进课 `opening` 首拍、开场 `say` | `speak_explain_a`（若有 `react_praise` 可作短开场迎宾） | 接通一对一视频通话的微笑开场 |
| `lecturing` | `say` / `say.preview` 播放期间 | 在 `speak_explain_a` 与 `speak_explain_b` 间按 `seg` 奇偶或每拍交替 | 交替手势防单调，打破站桩感 |
| `board_guiding` | `point` / `board` / `mark` / `cue(look="board")` | `board_point`（单次播放约 2.5–3s 后自动接回 `lecturing` 或 `idle_breathe`） | 眼神与手势指向右侧白板再回看镜头 |
| `listening_empathy` | `recording`（按住说话 / 免提开口）、刚触发 `interrupt`、`ask` 刚出现（前 15 秒） | `listen_nod` | 立刻收回讲解动作，温和专注轻点头 |
| `feedback_reaction` | `judge` / `judge.preview` / 副轨抢断微动作 | 答对 → `react_praise`；答错/听不懂 → `react_comfort` | 情绪即时兑现，播完自动接回下一主轨态 |
| `idle_companion` | 等待作答/思考超过 **15 秒** 无操作，或主动点击「休息一下」 | `idle_breathe`（低强度安静伴学态，视觉标记 `data-companion="quiet"`） | 不死盯镜头、消除压迫感；学生聚焦输入框或按键立刻切回 `listening_empathy` |

### 4.2 副轨 150ms 零等待抢断微动作（`InstantActionRouter`）

在真实模型首句生成 + TTS 合成的 `1.5s–3.0s` 窗口内，消除画面僵直：

1. **前端本地 0ms 立即触发（无需等网络往返）**：
   - 点击快捷按钮 `confused` / `slower` / `repeat` → 立即触发 `gentle_encourage`（切入 `react_comfort`），随后进入 `think_chin` 直到首句到达。
   - 点击快捷按钮 `hint` / `example` → 立即触发 `think_chin`。
   - 点击快捷按钮 `show_answer` / 点击白板行 `locate:*` → 立即触发 `board_point`。
   - 按住说话 / 免提检测到打断 / 点击「打断」 → 调用 `driver.interrupt(gen)`，**≤300ms** 内切回 `listening_empathy`（`listen_nod`）。
2. **客观题提交秒级反馈（后端 `judge.preview`）**：
   - 位置：`services/api/app/teaching/runtime.py` + `services/api/app/teaching/live.py`。
   - 当 `student_answer` 命中客观题（`OBJECTIVE_TYPES`）并完成确定性 `grade_objective()` 后、调用 `Realizer.run()` 之前，通过新增的非落库回调 `on_judge(verdict, preview_gen)` 立即下发 WS 帧：
     ```json
     {"v": 1, "lesson_id": "...", "gen": 4, "seq": 0, "type": "judge.preview", "data": {"verdict": "correct"}}
     ```
   - 前端 `use-classroom.ts` 收到 `judge.preview` 后立即经副轨触发 `praise_thumbs_up`（`correct`）或 `gentle_encourage`（`incorrect` / `partial` / `dont_know`），实现 **<150ms** 真实判分情绪兑现。
   - **严守教学引擎红线**：`judge.preview` 仅下发 `verdict` 枚举，绝不提前下发正确答案、解析或未复核文本，且不修改数据库落库事件流与掌握度计算逻辑。
3. **上下文闭环（防嘴手割裂）**：
   - 前端在 `student.quick` / `student.answer` / `student.text` 可附带轻量字段 `recent_avatar_action`（白名单枚举），或由服务端按已知刚触发的 `judge` 写入 `Realizer` 的 `context["recent_avatar_action"]`（序列化在现有 `lesson` 数据块内，不新增未注册 prompt 模板变量），提示模型自然承接刚刚做出的情绪动作。
4. **静默伴学规则**：
   - 15 秒无交互切换 `idle_companion` 纯属前端视觉态，**绝不**向服务端上报答题失败、**绝不**写入掌握度证据。

---

## 5. 前端统一驱动接口（`ITutorVideoDriver`）与四档降级链

重构 `packages/avatar-engine`（保留包名 `@companion-space/avatar-engine` 以避免破坏 monorepo 工作区引用，清理所有 3D / VRM / wlipsync 源码与依赖）：

### 5.1 核心接口契约（`packages/avatar-engine/src/types.ts`）

```ts
export type VideoAvatarTier = "static" | "loop_pack" | "local_sidecar" | "cloud_live";

export type TutorPose =
  | "greeting"
  | "lecturing"
  | "board_guiding"
  | "listening_empathy"
  | "feedback_reaction"
  | "idle_companion";

export type InstantAction =
  | "greet"
  | "empathy_nod"
  | "think_chin"
  | "praise_thumbs_up"
  | "praise_clap"
  | "gentle_encourage"
  | "board_point"
  | "farewell";

export type ClipSlot =
  | "idle_breathe"
  | "listen_nod"
  | "think_chin"
  | "speak_explain_a"
  | "speak_explain_b"
  | "board_point"
  | "react_praise"
  | "react_comfort";

export interface VideoDriverCapabilities {
  tier: VideoAvatarTier;
  lipSyncQuality: "ambient" | "mouth_overlay" | "realtime_neural";
  supportsInstantActions: readonly InstantAction[];
  supportsCustomActionPrompt: boolean;
  hasMeteredCost: boolean;
}

export interface VideoDriverStatusEvent {
  state: "connecting" | "ready" | "suspended" | "degraded";
  tier: VideoAvatarTier;
  reason?: string;
  fallbackTier?: VideoAvatarTier;
}

export interface VideoDriverCostEvent {
  activeSec: number;
  estimatedCostCny?: number;
  suspended: boolean;
}

export interface DecodedSpeechChunk {
  gen: number;
  seg: number;
  pcm16: ArrayBuffer; // mono pcm_s16le 24000 Hz
  sampleRate: 24000;
  last?: boolean;
}

export interface ITutorVideoDriver {
  readonly id: string;
  getCapabilities(): VideoDriverCapabilities;
  mount(container: HTMLElement, config: VideoAvatarRuntimeConfig): Promise<void>;
  unmount(): Promise<void>;
  pushSpeechLevel(level: number): void;
  pushSpeechChunk?(chunk: DecodedSpeechChunk): void;
  setPose(pose: TutorPose, gen: number): void;
  setMood(emotion: string, intensity: number, gen: number): void;
  triggerInstantAction(action: InstantAction, gen: number): void;
  interrupt(gen: number): void;
  suspend?(reason: string): Promise<void>;
  resume?(): Promise<void>;
  onStatusChange(cb: (event: VideoDriverStatusEvent) => void): () => void;
  onCostTick?(cb: (event: VideoDriverCostEvent) => void): () => void;
}
```

### 5.2 四档驱动实现与确定性降级链

`cloud_live (Tier 3) → local_sidecar (Tier 2) → loop_pack (Tier 1) → static (Tier 0)`

1. **Tier 0：`StaticPortraitDriver`**（零依赖永不失败兜底）
   - 渲染 `anchor_image` 在微信视频框内，通过 CSS 自定义属性 `--speech-level`（直接写 DOM style，不触发 React 重渲染）驱动轻柔音频能量光晕与姿态微动效（倾听微前倾、答对暖亮、答错柔和、静默安稳）。
2. **Tier 1：`LoopPackVideoDriver`**（默认高流畅零费用引擎）
   - 容器内维护 **A / B 两个重叠 `<video muted playsInline preload="auto">`** 元素 + 底层 `anchor_image` 防首帧闪黑。
   - **平滑切换算法**：目标短片放入非活跃槽位 → 等待 `readyState >= 2`（或 120ms 超时兜底）→ 播放并触发 `opacity` CSS 过渡（默认 `180ms`）→ 过渡完成后暂停旧槽位并归零。
   - **单次动作短片**（`board_point` / `react_praise` / `react_comfort`）：监听 `ended` 事件（附最长 4s 保险定时器），结束后平滑切回当前主轨 `TutorPose` 对应循环短片。
   - **缺片自动回退**：若角色包只包含部分短片（例如缺少 `speak_explain_b`），自动映射到同组替代片（`speak_explain_a` → `idle_breathe` → `anchor_image`），绝不黑屏或抛错。
   - **过期 `gen` 屏蔽**：任何携带旧 `gen` 的 `setPose` / `triggerInstantAction` 一律忽略；`interrupt(gen)` 立刻取消进行中的单次动作短片并切入 `listen_nod`。
3. **Tier 2：`LocalSidecarVideoDriver`**（本地 GPU 实时数字人驱动，V3 落地）
   - 通过 Companion Space 后端代理创建会话（`/api/v2/avatar-drivers/sidecar/sessions`），支持两种传输模式：
     - `webrtc`（首选）：交换 SDP Offer/Answer，将远端 `MediaStream` 绑定到 `<video>.srcObject`。
     - `ws_frames`（Windows 零编译通用模式）：通过后端代理 WS 接收带头二进制视频帧（见 §7.2），在 `<canvas>` 上以 25–30fps 零拷贝绘制（`createImageBitmap` + `drawImage`）。
   - 同时接收 `SpeechOutput` 解码重采样后的 `24kHz mono pcm_s16le` 音频块及 `pose / mood / instant_action / interrupt(gen)` 控制帧。
   - **1 秒内无崩溃降级**：心跳超时（>2s）、WS 断开、SDP 失败或连续 3 秒无帧时，立即发出 `degraded` 状态事件，由 `VideoDriverManager` 在 **≤1000ms** 内原地切回 `LoopPackVideoDriver`（若无短片包则 `StaticPortraitDriver`），并向用户明确展示断开原因，课堂语音与白板不断线。
4. **Tier 3：`CloudLiveVideoDriver` 槽位与省钱熔断器**（V3 预留接口与熔断框架）
   - 复用现有加密凭据库（`ProviderRegistryService` / `Vault`），严禁明文 Key 落盘或返回前端。
   - 内置 `LiveCostGuard`（纯逻辑可单测）：
     - 统计实际活跃秒数与估算费用，实时通过 `onCostTick` 更新视频框右上角胶囊；
     - 达到单课时长上限（默认 `10 min`）或预算上限（默认 `¥20`）时，自动调用 `DELETE` 释放云端频道并无缝切回 Tier 1；
     - **沉默 30 秒自动挂起**：学生独立思考/做题沉默或点击暂停超过 `idle_suspend_sec`（默认 30s）时，自动暂停/断开昂贵视频流并由 Tier 1 `idle_breathe` 接管画面，学生再次开口或提交作答时按需重连。

### 5.3 `SpeechOutput` 改造（`apps/web/src/audio/speech-output.ts`）

- 移除 `@companion-space/avatar-engine/audio-lip-sync`、`wlipsync` 与 `VisemeWeights` 全部引用。
- 保留轻量 RMS 电平采样（`onLevel`）。
- 新增可选回调 `onSpeechChunk?: (chunk: DecodedSpeechChunk) => void`：当 `SpeechOutput` 将 `mp3` 或 `pcm_s16le` 解码为 `AudioBuffer` 准备调度播放时，将其单声道线性重采样为 `24000 Hz Int16Array` 并附带 `(gen, seg)` 推送给已挂载的实时驱动（若当前为 Tier 0/1 无消费方则跳过重采样，零额外 CPU 开销）。

---

## 6. `.tutorpack` 二次元角色包规范、导入与 ComfyUI 工具链

### 6.1 `.tutorpack` 压缩包结构（标准 ZIP，扩展名 `.tutorpack` 或 `.zip`）

```text
echo-anime.tutorpack (ZIP)
├── manifest.json             # 符合 TutorPackManifest v1（二次元角色元信息 + 许可 + 剪辑映射）
├── anchor.webp               # 必选：基准锚定图（9:16 竖屏，推荐 720×1280 或 576×1024）
└── clips/                    # 可选（若为空则等价为 Tier 0 单图角色）
    ├── idle_breathe.webm
    ├── listen_nod.webm
    ├── think_chin.webm
    ├── speak_explain_a.webm
    ├── speak_explain_b.webm
    ├── board_point.webm
    ├── react_praise.webm
    └── react_comfort.webm
```

### 6.2 后端导入接口与安全校验（`services/api/app/api/routes/tutors.py` + `services/api/app/services/tutorpack.py`）

保留 `POST /api/v2/characters/import`，将支持的导入类型由 `.vrm` 升级为：
1. **单图快速导入**（`.png` / `.jpg` / `.jpeg` / `.webp`，最大 10 MiB）：
   - 用 Pillow 校验真实图片格式、宽高（`256 <= w, h <= 4096`）、像素上限防解压炸弹，转存为受控文件 `storage/characters/<id>/anchor.webp`（清除 EXIF 元数据），立即生成 Tier 0 二次元角色（`preferred_tier = "static"`）。
2. **`.tutorpack` / `.zip` 循环短片包导入**（最大 100 MiB 压缩包、解压总大小 ≤ 150 MiB、最多 32 个文件）：
   - 复用 `CharacterPathMixin._normalize_relative_posix_path` 与 `_contained_child` 严防 Zip-Slip、符号链接、Windows 保留文件名、可执行后缀。
   - 校验 `manifest.json`（严格 Pydantic schema，禁止含 URL 凭据或脚本片段，所有 `persona` 文本按不可信内容限长清洗）。
   - 校验 `anchor` 图片真实头字节；校验 `clips/*.webm`（EBML 头 `\x1a\x45\xdf\xa3`）或 `.mp4`（`ftyp` box），单个短片 ≤ 15 MiB；`clips` 中若至少有 `idle_breathe` 与 `speak_explain_a` 则默认 `preferred_tier = "loop_pack"`，否则提示缺失片段并默认 `static`。
   - 新增资源访问路由 `GET /api/v2/characters/{character_id}/assets/{asset_path:path}`（鉴权、`CharacterPathMixin` 路径封闭校验、`FileResponse` 自动支持 HTTP `Range` 请求、`X-Content-Type-Options: nosniff`），替换原 `/model` 路由。
   - 新增 `DELETE /api/v2/characters/{character_id}`（仅允许删除用户自行导入的角色，禁止删除内置角色，若被设为默认老师则自动回退默认老师）。

### 6.3 开源二次元制作工具链（`tools/tutorpack/`）

为开源社区提供完整零门槛工具（全部 Apache-2.0，放在 `tools/tutorpack/`，不进入 npm workspace，不增加主服务运行依赖）：
1. `tools/tutorpack/cli.py`：
   - `validate <dir_or_tutorpack>`：校验 manifest、anchor、8 段短片格式/魔数/大小/许可字段。
   - `pack <dir> -o <out.tutorpack>`：将素材目录打包为标准 `.tutorpack` 并输出校验报告。
   - `scaffold <name> --anchor <img.png> -o <dir>`：为单张二次元立绘一键生成规范目录、`manifest.json` 模板与 8 段二次元分镜提示词清单。
2. `tools/tutorpack/prompts/anime-8-clips.zh-CN.md`：
   - 针对二次元 / 2.5D 风格优化的 **8 段首尾帧锚定提示词模板**（吸取 V05 经验：固定 `anchor` 首尾帧、强调背景简洁无路人、固定半身中近景机位、防止手部畸变与画风漂移的负向提示词、针对“指向右侧白板”的左右镜像方向提示）。
3. `tools/tutorpack/comfyui/anime_tutor_loop_workflow.json` + `README.md`：
   - 标准 ComfyUI 图生视频（首尾帧锚定 I2V）工作流模板与 8G–16G 显存（如 RTX 5060 8G / 5060Ti 16G）参数说明，方便开源用户本地免费生成 8 段二次元循环短片。
4. 角色库界面（`/characters`）提供「导出单图制片提示词」按钮，直接下载对应角色的 8 段提示词文本。

---

## 7. `TutorVideo Sidecar Protocol v1` 与本地 GPU 参考模板

### 7.1 四个标准端点（Sidecar 服务侧实现）

| 端点 | 方法 / 协议 | 请求 / 响应契约 |
| --- | --- | --- |
| `/v1/avatar/capabilities` | `GET` | 返回 `protocol_version: 1`、`driver_name`、`license`、`transports`（`["webrtc", "ws_frames"]` 子集）、`max_fps`、`supported_resolutions`、`supports_single_image: true`、`instant_actions: [...]`、`gpu_info`（可选）、`ready: bool`。 |
| `/v1/avatar/sessions` | `POST` | 请求：`{ character_id, anchor_image_b64, anchor_mime, aspect_ratio, fps, resolution, transport: "webrtc" \| "ws_frames", sdp_offer?: string }`；响应：`{ session_id, transport, sdp_answer?: string, stream_path: "/v1/avatar/sessions/{id}/stream", fps, width, height }`。 |
| `/v1/avatar/sessions/{id}/stream` | `WS` | **上行（Companion → Sidecar）**：<br>• 文本 JSON 控制帧：`{ type: "pose" \| "mood" \| "instant_action" \| "interrupt" \| "ping", gen: int, payload: {...} }`；<br>• 二进制音频帧：大端头 `TSVA`（4B）+ `gen`（u32）+ `seg`（u32）+ `flags`（u16，bit0=last）+ `sample_rate`（u16，24000）+ `pcm_s16le` 载荷。<br>**下行（Sidecar → Companion）**：<br>• 文本 JSON：`{ type: "ready" \| "pong" \| "stats" \| "error", ... }`；<br>• 若 `transport == "ws_frames"`：二进制视频帧，大端头 `TSVF`（4B）+ `gen`（u32）+ `ts_ms`（u32）+ `codec`（u16：1=webp, 2=jpeg）+ `flags`（u16）+ 图像帧字节。 |
| `/v1/avatar/sessions/{id}` | `DELETE` | 立即释放显存与推理任务，返回 `{ closed: true, active_sec: float }`。 |

### 7.2 Companion Space 后端代理与安全边界（`services/api/app/avatar/` + `services/api/app/api/routes/avatar_drivers.py`）

- 设置存入现有 `app_settings`（key：`avatar_driver_settings`），**无需修改冻结数据库表结构**：
  - `local_sidecars`: 列表，每项 `{ id, label, base_url, transport_preference: "auto" | "webrtc" | "ws_frames", enabled }`。
  - `cloud_live`: 预留 `{ enabled, connection_id, model, idle_suspend_sec, max_session_minutes, max_session_cost_cny }`。
- **严格回环安全校验**（复用 `app.providers.url_policy.validate`）：
  - 本地 Sidecar 默认**仅允许回环地址**（`127.0.0.1`、`localhost`、`::1`）；若显式勾选 `allow_lan`，仅放行 `is_local_endpoint` 私有网段；一律拒绝公网地址、URL 内嵌凭据、查询参数与重定向（`follow_redirects=False`）。
- 后端提供 `/api/v2/avatar-drivers/*`：
  - `GET/PUT /api/v2/avatar-drivers/settings`
  - `POST /api/v2/avatar-drivers/sidecars/test`（探测 `/v1/avatar/capabilities` 并返回能力与延迟）
  - `POST /api/v2/avatar-drivers/sidecar/sessions`（由后端读取角色 `anchor_image` 文件并代发给 Sidecar，浏览器不泄露本地路径）
  - `WS /api/v2/avatar-drivers/sidecar/sessions/{session_id}/stream`（一次性票据鉴权，双向转发控制/音频/视频帧）
  - `DELETE /api/v2/avatar-drivers/sidecar/sessions/{session_id}`

### 7.3 本地 GPU 二次元 Sidecar 开源脚手架与参考模板（`sidecars/local-gpu-avatar/`）

全部采用 **Apache-2.0** 协议，独立于主应用运行环境：
- `protocol.py`：精确的 Pydantic 协议模型 + `TSVA` / `TSVF` 二进制帧编解码工具。
- `adapter_base.py`：`BaseAvatarRenderer` 抽象基类（`load_anchor(image_bytes)`、`on_audio_pcm(gen, seg, pcm_bytes)`、`on_pose(pose, gen)`、`on_instant_action(action, gen)`、`on_interrupt(gen)`、`render_frame() -> bytes`、`close()`）。
- `server.py`：基于 FastAPI + Uvicorn 的开箱即用参考服务，默认监听 `127.0.0.1:8090`，完整实现 4 个协议端点与 `ws_frames` 实时流推送 + `gen` 级原子打断。
- `adapters/anime_2d_reference.py`：开箱即可用于协议联调与低配电脑试跑的纯 Pillow 二次元动态参考适配器（对传入的单张二次元 `anchor_image` 实时施加呼吸起伏、随 24kHz PCM 音量驱动的细腻语态响应、点头/指白板/点赞微位移动效并输出 25fps WebP 流——诚实标注为“协议参考基线渲染器”，不冒充神经网络口型模型）。
- `adapters/gpu_bridge_template.py` + `README.md`：给开源社区和所有者本机 RTX GPU（如 RTX 5060 8GB）的**神经网络本地推理对接模板**（明确注释如何将 `on_audio_pcm` 与 `render_frame` 接入用户自行安装的 MuseTalk / LivePortrait / LiveAct / FlashHead 推理进程，附 VRAM 选型表与独立虚拟环境安装指南，主仓不打包任何 GPL 代码或模型权重）。

---

## 8. 3D VRM 依赖与资产退役清单

| 类别 | 处置动作 |
| --- | --- |
| **前端依赖** | 从 `packages/avatar-engine/package.json` 及锁文件移除：`three`、`@types/three`、`@pixiv/three-vrm`、`@pixiv/three-vrm-animation`、`@react-three/fiber`、`three-vrm-lip-sync`、`wlipsync`。 |
| **前端 3D 源码** | 删除 `packages/avatar-engine/src/{vrm-stage.tsx,vrm-recipe.ts,vrm-appearance.ts,vrm-speech-controller.ts,viseme.ts,audio-lip-sync.ts,pet-registry.ts}`；重塑为纯视频驱动模块（`types.ts`、`choreographer.ts`、`static-driver.ts`、`loop-pack-driver.ts`、`sidecar-driver.ts`、`cost-guard.ts`、`video-box.tsx`）。 |
| **后端 VRM 校验** | 移除 `tutor_catalog.py` 中 `.vrm` 导入逻辑与 `tutors.py` 的 `/model` 路由；历史兼容文件（若仍有其他测试引用先 grep 确认）无引用则移除。 |
| **VRM 资产与角色卡** | 将 `assets/avatars/models/*.vrm` 与 `content/characters/{7-constraint,8-shino,9-fumiriya}.json` 移入 `assets-archive/retired-vrm/`（保留记录不直接丢失，不再打入便携包或参与运行时）。 |
| **许可与便携包脚本** | 更新 `assets/avatars/LICENSES.md`、`assets/THIRD_PARTY_NOTICES.md`（移除 wLipSync/three-vrm-lip-sync 与已归档 VRM 条目）、`scripts/build-portable.ps1`（更新 `PORTABLE-ASSET-STATUS.md` 说明并复制 `assets/avatars/packs/` 若存在）。 |
| **旧规格归档标注** | 在 `docs/rebuild/spec/character-pipeline.md` 顶部补充一行“已被 `spec/tutor-video-avatar.md` 取代（不再执行支线 C）”，并在 `docs/rebuild/DECISIONS.md` 追加本次决策记录。 |

---

## 9. 机械门禁与质量红线（每次提交前必过）

1. **唯一验收门**：`powershell -NoProfile -ExecutionPolicy Bypass -File scripts/gate.ps1 -Frontend -Contract` 必须全绿。
2. **`scripts/check_no_fakes.py` 硬规则**：
   - 产品源码（`services/api/app`、`apps/web/src`、`libs/prompts/v3`、`packages/*/src`）中**不得出现**单词 `mock`、`fake`、`demo_mode`、`canned`（不区分大小写，注释里也不行）。
   - `apps/web/src/features/{classroom,learner,plan,review}` 的 TS/TSX 与 `services/api/app/{teaching,learning,analysis,voice}` 的 Python 源码中，字符串字面量**不得包含 4 个及以上汉字**；全部中文文案放入 `apps/web/src/locales/zh-CN.json`（且**单条文案不得超过 60 个字符**）或 `services/api/app/i18n/zh-CN.json`。
3. **OpenAPI 契约同步**：修改任何 `/api/v2` Pydantic 模型或路由后，必须运行 `npm run generate:api` 并确保 `npm run generate:api:check` 通过。
4. **异步数据库纪律**：FastAPI 异步路由不得直接阻塞调用同步 SQLite 或磁盘大文件 I/O，使用 `await asyncio.to_thread(...)`。
