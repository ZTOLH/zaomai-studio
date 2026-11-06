# ZAOMAI STUDIO 模块契约 v1

最后更新：2026-10-30 21:05 (Asia/Shanghai)
根目录：E:\.CS\zaomai-studio
目标：纯静态单页「炸麦实验室」——浏览器内把任意音乐处理成四档炸麦并导出多种格式。

## 0. 硬性运行约束

- 双击 index.html、以 file:// 打开必须完整可用。
- 不允许 ES module、fetch、XMLHttpRequest、Worker、外部 CDN、任何网络请求、任何 npm 依赖。
- 所有 JS 都是 classic script，通过全局对象协作；页面加载顺序：
  vendor/lame.min.js → src/dsp.js → src/exporters.js → src/demo-track.js → src/app.js
- 目标浏览器：Windows Chrome/Edge 最新版；AudioContext 通常 48000 Hz。
- 浏览器仅使用 Web Audio / Canvas / Blob / WebCodecs 等原生能力。
- 面向用户的报错信息必须是中文；抛 Error，不要静默失败。
- 不修改契约之外的公共 API；不要重命名 preset id、格式 id。

## 1. 文件所有权（严禁越界写）

Lead：
- index.html, styles.css, src/app.js, src/demo-track.js, README.md
- docs/**, assets/**

dsp-engineer：
- src/dsp.js
- test/dsp.test.cjs
- 可在 test/ 下新增自己的临时夹具，但不要动他人文件

export-engineer：
- src/exporters.js
- test/export.test.cjs
- test/opus-harness.html（如需）
- vendor/**（已放好 lame.min.js，不要重新下载）

## 2. 环境与工具注意事项

- Node（用绝对路径）：
  C:/Users/Administrator/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe
- Python：python（3.12）
- ffmpeg / ffprobe 在 PATH 中，可用来独立验证响度、真峰值、时长、解码。
- 重要：E: 盘上 write / edit 工具会报 EISDIR（文件系统不支持其原子写）。不要因此卡住：
  - 推荐：在 run_code 里 import('node:fs') 直接 writeFileSync / readFileSync；
  - 或 win_bash 里用 python / cat heredoc。
- read / grep / glob 工具正常可用。
- 不要安装任何包，不要联网下载依赖。

## 3. 音频数据约定

- channels: Array<Float32Array>，长度 1 或 2，每个长度 N>0，取值约 [-1,1]，允许瞬时超过 1。
- sampleRate: 整数 Hz，页面常见 44100 / 48000。
- 处理不得原地修改输入；输出等长。
- 内部可用 Float64 计算，最终写回 Float32Array。
- 禁止 NaN / Infinity 进入输出；静音输入要优雅处理。
- 所有随机过程必须使用固定种子的 PRNG，保证同一输入 + 同一参数输出逐样本一致。

## 4. DSP 模块契约（dsp-engineer）

### 4.1 暴露方式

IIFE 包裹，浏览器挂 window.ZaomaiDSP；Node 下同时支持 module.exports（CJS），供 test/dsp.test.cjs require。

    window.ZaomaiDSP = {
      version: '1.0.0',
      PRESETS: [ /* 4 个 preset 对象，顺序 normal, super, promax, firecracker */ ],
      getPreset(id),
      process(channels, sampleRate, presetId, overrides) -> result,
      measure(channels, sampleRate) -> stats
    };

### 4.2 preset 元数据（UI 直接渲染，字段不可缺）

    {
      id: 'normal' | 'super' | 'promax' | 'firecracker',
      name: '普通炸麦版',            // 卡片主标题
      en: 'NORMAL BLAST',
      tagline: '话筒过载 · 原味炸',
      desc: '一两句中文听感描述',
      color: '#ffd400',            // 主色
      accent: '#ff8a00',           // 辅助色
      level: 1,                    // 1..4 危险等级
      targetLufs: -8.0,
      ceilingDb: -0.8,             // 真峰值上限 dBTP
      params: { driveDb, clipThreshold, lowBoostDb, highBoostDb, crushBits, sampleHold, firecrackerDensity },
      chain: ['HPF 25Hz', '+9dB@70Hz', '硬削波 0.32', '+8dB@3.2k', '快压缩']
    }

