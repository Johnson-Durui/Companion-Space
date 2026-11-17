# Live2D / Spine 许可运行时 Bridge

Companion Space 可以安全导入 AIRI v0.11.3 的 `live2d-zip` 与 `spine-zip` 显示模型，但不会随应用下载或分发专有运行时。模型只有在部署者提供同源、协议匹配且已取得相应授权的 bridge 后才会渲染；否则界面明确显示阻止原因，角色人格和文字会话仍可使用。

## 许可前提

- Live2D Cubism Core 不属于 AIRI 的 MIT 授权。发布前请核对 [Live2D SDK License](https://www.live2d.com/en/sdk/license/) 与 [Expandable Application 条款](https://www.live2d.com/en/sdk/license/expandable/)。
- Spine Runtime 受独立许可约束。集成者应核对 [Spine Runtimes License](https://en.esotericsoftware.com/spine-runtimes-license) 并持有适用的 Spine Editor 许可。
- AIRI 仓库的 MIT 许可不自动覆盖角色模型、纹理、动作、Cubism Core 或 Spine Runtime。

仓库不得提交上述专有运行时或未经授权的角色资产。bridge 与模型的授权、分发和归因记录由部署者负责。

## 配置

将 bridge 构建为与 Companion Space 同源的浏览器 ES module。最简单的正式部署方式是把已授权的 bundle 及其合法依赖放入本机 `apps/web/public/licensed-runtime/`；该目录已被 Git 忽略，Docker Web 构建会复制它，但它不会被误提交到源码仓库。随后在 `.env` 中设置其中一项或两项：

```dotenv
NEXT_PUBLIC_LIVE2D_RUNTIME_BRIDGE_URL=/licensed-runtime/live2d-bridge.js
NEXT_PUBLIC_SPINE_RUNTIME_BRIDGE_URL=/licensed-runtime/spine-bridge.js
```

`NEXT_PUBLIC_*` 会在 Next.js 构建时写入浏览器 bundle，修改后必须重新构建 Web：

```powershell
docker compose up -d --build web
```

空值是安全默认：对应格式仍可导入和保存，但渲染状态为 `blocked / bridge-unconfigured`。

## Bridge 协议

模块的默认导出必须实现以下协议。`format` 对 Live2D 为 `live2d`，对 Spine 为 `spine`。

```ts
type RuntimeState = {
  state: "idle" | "listening" | "thinking" | "speaking";
  emotion: "neutral" | "warm" | "cheerful" | "curious" | "focused" | "playful" | "concerned";
  speechLevel: number;
  reducedMotion: boolean;
};

export default {
  protocol: "companion-avatar-runtime/v1",
  format: "live2d", // 或 "spine"
  async create(input: {
    mount: HTMLElement;
    archive: Blob;
    entrypoint: string;
    sha256: string;
    signal: AbortSignal;
    initial: RuntimeState;
  }) {
    // 只解析 input.archive 中由 entrypoint 指向的本地资源。
    const ready = renderFirstFrame();
    return {
      instanceId: "optional-stable-id",
      // ready 必须在第一帧实际完成后 resolve；届时 mount 内至少有一个 canvas。
      ready,
      update(next: RuntimeState): void | Promise<void> {},
      resize(width: number, height: number, devicePixelRatio: number): void | Promise<void> {},
      async destroy() {},
    };
  },
};
```

宿主会在调用 `destroy()` 前取消 `signal`，并保证角色切换、离页、创建失败和运行时错误时清空 mount。bridge 自身仍必须释放 renderer、texture、WebGL context、事件监听器、计时器以及其创建的所有 object URL。

## 安全与验收

- bridge URL 必须与页面同源；跨源 URL、错误协议或错误格式会被拒绝。
- 服务端已校验并保存整个内部 ZIP；bridge 不得访问模型声明之外的远程 URL。
- 浏览器会再次计算 ZIP SHA-256，和服务端 manifest 不一致时不会调用 bridge。
- `create()` 返回的句柄必须提供 `ready: Promise<void>`；只有该 Promise 在首帧后 resolve、初始化 `resize/update` 成功且 mount 内仍存在 canvas，宿主才会进入 `ready`。
- `update()` 或 `resize()` 的同步异常和异步拒绝都会终止当前实例、清空 canvas 并进入可见 `runtime-invalid`，不得产生未处理的 Promise rejection。
- bridge 失败不得切换成内置 VRM 或 CSS 立绘；这避免把错误角色呈现为当前会话角色。
- 导入不会自动改变任何学习空间。用户需在通话页为下一次新会话选择角色，或在角色详情页显式设为空间默认角色。

页面可观察属性包括 `data-avatar-runtime-kind`、`data-runtime-mode`、`data-runtime-reason`、`data-runtime-instance` 与 `data-runtime-canvas-count`，可用于本地验收和诊断，但不得写入 bridge URL、模型路径或模型内容。
