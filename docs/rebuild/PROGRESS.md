# Progress

## M0 止血与地基 — 进行中（2026-11-17）

- 开工基线：`527c81de6fe47fdaf155f5fca1ef590f4a2d4ef7`，`rebuild/tutor`；工作树干净。
- 重塑前快照：`c72370f`，标签 `pre-rebuild-20261116`。
- 环境：Python 3.14.10、Node v24.14.0、本机 npm 11.9.0。
- 桌面项目目录是 E 盘项目目录的联接，`git update-index --refresh` 和索引写入检查通过。

### 基线与本地门

- ruff 通过。pytest 574 项通过、0 项失败、3 项跳过。OpenAPI 契约一致。
- 清理前基线：后端 Python 19,665 行，测试 Python 20,143 行，OpenAPI HTTP 操作 83 个（含 `/healthz`），`docs/` 活跃文件 72 份。
- 测试在可访问本机回环的执行环境运行，数据目录指向临时路径。
