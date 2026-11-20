# 六位内置二次元老师 · 8 段循环视频专属提示词索引

> 对应锚点图：`assets/avatars/portraits/{xuechuan,shenyan,lanyue,chutang,qingheng,lanyin}.webp`（1080×1920 竖屏 9:16）

## 通用制作参数（6 位角色共用）

| 参数 | 推荐设置 | 说明 |
| --- | --- | --- |
| **输入锚点图** | 使用 `课堂导入版/*.webp`（或从 `6K母版` 缩放到 `720×1280` PNG） | 不要直接向视频模型上传 25–35 MB 6K 原图 |
| **首尾帧模式** | **必须开启「首尾帧相同」**（Start Frame = End Frame = 锚点图） | 保证每个短片都能与 180ms 交叉淡入无缝衔接 |
| **画幅 / 帧率** | 9:16 竖屏，`720×1280` 或 `576×1024`，`24–25 fps` | 与 `<TutorVideoBox>` 竖屏视频通话框 1:1 匹配 |
| **单段时长** | 循环槽位 `4–5s`，单次动作槽位 `3s` | 单段转码后控制在 `≤ 3 MB` |
| **镜头运动** | 固定三脚架（Static camera, zero pan/zoom） | 避免切换短片时背景跳帧 |

## 角色专属提示词文件

| # | 角色 | 角色 ID | 专属提示词 | 关键防穿模重点 |
| --- | --- | --- | --- | --- |
| 01 | **雪川**（白发少年） | `tutor-xuechuan` | [01-xuechuan.md](01-xuechuan.md) | 锁定晨光曝光防过曝、固定四角星胸针与水手领条纹 |
| 02 | **沈砚**（黑发总裁） | `tutor-shenyan` | [02-shenyan.md](02-shenyan.md) | 克制沉稳的熟男微表情、禁止夸张大笑与大幅摆手 |
| 03 | **岚玥**（月白龙女） | `tutor-lanyue` | [03-lanyue.md](03-lanyue.md) | 强锁定双龙角/精灵尖耳/紫藤发饰刚性一致、转头 ≤8° |
| 04 | **初棠**（樱发少女） | `tutor-chutang` | [04-chutang.md](04-chutang.md) | 固定两枚小花发卡/薄荷丝带/叶形琉璃扣防闪烁 |
| 05 | **青衡**（国风青年） | `tutor-qingheng` | [05-qingheng.md](05-qingheng.md) | 强锁定横向竹玉簪与交领暗纹、转头 ≤8° 防玉簪消失 |
| 06 | **澜音**（蓝发声学导师） | `tutor-lanyin` | [06-lanyin.md](06-lanyin.md) | 锁定深暖肤色与暖琥珀侧光、蓝黑挑染短发利落微动 |

## 出片后统一转码为 VP9 `.webm`（无声轨、首尾干净）

```powershell
# 示例：把 raw.mp4 转成标准 720x1280 25fps 无声 WebM
ffmpeg -y -i raw.mp4 -an -vf "scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,fps=25" -c:v libvpx-vp9 -crf 32 -b:v 0 -pix_fmt yuv420p clips/idle_breathe.webm
```

## 两种启用方式（出完哪怕先做 2–3 段也能直接用！）

1. **升级为内置 Tier 1 自动发现**：把生成好的 `manifest.json`、`anchor.webp` 和 `clips/*.webm` 放到 `assets/avatars/packs/<角色ID>/`（例如 `assets/avatars/packs/tutor-chutang/`），无需改代码重启后即自动升级为「循环短片」档。
2. **打包成 `.tutorpack` 从网页导入**：
   ```powershell
   python tools/tutorpack/cli.py validate ./my-pack
   python tools/tutorpack/cli.py pack ./my-pack -o character.tutorpack
   ```
   然后拖进 `/characters` 页面即可立即试演和上课。