四个 preset 的目标值（必须遵守）：
| id | name | targetLufs | ceilingDb | level |
|---|---|---|---|---|
| normal | 普通炸麦版 | -8.0 | -0.8 | 1 |
| super | 超级炸麦版 | -6.0 | -0.6 | 2 |
| promax | Pro Max 炸麦版 | -4.5 | -0.4 | 3 |
| firecracker | 极致纯响鞭炮炸麦版 | -3.5 | -0.2 | 4 |

### 4.3 process 返回

    {
      channels: [Float32Array, ...], // 等长，同输入声道数
      sampleRate: 48000,
      presetId: 'normal',
      stats: {
        lufs: -8.02,          // 实际积分响度（ITU-R BS.1770-4）
        truePeakDb: -0.83,    // 4x 过采样真峰值
        peakDb: -1.1,
        rmsDb: -10.2,
        crestDb: 9.1,         // peak - rms
        durationSec: 16.0,
        processingMs: 120,
        applied: { driveDb, clipThreshold, lowBoostDb, highBoostDb, crushBits, sampleHold, firecrackerDensity, targetLufs, ceilingDb }
      }
    }

- 输出必须完成「向 targetLufs 归一化 + 真峰值 ceiling 限制」，而不是把归一化交给 UI。
- 允许实际 lufs 与 target 相差 ±0.8 LU（极端素材可能更低，需在 stats 里如实返回）；truePeakDb 必须 ≤ ceilingDb + 0.1。
- measure() 返回 stats 同形（不含 presetId / applied），静音时 lufs=-70, truePeakDb=-120, peakDb=-120, rmsDb=-120, crestDb=0。
- 时长 <400ms 时按整段一个 block 计算响度，不报错。

### 4.4 参考处理链（可微调，但听感与目标必须达到）

普通（严格复刻 audio-edit zaomai 配方精神）：
HPF 25Hz → peaking 70Hz +9dB Q1.0 → peaking 200Hz +4dB Q1.5 → preGain +15dB → hardClip 0.32 → peaking 1kHz +3dB Q1.5 → peaking 3.2kHz +8dB Q2.5 → compressor(thr -16dB, ratio 6, attack 1ms, release 50ms, knee 6, makeup +3dB) → limiter 0.95 → 响度归一化到 -8 LUFS / TP -0.8。

超级：
HPF 28 → peaking 60Hz +10 Q0.9 → peaking 180Hz +5 Q1.4 → preGain +18dB → hardClip 0.25 → tanh 饱和 drive 1.8（wet 0.5）→ peaking 1kHz +3.5 Q1.4 → peaking 3.2kHz +10 Q2.6 → highShelf 9kHz +2 → compressor(-18dB, 8:1, 0.5ms, 40ms, makeup +4) → limiter → -6 LUFS / -0.6。

Pro Max：
HPF 30 → lowShelf 80Hz +11 → peaking 200Hz +6 Q1.2 → preGain +21dB → hardClip 0.18 → tanh drive 3.5（wet 0.7）→ hardClip 0.35 → bitcrush 10bit → peaking 1kHz +4 Q1.2 → peaking 3.2kHz +12 Q2.8 → highShelf 10kHz +4 → compressor(-20dB, 12:1, 0.3ms, 30ms, makeup +5) → limiter → -4.5 LUFS / -0.4。

