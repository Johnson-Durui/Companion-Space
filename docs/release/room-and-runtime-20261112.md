# 互动书房与运行稳定性 · 2026-11-12

从「今日」进入书房，选择空间后可恢复该空间的上次共学。暖灯、暮色、专注计时、资料书架和伙伴切换都在书房内。手机上，主操作、立绘、对白和快捷入口分别占用自己的布局区域。复习任务和确认记忆从书房下方进入。

- [桌面书房 1440px](screenshots/room-refresh-desktop.png)
- [手机书房 390px](screenshots/room-refresh-mobile.png)

书房并行读取空间和角色，随后读取当前空间的会话。切换空间时，迟到的响应不会覆盖新的选择。倒计时按秒刷新显示，暂停和恢复按时间戳计算。共学路由的缺参提示使用轻量原生元素。两次同环境生产构建的 Next.js 输出显示，共学路由首载 JavaScript 从 643 kB 降至 168 kB。VRM 和 Mermaid 继续在相应功能需要时加载。

API 继续按领域组织路由。公开契约包含 74 个 HTTP 操作及一个实时 WebSocket，新增的语音试听使用已有 Owner 鉴权和 Provider 适配器，浏览器断开时取消合成。设置步骤见 [语音服务接入](../voice-service.md)。

公开版 NOVA 和 ECHO 的 UV 方向及发型开口修复已保留。几何验证检查四个手绘角色各五处面部可见点，以及两个程序化角色各三个眼口可见点。角色换色保留原有自发光与边缘光。

## 素材来源

公开图像检索使用三组查询，分别围绕观测室窗格、黄铜折射望远镜和历史阅读室。格林尼治八角房的竖向窗格、Beam 设计的观测模式低照度与皇家学会展示的观测仪器材质用于确定构图和光线。配图来自各自来源，供阅读参考。 [八角房照片](https://commons.wikimedia.org/wiki/File:Flamsteed_House_-_Royal_Observatory_Greenwich_-_Octagon_Room_-_telescope_(8131334441).jpg) · [Beam 照明项目](https://www.beamld.com/the-great-equatorial-telescope) · [英国皇家学会](https://royalsociety.org/blog/2019/03/talking-clocks/)

用 Exa 检索交互参考时，Virtual Study Room 的房间视图和计时器提供了功能层级的参考。 [Virtual Study Room 源仓库](https://github.com/virtual-study-room/virtual-study-room-frontend)

手机背景使用内置 OpenAI 图像生成工具根据文字生成，素材目录中包含一张 800 × 1200、49,284 字节的 WebP。它只在窄屏样式中请求。许可证和校验值见 [素材声明](../../assets/THIRD_PARTY_NOTICES.md)。

<details>
<summary>手机背景生成提示词</summary>

> Use case: illustration-story. Create an original portrait 2:3 background image for the narrow mobile version of an anime-inspired local study companion app, a quiet private astronomical study at blue hour. Refined hand-painted environmental concept art, subtle tactile brushwork, realistic walnut, brass and dark teal, like an understated illustrated novel interior. Looking toward a large arched mullioned window in the middle-to-lower right, a sliver of indigo sky and a few natural stars, brass refractor telescope at the right window, walnut writing table and a closed book with a soft amber reading lamp in the lower left, restrained foliage. IMPORTANT layout: top 38% is mostly plain very dark petrol-green woodwork and low contrast, intentionally quiet so white UI text placed by the app is legible. Lower 15% darkened toward the edge for UI controls, softly visible window highlights toward the mid-right, avoid large bright patches. Full-bleed portrait crop, intimate and spacious, black-green shadows, honey gold details, indigo sky. This is a scene background only. No people, no figures, no characters, no UI, no words, no lettering, no signage, no logo, no watermark, no frame.

</details>

## 验证

- API 564 通过、3 跳过，包含公开路由契约、取消与鉴权。TTS sidecar 的隔离单元测试 30 通过。
- Web 类型检查、ESLint 与生产构建通过。书房浏览器回归 8 项通过，覆盖 320px 窄屏点击区域、错序响应、会话隔离、失败重试和解锁入口。
- 本机首轮全量浏览器回归有 114 项通过、2 项按配置跳过。Mori 重进工作室后就绪标记被资产刷新重置，修复后 Mori 持久化、坏图集提示和 Yuzu 运行三项重跑通过。Intel 硬件 WebGL 下持续采样的帧率中位数达到 30 FPS 门槛。
- Windows 启动、测试进程清理、隔离存储与源码打包均有回归检查。移动端 Web 壳完成静态检查、类型检查和构建。
- 使用 Windows PowerShell 5.1 启动生产构建，验证了隔离 API、书房、Vault 初始状态和手机素材响应。
- Docker Compose 隔离运行覆盖 Caddy HTTPS、首页、Vault 初始状态和实时 WebSocket 鉴权。临时服务与测试卷已清理。
- npm 生产依赖审计为 0 高危、0 严重、0 中危、2 低危。

浏览器和 API 测试使用 Mock 或受控提供商。真实模型、GPU 神经语音、实体麦克风、移动真机及商店签名由目标环境验收。
