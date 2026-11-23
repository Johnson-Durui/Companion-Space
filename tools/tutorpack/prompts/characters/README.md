# 六位内置老师提示词已迁移至数据驱动生成器

各角色的旧 8 段手工提示词已被 `tools/tutorpack/tutors-data.json` 与 `tools/tutorpack/generate-prompts.mjs` 取代（遵循 MiniMax H3 官方 FL2VA 格式与 OpenAI Images 2.6 编辑规范）。

运行以下命令即可重新生成全部六位老师的图片与视频提示词及任务清单：

```powershell
node tools/tutorpack/generate-prompts.mjs <输出目录>
```

详见 `tools/tutorpack/README.md` 与 `docs/rebuild/spec/tutor-media.md`。