极致纯响鞭炮：
HPF 32 → lowShelf 90Hz +12 → peaking 220Hz +7 → preGain +26dB → hardClip 0.12 → tanh drive 6（wet 0.85）→ hardClip 0.4 → bitcrush 6bit + sampleHold 2 → peaking 1kHz +5 → peaking 3.2kHz +15 Q3 → highShelf 12kHz +5 → compressor(-22dB, 16:1, 0.2ms, 25ms, makeup +6) → 鞭炮层 → 爆炸泵 → limiter → -3.5 LUFS / -0.2。

所有增益参数以 dB 计；滤波器用 RBJ biquad，每声道独立状态。硬削波/饱和建议 2x 过采样以控制刺耳混叠（非强制，但必须稳定）。

### 4.5 鞭炮层（firecracker 专属）

目标：像「纯响鞭炮」在音箱里炸开，而不是白噪声垫底。
- 单声道包络跟随（attack 1ms / release 80ms）做 onset 检测，阈值自适应，refractory ≥60ms。
- 每次 onset 触发 1 个「炮仗」：带通 1.5–7kHz 噪声，指数衰减 15–50ms；叠加 80–110Hz 正弦「闷响」衰减 ~80ms。
- 连续「噼啪」层：默认密度 8 个/秒（可调 0–20），5–12kHz 短噪声 click，衰减 5–15ms，音量明显低于炮仗。
- 「爆炸泵」：由炮仗包络驱动 gain ducking（深度 ~0.25，恢复 ~120ms），制造炸一下、音乐被抽一口气的泵感。
- 随机数固定种子（例如 0x5EED）；同一输入必须逐样本可复现。
- 鞭炮层要参与最终削波/限幅，但不要盖过音乐本体；总输出仍满足目标响度与峰值。

### 4.6 滤波器、压缩、限幅、测量

- Biquad：RBJ cookbook；Q/频率按 sampleRate 计算；系数每声道复用；去 denormal。
- 压缩：feed-forward、软拐点、立体声联动（用两声道最大值检测），attack/release 一阶平滑。
- 限幅：lookahead ≥ 5ms，attack ~1ms，release 80ms；检测真峰值（4x 过采样）并生成平滑增益包络，最后用 sample clamp 兜底。
- 响度：ITU-R BS.1770-4 K 加权，400ms block / 100ms hop，绝对门限 -70 LUFS，相对门限 -10 LU；系数必须按实际 sampleRate 推导（参考 libebur128 公式），不能只硬编码 48k。
- 真峰值：4x 过采样，建议 48-tap Kaiser windowed-sinc（beta≈8），边界补零。
- 归一化：先测 → 增益到目标 → 限幅 → 复测；最多迭代 3 次，确保响度尽量贴近 target 且 TP 不超 ceiling。禁止「先限幅再直接乘增益」导致峰值破坏。

### 4.7 性能与鲁棒性

- Node 下单声道 60s/48k 四档全部处理 < 15s（能更快更好）；浏览器 16s 立体声一档 < 1s。
- 支持任意 8k–192k sampleRate、1–2 声道、极短（≥64 samples）输入。
- 输入含 NaN/Inf 时先清洗为 0，不崩溃。
- 超长输入（>10 分钟）由 UI 限制，DSP 本身不设硬上限，但不要 O(n²)。

### 4.8 验收测试（test/dsp.test.cjs）

必须用 Node 直接跑通：<node> test/dsp.test.cjs，最后打印 PASS n/n，退出码 0。
至少覆盖：
1. 四档预设对合成测试信号（60Hz+440Hz+3kHz+噪声+瞬态，立体声 8s）输出有限、无 NaN、|x|≤1.0001、等长。
2. 四档 lufs 落在 target±0.8 内；truePeakDb ≤ ceiling+0.1；四档响度单调上升。
3. 高频能量（8–16kHz）相对输入上升；crest factor 相对输入下降。
4. measure() 与 ffmpeg ebur128（peak=true）对同一 WAV 的 I / Peak 误差 ≤0.3 LU / 0.5 dB（ffmpeg 不可用则跳过并注明）。
5. 同输入两次 process 逐样本相等（鞭炮层可复现）。
6. 立体声与单声道、48k 与 44.1k、静音、100 样本短音频不崩溃且结果合理。
7. 归一化后再次 measure 的输出与 stats 一致（误差 ≤0.05）。
8. 鞭炮档 5–12kHz 瞬态密度 > promax 档（用简单阈值计数验证）。
9. 处理 30s 立体声 48k 的耗时记录并断言 < 8s（Node 环境）。
10. overrides 越界被 clamp，非法 presetId / 空 channels 抛中文错误。

