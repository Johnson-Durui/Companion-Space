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
