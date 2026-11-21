# 二次元老师《1 张图 → 8 段教学循环短片》开源提示词手册

> 适用于 Companion Space 纯视频微信通话框（`<TutorVideoBox>`）的 **Tier 1 `.tutorpack`** 制片标准。
> 推荐画风：**二次元 / 2.5D 高精度插画风**（与仓库自带的 **沐音 Echo**、**星澜 Nova** 风格一致）。

---

## 一、锚定基准图（`anchor.webp`）出图要求

1. **构图**：竖屏 `9:16`（推荐 `720×1280` 或 `576×1024`），人物居中、头肩至胸口中近景（上沿留出 ~12% 空间，避免头顶被视频框顶栏遮挡）。
2. **表情与目光**：自然柔和微笑、正视镜头（眼睛位于画面上 1/3 线附近）。
3. **背景避坑（关键）**：简洁温暖的书房/教室/台灯柔光背景，**绝不要出现其他路人或动态杂物**，否则视频生成模型容易在背景里产生鬼影或穿帮。
4. **首尾帧锚定**：生成以下 8 段短片时，将 **`anchor.webp` 同时作为首帧（Start Frame）和尾帧（End Frame）**，这样每段短片都能无缝自循环，且任意两段之间 180ms 交叉淡化几乎无跳帧感。

### 通用负向提示词（Negative Prompt）

```text
blurry, lowres, deformed hands, extra fingers, mutated fingers, fused hands, face flicker, identity drift, camera zoom, camera pan, shaking camera, extra people in background, text, watermark, subtitle, sudden cut, harsh strobe lighting, 3d plastic render
```

---

## 二、8 段标准教学短片分镜与提示词

| 槽位文件名 | 时长 | 循环模式 | 英文提示词（推荐直接用于 ComfyUI / I2V 模型） | 中文动作要点 |
| :--- | :---: | :---: | :--- | :--- |
| `clips/idle_breathe.webm` | 4s | 循环 | `Anime 2.5D portrait, static camera, fixed framing. Gentle natural breathing, soft shoulder movement, blinking calmly twice, warm relaxed eye contact with camera, subtle hair sway, seamless loop back to start pose.` | 自然呼吸、轻眨两次眼、微微笑看镜头、发丝轻晃 |
| `clips/listen_nod.webm` | 4s | 循环 | `Anime 2.5D portrait, static camera. Leaning slightly forward attentively, warm focused eyes looking at camera, giving two slow gentle encouraging nods while listening patiently, natural breathing, seamless return to start pose.` | 微前倾专注倾听、间隔轻点两次头、眼神温柔鼓励 |
| `clips/think_chin.webm` | 3s | 循环 | `Anime 2.5D portrait, static camera. Gently raising one hand to rest fingertips lightly near chin in thoughtful pose, eyes glancing slightly upward while thinking, then softly smiling back at camera, smooth return to start pose.` | 单手轻托下巴思索、眼神微抬再微笑看回镜头 |
| `clips/speak_explain_a.webm` | 5s | 循环 | `Anime 2.5D tutor speaking warmly to camera, static camera. Natural conversational mouth movement, gentle expressive right-hand explaining gesture near chest level, engaged friendly eyes looking at viewer, smooth return to start pose.` | 自然说话口型 + 柔和单手胸前讲解手势、眼神紧跟镜头 |
| `clips/speak_explain_b.webm` | 5s | 循环 | `Anime 2.5D tutor explaining key points, static camera. Natural conversational mouth movement, alternating soft two-hand counting and open-palm teaching gestures, brief natural glance toward right side then back to viewer, smooth return to start pose.` | 交替双手数要点/轻摊手势 + 间歇轻瞥右侧再回看镜头 |
| `clips/board_point.webm` | 3s | 单次 | `Anime 2.5D tutor guiding attention to the whiteboard on the viewer's right side, static camera. Turning head and gaze clearly toward the RIGHT edge of the frame, raising hand smoothly to point toward the right side, pausing briefly, then turning back to smile warmly at the camera.` | **重要**：眼神与抬手明确指向**画面右侧**（即右侧白板方向），停顿后微笑看回镜头 |
| `clips/react_praise.webm` | 3s | 单次 | `Anime 2.5D tutor celebrating a correct answer, static camera. Eyes curving into a bright genuine happy smile, raising a cheerful thumbs-up gesture near chest, warm encouraging nod, smooth return to start pose.` | 眉眼弯起灿烂笑容 + 竖大拇指点赞肯定 |
| `clips/react_comfort.webm` | 3s | 单次 | `Anime 2.5D tutor gently reassuring a learner, static camera. Soft empathetic smile, gentle slow nod forward with calm open-palm comforting gesture conveying patience and warmth, smooth return to start pose.` | 温和安抚微笑 + 轻点头与舒缓摊手（“没关系慢慢来”） |

---

## 三、推荐转码参数（输出轻量 WebM / VP9）

把生成的 MP4 转为无音轨、高压缩、网页秒开的无黑帧 WebM（推荐每段 1.5–3 MB）：

```powershell
ffmpeg -i input.mp4 -an -c:v libvpx-vp9 -b:v 0 -crf 30 -pix_fmt yuv420p -r 24 -vf "scale=576:1024:force_original_aspect_ratio=increase,crop=576:1024" clips/idle_breathe.webm
```

---

## 四、一键校验与打包

```powershell
# 1. 从单张二次元立绘生成标准目录
python tools/tutorpack/cli.py scaffold "沐音" --anchor assets/avatars/portraits/echo.png -o ./echo-pack

# 2. 将生成好的 8 段短片放入 ./echo-pack/clips/ 后校验并打包
python tools/tutorpack/cli.py pack ./echo-pack -o echo-anime.tutorpack
```

然后打开 Companion Space 的 **「角色库」** 页面，直接把 `echo-anime.tutorpack` 拖入上传区，点试演按钮检查 8 段短片过渡效果即可！