测试内需要写 WAV 时自己写最小 RIFF writer，不要依赖 exporters.js。

## 5. 导出模块契约（export-engineer）

### 5.1 暴露方式

IIFE，浏览器挂 window.ZaomaiExport；Node 下支持 module.exports（WAV/FLAC/AIFF/ZIP/MP3 部分可在 Node 测试；Opus 浏览器专属可跳过）。

    window.ZaomaiExport = {
      version: '1.0.0',
      FORMATS: [ /* 见下 */ ],
      isSupported(formatId) -> boolean,
      encode(formatId, channels, sampleRate, options, onProgress) -> Promise<Blob>,
      zip(entries) -> Blob,
      // entries: [{ name: '普通炸麦版.wav', blob: Blob }]
    };

- onProgress(ratio 0..1) 可选；长任务每 ~200ms 调一次；编码循环要让出事件循环（await setTimeout(0)），页面不能假死。
- 浏览器返回 Blob（正确 MIME）；Node 测试可返回 Buffer/Uint8Array（用同一内部实现）。
- 所有 formatId 必须稳定，UI 依赖。

### 5.2 格式清单

| formatId | UI 标签 | 扩展名 | MIME | options | 说明 |
|---|---|---|---|---|---|
| wav16 | WAV 16-bit | .wav | audio/wav | {} | PCM 16，TPDF dither 默认开 |
| wav24 | WAV 24-bit | .wav | audio/wav | {} | PCM 24 |
| wav32f | WAV 32-bit Float | .wav | audio/wav | {} | IEEE float，含 fact chunk |
| mp3 | MP3 | .mp3 | audio/mpeg | {bitrate:128/192/320} | lamejs，默认 192 |
| flac | FLAC 16-bit | .flac | audio/flac | {} | 原生 FLAC，无损 |
| ogg | OGG Opus | .ogg | audio/ogg | {bitrate:96/128/192} | WebCodecs + Ogg 封装，默认 128 |
| aiff | AIFF 16-bit | .aiff | audio/aiff | {} | PCM 16 大端 |

每个 FORMATS 项：
    { id:'mp3', label:'MP3', ext:'mp3', mime:'audio/mpeg', kind:'mp3',
      options:[{key:'bitrate', values:[128,192,320], default:192}], note:'兼容性最好' }
isSupported('ogg') 返回 !!window.AudioEncoder 且 codec opus 可用；浏览器不支持时 UI 置灰。

### 5.3 编码要求

WAV：
- 标准 RIFF/WAVE；16/24 为 PCM，32f 为 format 3 + fact；交错；小端；dither 用 TPDF，clamp 到 [-1, 1-1LSB]；24-bit 按 3 字节写。
- 用 ffprobe 验证 codec/pcm_s16le/pcm_s24le/pcm_f32le、声道、采样率、时长。

AIFF：
- FORM/AIFF，COMM（80-bit extended sample rate）+ SSND，16-bit 大端；ffprobe 验证。

MP3：
- 浏览器从 vendor/lame.min.js 的全局 lamejs 取 Mp3Encoder；Node 测试可用 vm 加载该文件。
- bitrate 128/192/320；输入 f32→int16；按 1152 样本分块；拼接后 Blob('audio/mpeg')。
- ffprobe 验证 codec=mp3、时长误差 ≤0.15s、声道数正确。

