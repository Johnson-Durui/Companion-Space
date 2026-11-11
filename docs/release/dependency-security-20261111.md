# 2026-11-11 依赖补丁与审计

本记录对应本轮源码交付。审计反映运行当天已知公告，不代表不存在尚未披露的问题。

## 最终结果

| 范围 | 结果 |
| --- | --- |
| npm 生产依赖 | 0 critical、0 high、0 moderate、2 low |
| npm 完整依赖（含开发工具） | 0 critical、0 high、8 moderate、2 low |
| Python 生产 requirements | 39 个解析依赖，0 已知漏洞 |
| 安装完整性 | npm 11.21.2 全新 `ci`、`npm ls --all` 和独立 Python `pip check` 通过 |

机器可读证据随包保存在 [evidence](evidence/) 目录：`npm-audit.json`、`npm-audit-production.json` 和 `python-audit.json`。

## 采用的兼容更新

- Next.js / eslint-config-next：15.5.29。
- Capacitor core / android / ios / cli：8.6.0；原生生成配置与版本检查已同步。
- DOMPurify 3.4.17、js-yaml 4.3.2、sharp 0.35.5、source-map-js 1.2.2、PostCSS 8.5.23、nanoid 3.3.20。
- xmldom 0.9.12；brace-expansion 按调用方范围解析为 1.1.22 与 5.0.13，移除了跨主版本的全局强制覆盖。
- pypdf 从 6.15.0 升级至 6.21.4，修复独立审计发现的 29 条 PDF 解析漏洞记录。升级后的资料导入路径与 API 全量回归通过。

没有执行 `npm audit fix --force`，没有迁移到 Next 16、Mermaid 12 或 pypdf 7。

## 为什么安装固定 npm 版本

npm 11.9 会在 workspace 链接中丢失传递依赖的 override，使 Next 精确声明的旧 PostCSS 留在依赖树。上游记录见 [npm/cli #9659](https://github.com/npm/cli/issues/9659)、[修复 PR #9673](https://github.com/npm/cli/pull/9673) 和 [11.18.0 发布记录](https://github.com/npm/cli/releases/tag/v11.18.0)。

本包使用 npm 11.21.2 生成并验证锁文件。首次安装运行：

```powershell
npx.cmd --yes npm@11.21.2 ci
```

该命令不替换系统全局 npm。日常启动和 `npm.cmd run` 仍可使用现有 npm。

## 剩余问题与适用范围

两个生产 low 来自同一条 Mermaid 11 → KaTeX 链，见 [GHSA-238p-pmpm-9mq7](https://github.com/advisories/GHSA-238p-pmpm-9mq7)。审计提供的修复涉及 Mermaid 12 主版本迁移，需要独立验证板书、SVG/HTML 清理和演示渲染，未混入本轮兼容补丁。

八个开发 moderate 位于 ESLint/typescript-eslint 和 Capacitor CLI 的 glob/minimatch/rimraf 工具链，不在生产依赖审计范围内。构建工具仍需后续更新；本记录没有把它们描述为已修复。

真实 Provider、签名密钥、实体麦克风、真机与商店发布没有参与这些审计。Android 构建通过不代表 iOS Xcode 或商店签名已经验收。
