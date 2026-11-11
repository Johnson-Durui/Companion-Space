# 语音服务接入

入口是「声音与模型 → 语音接口配置」（`/providers#voice-service`）。角色编辑页也有「配置语音接口」链接。先解锁本地保险箱，再保存连接、测试实际合成、绑定学习空间。

## 本地 Qwen

页面可以直接保存自己的本地连接，不需要为了注册连接修改 `.env`。模型服务仍需单独启动。

| 字段 | 本机默认值 |
| --- | --- |
| 协议类型 | 本地 Qwen · `local-neural` |
| 接口地址 | `http://127.0.0.1:8001` |
| 语音模型 | `qwen3-tts-0.6b-customvoice` |
| 声线 ID | `Serena` |
| 语速 | `1.00` |
| API Key | 不需要，页面不会要求填写 |

本项目还提供 `Vivian`、`Dylan`、`Eric`、`Uncle_Fu` 声线选项。模型名和声线 ID 是两个不同字段。

如果已经构建过项目的 `neural-tts` Docker 镜像，启动 Docker Desktop 后，可在项目根目录执行：

```powershell
.\START-NEURAL-TTS-HOST.ps1
```

该脚本只启动已有镜像，将服务映射到 `127.0.0.1:8001`，不会构建镜像。服务的 `/healthz` 返回 `status=ready` 才表示模型已加载；首次安装模型和 Docker 部署见 [Windows 启动说明](../WINDOWS-README.md)。

接口地址由项目后端访问。本机运行 API 时使用上表地址；API 与语音服务都在同一个 Compose 网络中时，通常填写 `http://neural-tts:8001`。容器内的 `127.0.0.1` 指向容器自身。

依次点击「保存语音连接」「读取模型列表」「测试并试听」。读取模型列表只能确认服务返回的模型信息；听到实际合成结果才完成试听检查。服务未启动、模型或声线不支持时，页面会显示错误，不会自动换成 Mock。

## 在线服务

在「新建语音连接」中选择项目支持的 `openai-compatible` 或 `elevenlabs` 协议，填写连接名称、API Key，以及协议允许自定义时的 Base URL。模型名和 Voice ID 使用该服务实际支持的值；可以读取模型列表，也可以手动填写模型名。

API Key 保存到后端加密保险箱，不回填页面。编辑已有连接时 Key 留空表示保留原值。内置 Mock 和内置 Neural TTS 连接不可编辑；需要不同地址时创建自己的连接。

## 让角色使用这个声音

1. 在「绑定学习空间」选择目标空间，点击「绑定到空间」。这会保存该空间的 TTS 连接与模型；其他能力和其他空间不变。
2. 点击「设置角色声线」，在角色编辑页保存声线 ID、语速及角色配方。接口页的声线和文字用于试听，不会自动覆盖角色设置。
3. 新建共学会话使用新的空间绑定。已经创建的会话保留其原有模型配置。

试听过程中可以停止；修改输入、切换连接或空间、离开页面会停止本页播放，迟到响应不会重新发声。HTTP 请求断开后，后端会取消合成任务；本地 Qwen 适配器还会发送对应推理 ID 的取消请求。Mock 只产生测试音，用于检查接口和播放流程。

## 给其他程序调用

以下地址属于本项目 API。本机启动默认 API 根地址为 `http://127.0.0.1:8000`；使用自己的启动端口时相应替换。

所有连接管理、模型查询、试听和空间绑定都需要 `Authorization: Bearer <OWNER_TOKEN>`。使用解锁保险箱后取得的临时 Owner token；语音供应商的 Key 由后端从保险箱读取，不放在试听请求中。

| 用途 | 方法与路径 |
| --- | --- |
| 查看已保存连接 | `GET /api/v1/providers/connections` |
| 新建连接 | `POST /api/v1/providers/connections` |
| 修改连接 | `PATCH /api/v1/providers/connections/{connection_id}` |
| 查询语音模型 | `GET /api/v1/providers/connections/{connection_id}/models?capability=tts` |
| 合成试听音频 | `POST /api/v1/providers/connections/{connection_id}/speech-preview` |
| 绑定空间 TTS | `POST /api/v1/spaces/{space_id}/assignments` |

创建本地连接的 JSON 请求体：

```json
{
  "provider": "local-neural",
  "label": "本地 Qwen 语音",
  "base_url": "http://127.0.0.1:8001",
  "api_key": ""
}
```

用返回的连接 ID 调用试听接口：

```http
POST /api/v1/providers/connections/<connection_id>/speech-preview
Authorization: Bearer <OWNER_TOKEN>
Content-Type: application/json

{
  "model": "qwen3-tts-0.6b-customvoice",
  "text": "你好，我们一起开始今天的学习吧。",
  "voice_id": "Serena",
  "speaking_rate": 1.0
}
```

成功响应为原始 PCM16 小端音频：24,000 Hz、单声道，`Content-Type: audio/pcm;rate=24000`，并带 `X-Audio-Sample-Rate: 24000`、`X-Audio-Channels: 1` 和 `Cache-Control: no-store`。它不包含 WAV 文件头，调用方应按 PCM16 播放或自行封装。允许的浏览器来源可以跨端口读取这两个音频头。

试听文本限 240 字符，模型名限 200 字符，声线 ID 限 120 字符，语速范围为 0.5–2.0。服务端拒绝空音频、非完整 PCM16 样本及超过 10 MiB 的试听结果。该试听接口汇总音频后返回；若要接入实时通话，继续使用项目现有会话语音协议。

空间绑定请求体：

```json
{
  "capability": "tts",
  "provider_connection_id": "<connection_id>",
  "model_name": "qwen3-tts-0.6b-customvoice"
}
```

完整请求模型可在运行中的 API `/docs` 查看。接口页也提供按当前填写值生成的调用示例，仅显示 token 占位符。