FLAC：
- 16-bit 原生 FLAC；STREAMINFO（min/max block 4096、min/max frame size 可 0、采样率、声道、总样本数、MD5 可选填 0）、若干 frame、可加 Vorbis comment；CRC8/CRC16 必须正确。
- 可使用 verbatim + fixed predictor(0..2) + Rice coding；帧头/UTF-8 编码的帧号/块大小要正确。
- 必须 bit-perfect：ffmpeg 解码回 16-bit PCM 与输入量化结果逐样本一致；ffprobe 显示 flac、时长正确。
- 若 24-bit 来不及，只做 16-bit 即可（契约只要求 flac16）。

OGG Opus：
- 优先 WebCodecs AudioEncoder（codec:'opus'，sampleRate 48000，bitrate 可配），自行封装 Ogg：OpusHead（version 1，channels，pre-skip 合理值，input sample rate，gain 0，mapping 0）、OpusTags、音频页；页序号、granulepos（48kHz 计）、Ogg CRC32 必须正确。
- 若源采样率不是 48k，先重采样到 48k（可用线性/多相；质量别太差）。
- 编码器不可用时 isSupported 返回 false，encode 抛中文错误；不要静默产出坏文件。
- 用 ffprobe 验证 codec=opus、时长误差 ≤0.2s；用 ffmpeg 解码确认可播。
- 如果 WebCodecs 路线确实走不通，可退化为 MediaRecorder 实时录制（需在 note 标注「实时，时长≈音频长度」），但必须在浏览器实测可播。

ZIP：
- store（不压缩）即可；local file header + central directory + EOCD；UTF-8 文件名（general purpose bit 11）；CRC32 正确；时间戳固定。
- Python zipfile.testzip() 返回 None，解压后文件可由 ffprobe 识别。

### 5.4 浏览器验证

Lead 会用 headless Chrome + file:// 做集成测试。export-engineer 至少提供：
- WAV/AIFF/FLAC/ZIP 的 Node 自动测试；
- MP3 的 Node 自动测试（vm 加载 vendor/lame.min.js）；
- OGG 的浏览器自测页 test/opus-harness.html（可选但强烈建议）：生成 2s 正弦 → encode → 把 base64 写进 DOM，供 Lead 用 headless Chrome --dump-dom 提取后 ffprobe。

### 5.5 验收测试（test/export.test.cjs）

必须打印 PASS n/n 并退出 0：
- 四档格式各生成 2s 立体声 48k 测试音，ffprobe 校验容器/编码/采样率/声道/时长。
- FLAC 解码 PCM 与输入量化逐样本一致。
- MP3 时长误差 ≤0.15s，ffmpeg 能完整解码（无错误输出）。
- ZIP 用 Python zipfile 校验 CRC 并能解出全部条目。
- 波形值越界/NaN 输入不崩。
- 非法 formatId / 空数据抛中文错误。
- 16-bit WAV 峰值不超过 0 dBFS，无整数回绕。

## 6. UI 集成约定（Lead 负责，模块作者无需改 UI）

- UI 会在加载音轨后调用 ZaomaiDSP.measure 显示原声 LUFS/TP。
- 用户选档后调用 ZaomaiDSP.process(...)，用返回的 channels 建 AudioBuffer 播放并导出。
- 高级参数面板的 overrides 键与 4.2 的 params 一致；未知键忽略。
- 导出调用 ZaomaiExport.encode(formatId, ch, sr, options, cb)。
- 失败时 UI 捕获 Error.message 显示中文 toast。
- 页面必须能在 DSP/Export 未加载时显示错误而不是白屏（Lead 处理）。

## 7. 交付与汇报

- 完成后把实现要点、测试输出、已知限制写在最终消息里；并把任务标记 completed。
- 如果发现契约有冲突，优先保证页面可用与听感/格式正确，在最终消息明确说明偏差。
- 不要等待 Lead 确认，直接按契约实现并自测。
