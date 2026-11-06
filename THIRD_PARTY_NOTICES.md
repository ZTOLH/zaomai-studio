# Third-Party Notices

本项目除下列组件外，页面、DSP、示例曲合成与导出器均为本项目自写代码。

## lamejs / LAME

- 文件：`vendor/lame.min.js`
- 用途：浏览器内 MP3 编码
- 内嵌 LAME 版本：3.98.4
- 上游：https://github.com/zhuker/lamejs
- 许可证：LGPL-3.0
- 许可证全文：`vendor/COPYING.LESSER`
- 文件指纹（SHA-256）：`15d285e2587b3bdbfd18a68de6ce07cc074f7480a82c3815da2dc1c348ec6df4`

lamejs 按 LGPL-3.0 分发，未修改。若再分发本目录，请保留本文件、`vendor/README.md`、`vendor/COPYING.LESSER` 与 `vendor/lame.min.js`。

## 运行环境依赖（不随项目分发）

测试脚本会调用本机的 Google Chrome、Node.js、ffmpeg / ffprobe 与 Python 3；这些程序不属于本项目，遵循各自许可证。
