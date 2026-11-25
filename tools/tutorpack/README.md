# Companion Space `.tutorpack` 素材工具链

本工具链用于生成老师视频/图片提示词、批量排队、校准并入库选中的素材，以及校验与打包 `.tutorpack`。

- 片段与表情图目录单一来源：`libs/schemas/tutor_media_catalog.json`（27 个活跃片段 + 9 个预留三段式槽位 + 7 张表情图）
- 六位内置老师外观锁定与几何数据：`tools/tutorpack/tutors-data.json`
- 规格文档：`docs/rebuild/spec/tutor-media.md`

## 外部依赖（不随产品打包）

`ingest`、`legacy-fix`、`sheet` 及带媒体检查的 `validate` 需要本机 FFmpeg / ffprobe，请通过环境变量指定路径（也可放入系统 `PATH`）：

```powershell
$env:TUTORPACK_FFMPEG = "D:\path\to\ffmpeg.exe"
$env:TUTORPACK_FFPROBE = "D:\path\to\ffprobe.exe"
```

## 常用命令

```powershell
# 生成六位老师的图片与视频提示词及 jobs.json / image-jobs.json
node tools/tutorpack/generate-prompts.mjs outputs/老师素材扩展-20261122

# 批量提交至本机 ComfyUI (MiniMax H3-Base FL2VA)
node tools/tutorpack/run-h3-batch.mjs --tutor chutang --batch P0

# 旧 480x864 短片去黑边、统一至 576x1024 并按单关键帧 VP9 重新编码
.venv\Scripts\python.exe tools/tutorpack/cli.py legacy-fix assets/avatars/packs --all

# 入库选中视频（仅读取 02-视频提示词/回传/<编号-拼音>/选中/；超 14 MB 自动按频次分层自适应重编码）
.venv\Scripts\python.exe tools/tutorpack/cli.py ingest --pack outputs/老师素材扩展-20261122 --tutor all --pack-budget 14000000 --sync-licenses

# 配准并导出选中表情图（仅读取 01-图片提示词/回传/<编号-拼音>/选中/）
.venv\Scripts\python.exe tools/tutorpack/cli.py stills --pack outputs/老师素材扩展-20261122 --tutor all

# 生成评审对照图（输出至 docs/rebuild/review/UM/）
.venv\Scripts\python.exe tools/tutorpack/cli.py sheet --tutor all

# 校验目录或压缩包（--strict 启用 §5 全部媒体阈值校验）
.venv\Scripts\python.exe tools/tutorpack/cli.py validate assets/avatars/packs/tutor-chutang --strict

# 脚手架与打包
.venv\Scripts\python.exe tools/tutorpack/cli.py scaffold "新老师" --anchor anchor.png -o ./my-pack
.venv\Scripts\python.exe tools/tutorpack/cli.py pack ./my-pack -o my-tutor.tutorpack
```
