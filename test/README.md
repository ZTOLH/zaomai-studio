# 测试与验收脚本

这些脚本不是网页运行所需，只用于开发/回归验收。

## Node 测试

```bash
node test/dsp.test.cjs       # DSP、BS.1770-4、真峰值、四档递进：PASS 10/10
node test/export.test.cjs    # WAV/MP3/FLAC/OGG/AIFF/ZIP：PASS 55/55
```

依赖：

- Node 18+
- `ffmpeg` / `ffprobe` 在 PATH（WAV/MP3/FLAC 交叉验证）
- Python 3（ZIP CRC / testzip 验证）

## 浏览器验收脚本

针对 Windows + Chrome，脚本顶部硬编码了：

- `C:/Program Files/Google/Chrome/Application/chrome.exe`
- `E:/.CS/zaomai-studio`

换机器时先改这两个常量。

```bash
node test/cdp-run.cjs test/shot-autotest "file:///E:/.CS/zaomai-studio/index.html?autotest=1"
node test/cdp-run.cjs test/shot-autotest-full "file:///E:/.CS/zaomai-studio/index.html?autotest=full"
node test/capture-exports.cjs   # 7 种格式 + 44.1k 重采样
node test/download-test.cjs     # 真实下载 ZIP + 对比 PNG
node test/shots.cjs             # 桌面/移动端截图
```

`cdp-run.cjs` 会启动 headless Chrome、等待 `window.__AUTOTEST__`、截图，并写出：

- `test/<prefix>.png`
- `test/<prefix>-result.json`
- `test/<prefix>-console.txt`

`opus-harness.html` 单独用来在 Chrome 中验证 OGG Opus / Ogg 封装。

## 生成物

运行测试会生成 `test/_* `、`test/.chrome-*`、`test/downloads/`、`test/exports/`、`test/shot-*.png` 等临时文件，可随时删除。最终验收证据在 `docs/verification/`。
