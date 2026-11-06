# 验收记录

本目录保存 2026-10-30 在本机 Chrome（headless, `file://`）上对页面的最终验收证据。

| 文件 | 内容 |
|---|---|
| `autotest-full.json` | `index.html?autotest=full` 的原始结果：四档 stats、四种编码结果、console 无错误 |
| `summary.txt` | 上述结果的可读摘要 |
| `formats.txt` | 浏览器导出的 7 种格式 + 44.1kHz 重采样，用 `ffprobe` 独立读取的编码/采样率/声道/时长 |
| `zip.txt` | 真实点击「四档打包 ZIP」下载后的压缩包内容、UTF-8 文件名、CRC 校验（Python `zipfile`） |

关键数字：

- 四档实测：普通 -8.23 / 超级 -6.36 / Pro Max -4.98 / 极致纯响鞭炮 -4.02 LUFS，严格递进。
- 四档真峰值：-0.85 / -0.65 / -0.45 / -0.25 dBTP，均不超过各档 ceiling。
- 浏览器导出：WAV16 4,320,044 B；MP3 540,864 B；FLAC 2,562,232 B；OGG Opus 394,464 B。
- ZIP：17,524,894 B，6 个条目，4 个 WAV 各 4,320,044 B + 对比 PNG 242,366 B + 说明 1,474 B，`testzip=None`。
- 对比 PNG：1600×1200 RGBA。

测试环境为 Windows + Chrome headless；这些数字会随机器性能与 Chrome 版本略有变化，不应当作音频质量承诺。
