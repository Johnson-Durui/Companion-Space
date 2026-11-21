# Companion Space `.tutorpack` 二次元角色包工具链（Apache-2.0）

本目录提供一套零门槛、开源合规的命令行工具与 ComfyUI 模板，用于把**1 张二次元立绘**扩展为 **8 段首尾帧锚定的教学循环短片包（`.tutorpack`）**，导入 Companion Space 即可在微信视频通话框中零独显、零实时 API 费用实现 60fps 流畅一对一授课演出。

## 快速开始

### 1. 生成标准目录与提示词清单

```powershell
python tools/tutorpack/cli.py scaffold "沐音" --anchor assets/avatars/portraits/echo.png -o ./echo-pack
```

执行后会在 `./echo-pack/` 下生成：
- `anchor.webp`（自动清除 EXIF 并转为标准 WebP）
- `manifest.json`（标准角色清单）
- `clips/`（放置 8 段生成短片的目录）
- `PROMPTS.md`（二次元 8 段标准提示词）

### 2. 本地免费生成 8 段二次元短片（ComfyUI）

- 打开 ComfyUI，加载 `tools/tutorpack/comfyui/anime_tutor_loop_workflow.json`；
- 将 `anchor.webp` 同时绑定为首帧与尾帧；
- 依次复制 `tools/tutorpack/prompts/anime-8-clips.zh-CN.md` 中的 8 段提示词生成短片，保存至 `./echo-pack/clips/`；
- 推荐显存参考：
  - **RTX 5060 8 GB**：使用 FP8/GGUF Q4 量化权重 + CPU Offload，分辨率 `576×1024`，每段 3–4 秒（24fps）。
  - **RTX 5060Ti 16 GB**：使用 FP8 权重，分辨率 `720×1280`，每段 4–5 秒（24fps）。

### 3. 校验与一键打包

```powershell
python tools/tutorpack/cli.py validate ./echo-pack
python tools/tutorpack/cli.py pack ./echo-pack -o echo-anime.tutorpack
```

> 即使暂时只生成了其中 2–3 段（例如 `idle_breathe` 与 `speak_explain_a`），也可直接打包导入——Companion Space 会在缺失槽位自动平滑回退，后续补齐再重新导入即可。

### 4. 导入到 Companion Space

打开应用进入 **「角色库」** 页面，直接把 `.tutorpack`（或单张二次元图片）拖入上传区，点击「试演教学动作」立即检验切换效果。
