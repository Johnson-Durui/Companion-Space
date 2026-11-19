# Companion Space 本地 GPU 二次元实时视频 Sidecar 模板（Apache-2.0）

本目录是 **Companion Space `TutorVideo Sidecar Protocol v1`** 的官方开源参考服务与本地 GPU 模型适配模板（100% Apache-2.0，完全独立于主应用运行环境，不引入任何 GPL 代码或模型权重）。

## 为什么采用独立 Sidecar？

1. **许可干净**：主仓库严守 Apache-2.0；用户可在本地独立 Python 环境中自由挂载任何自己安装并核对过许可的开源实时数字人推理引擎。
2. **故障隔离**：显存溢出或进程关闭时，Companion Space 会在 **≤1 秒**内平滑回落到 Tier 1 循环短片或 Tier 0 立绘，老师的语音和白板全程不掉线。
3. **Windows 零编译开箱即用**：除支持 WebRTC 外，协议内置 `ws_frames` 二进制帧流（`TSVA` 上行 24kHz PCM 音频 / `TSVF` 下行 WebP 视频帧），无需在 Windows 上折腾 `aiortc` / C++ 编译工具链。

---

## 快速启动（2 分钟联调协议）

```powershell
cd sidecars\local-gpu-avatar
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m uvicorn server:app --host 127.0.0.1 --port 8090
```

随后打开 Companion Space → **「设置 → 视频形象」**：
1. 添加本地驱动地址 `http://127.0.0.1:8090`；
2. 点击 **「测试连接」**（应返回 `anime-2d-protocol-reference` 与延迟）；
3. 保存并在角色库把老师的默认视频档位切到 **「本地实时」**，进课堂即可体验实时帧流与拔线 1 秒自动回落。

> **说明**：默认内置的 `anime_2d_reference` 是基于 Pillow 的轻量协议联调基线渲染器（响应 24kHz PCM 语音能量、姿态切换与 150ms 抢断微动作），不冒充神经口型模型。

---

## 挂载你本机的 RTX GPU 二次元实时模型

参考 `adapters/gpu_bridge_template.py`，在你独立的 CUDA 虚拟环境中实现 `BaseAvatarRenderer` 的 6 个回调即可接入：

| 推荐开源路线 | 显存参考 | 适合场景 | 对接提示 |
| :--- | :--- | :--- | :--- |
| **MuseTalk（轻量口型层）** | **4–6 GB**（RTX 5060 8GB 充裕） | 单张二次元立绘精准口型 + 轻微头部动作 | 在 `load_anchor` 预计算人脸坐标/Latent，在 `on_audio_pcm` 送入流式音频特征 |
| **LivePortrait + 音频驱动** | **6–8 GB**（RTX 5060 8GB） | 细腻眨眼、眼神、微笑与微点头表情 | 在 `on_pose` / `on_instant_action` 叠加对应表情关键点偏置 |
| **LiveAct / FlashHead 等全身流模型** | **12–24 GB**（RTX 5060Ti 16GB / 4090） | 实时半身/全身自然手势 + 精准口型 | 在 `on_interrupt(gen)` 立刻清空音频与潜空间队列实现 ≤300ms 打断 |

启动自定义 GPU 适配器：

```powershell
$env:AVATAR_ADAPTER = "gpu_bridge"
.\.venv\Scripts\python.exe -m uvicorn server:app --host 127.0.0.1 --port 8090
```

---

## 协议端点速查（`TutorVideo Sidecar Protocol v1`）

- `GET /v1/avatar/capabilities`：返回协议版本、驱动名、许可、支持传输方式、最大帧率与 GPU 信息。
- `POST /v1/avatar/sessions`：接收角色 `anchor_image_b64` 与目标分辨率/帧率，创建推理会话。
- `WS /v1/avatar/sessions/{id}/stream`：
  - 上行文本 JSON：`pose` / `mood` / `instant_action` / `interrupt` / `ping`；
  - 上行二进制 `TSVA`：`>4sIIHH`（`TSVA` + `gen` + `seg` + `flags` + `sample_rate`）+ `pcm_s16le`；
  - 下行二进制 `TSVF`：`>4sIIHH`（`TSVF` + `gen` + `ts_ms` + `codec` + `flags`）+ WebP/JPEG 帧字节。
- `DELETE /v1/avatar/sessions/{id}`：释放显存与推理资源，返回本次活跃时长。
