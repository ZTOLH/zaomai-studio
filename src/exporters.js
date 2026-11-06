/*!
 * ZAOMAI STUDIO - exporters.js  (模块契约 v1 第 5 节)
 * 多格式导出引擎：WAV 16/24/32f、AIFF 16、FLAC 16（原生编码，bit-perfect）、
 * MP3（vendor/lame.min.js）、OGG Opus（WebCodecs + 自写 Ogg 封装）、ZIP（store）。
 *
 * 暴露方式：IIFE；浏览器 window.ZaomaiExport；Node module.exports。
 * API：FORMATS / isSupported(id) / encode(id, channels, sampleRate, options, onProgress) / zip(entries)
 *
 * 数据约定：channels = Array<Float32Array>（1 或 2 声道，等长），sampleRate 整数 Hz。
 */
(function (root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module !== 'undefined' && module && module.exports) {
    module.exports = api;
  }
  if (root && typeof root === 'object') {
    root.ZaomaiExport = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this), function (root) {
  'use strict';

  var VERSION = '1.0.0';

  var IS_NODE = (typeof process !== 'undefined') && !!(process.versions && process.versions.node) &&
    (typeof window === 'undefined');
  var HAS_BUFFER = (typeof Buffer !== 'undefined') && (typeof Buffer.from === 'function');
  var BLOB_BYTES = (typeof WeakMap === 'function') ? new WeakMap() : null;

  // ---------------------------------------------------------------------------
  // 通用小工具
  // ---------------------------------------------------------------------------

  function nowMs() {
    if (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') {
      return performance.now();
    }
    return Date.now();
  }

  function tick() {
    return new Promise(function (resolve) { setTimeout(resolve, 0); });
  }

  function fail(msg) {
    return new Error('导出失败：' + msg);
  }

  function Progress(cb) {
    this.cb = (typeof cb === 'function') ? cb : null;
    this.lastCb = -1e9;
    this.lastYield = nowMs();
    this.fired = false;
  }

  Progress.prototype.report = function (frac) {
    if (!this.cb) return;
    var t = nowMs();
    if (!this.fired || frac >= 1 || (t - this.lastCb) >= 200) {
      this.fired = true;
      this.lastCb = t;
      var f = frac < 0 ? 0 : (frac > 1 ? 1 : frac);
      try { this.cb(f); } catch (e) { /* 进度回调异常不影响导出 */ }
    }
  };

  // 长任务让出事件循环：约 20ms 一次，保证页面不假死
  Progress.prototype.yieldIf = async function () {
    var t = nowMs();
    if (t - this.lastYield >= 20) {
      this.lastYield = nowMs();
      await tick();
    }
  };

  function ensureSampleRate(sr) {
    var n = (typeof sr === 'number') ? sr : Number(sr);
    if (!isFinite(n) || n <= 0) throw fail('采样率非法');
    return Math.round(n);
  }

  function checkChannels(channels) {
    if (!channels || typeof channels.length !== 'number') {
      throw fail('音频数据为空，无法导出');
    }
    var nch = channels.length;
    if (nch !== 1 && nch !== 2) {
      throw fail('声道数必须为 1 或 2，当前为 ' + nch);
    }
    var len = -1;
    for (var c = 0; c < nch; c++) {
      var ch = channels[c];
      if (!ch || typeof ch.length !== 'number') {
        throw fail('第 ' + (c + 1) + ' 声道数据无效');
      }
      if (ch.length === 0) throw fail('音频数据为空，无法导出');
      if (len < 0) len = ch.length;
      else if (ch.length !== len) throw fail('各声道长度不一致');
    }
    return { count: nch, length: len };
  }

  function pickOption(options, key, allowed, dflt) {
    if (!options || options[key] === undefined || options[key] === null) return dflt;
    var v = Number(options[key]);
    if (!isFinite(v)) throw fail('参数 ' + key + ' 非法');
    v = Math.round(v);
    if (allowed && allowed.indexOf(v) < 0) {
      throw fail('参数 ' + key + ' 不支持：' + options[key] + '（可选 ' + allowed.join('/') + '）');
    }
    return v;
  }

  function utf8Bytes(str) {
    var s = String(str);
    if (typeof TextEncoder !== 'undefined') {
      try { return new TextEncoder().encode(s); } catch (e) { /* fallthrough */ }
    }
    if (HAS_BUFFER) return new Uint8Array(Buffer.from(s, 'utf8'));
    throw fail('当前环境缺少 UTF-8 编码器');
  }

  function asciiBytes(target, offset, str) {
    for (var i = 0; i < str.length; i++) target[offset + i] = str.charCodeAt(i) & 0xFF;
  }

  function concatParts(parts) {
    var total = 0, i;
    for (i = 0; i < parts.length; i++) total += parts[i].length;
    var out = new Uint8Array(total);
    var off = 0;
    for (i = 0; i < parts.length; i++) {
      out.set(parts[i], off);
      off += parts[i].length;
    }
    return out;
  }

  function wrapBytes(bytes, mime) {
    if (IS_NODE && HAS_BUFFER) {
      return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }
    var blob = new Blob([bytes], { type: mime });
    if (BLOB_BYTES) BLOB_BYTES.set(blob, bytes);
    return blob;
  }

  // ---------------------------------------------------------------------------
  // 格式清单（formatId 稳定，UI 依赖）
  // ---------------------------------------------------------------------------

  var FORMATS = [
    {
      id: 'wav16', label: 'WAV 16-bit', ext: 'wav', mime: 'audio/wav', kind: 'wav16',
      options: [], note: '无损 PCM · 兼容一切播放器'
    },
    {
      id: 'wav24', label: 'WAV 24-bit', ext: 'wav', mime: 'audio/wav', kind: 'wav24',
      options: [], note: '24-bit PCM · 动态余量更大'
    },
    {
      id: 'wav32f', label: 'WAV 32-bit Float', ext: 'wav', mime: 'audio/wav', kind: 'wav32f',
      options: [], note: '32-bit 浮点 · 后期处理友好'
    },
    {
      id: 'mp3', label: 'MP3', ext: 'mp3', mime: 'audio/mpeg', kind: 'mp3',
      options: [{ key: 'bitrate', values: [128, 192, 320], default: 192 }],
      note: '兼容性最好 · 体积小'
    },
    {
      id: 'flac', label: 'FLAC 16-bit', ext: 'flac', mime: 'audio/flac', kind: 'flac',
      options: [], note: '无损压缩 · 体积更小'
    },
    {
      id: 'ogg', label: 'OGG Opus', ext: 'ogg', mime: 'audio/ogg', kind: 'ogg',
      options: [{ key: 'bitrate', values: [96, 128, 192], default: 128 }],
      note: '小体积高音质 · 需最新版 Chrome / Edge'
    },
    {
      id: 'aiff', label: 'AIFF 16-bit', ext: 'aiff', mime: 'audio/aiff', kind: 'aiff',
      options: [], note: '苹果无损格式 · 老设备友好'
    }
  ];

  var FORMAT_MAP = {};
  (function () {
    for (var i = 0; i < FORMATS.length; i++) FORMAT_MAP[FORMATS[i].id] = FORMATS[i];
  })();

  function findFormat(id) {
    return Object.prototype.hasOwnProperty.call(FORMAT_MAP, String(id)) ? FORMAT_MAP[String(id)] : null;
  }

  // ---------------------------------------------------------------------------
  // 采样量化 / 抖动
  // ---------------------------------------------------------------------------

  // 量化约定：clamp 到 [-1, 1]，scale = 2^(bits-1)，round 后半开区间取整。
  // 16-bit: [-32768, 32767]；24-bit: [-8388608, 8388607]。
  function quant16(x) {
    if (!(x === x)) return 0;              // NaN
    if (x > 1) x = 1;
    else if (x < -1) x = -1;               // Infinity / -Infinity 也走这里
    var v = Math.round(x * 32768);
    if (v > 32767) v = 32767;
    else if (v < -32768) v = -32768;
    return v;
  }

  function quant24(x) {
    if (!(x === x)) return 0;
    if (x > 1) x = 1;
    else if (x < -1) x = -1;
    var v = Math.round(x * 8388608);
    if (v > 8388607) v = 8388607;
    else if (v < -8388608) v = -8388608;
    return v;
  }

  function cleanFloat(x) {
    if (!(x === x)) return 0;
    if (x === Infinity || x === -Infinity) return 0;
    return x;
  }

  // 固定种子 xorshift32，保证同一输入 + 同一参数输出逐字节一致
  function XorShift(seed) {
    this.s = (seed >>> 0) || 0x9E3779B9;
  }

  XorShift.prototype.unit = function () {
    var s = this.s;
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    this.s = s;
    return s / 4294967296;
  };

  // ---------------------------------------------------------------------------
  // WAV（RIFF/WAVE）
  // ---------------------------------------------------------------------------

  var WAV_CHUNK = 65536;

  async function encodeWav(channels, sampleRate, kind, options, progress) {
    var meta = checkChannels(channels);
    var nch = meta.count;
    var n = meta.length;
    var sr = ensureSampleRate(sampleRate);
    var isFloat = (kind === 'wav32f');
    var is24 = (kind === 'wav24');
    var bytesPer = isFloat ? 4 : (is24 ? 3 : 2);
    var blockAlign = nch * bytesPer;
    var dataSize = n * blockAlign;
    var headerSize = isFloat ? 56 : 44;
    var pad = dataSize & 1;                        // RIFF chunk 必须偶对齐
    var total = headerSize + dataSize + pad;
    var out = new Uint8Array(total);
    var dv = new DataView(out.buffer);

    asciiBytes(out, 0, 'RIFF');
    dv.setUint32(4, total - 8, true);
    asciiBytes(out, 8, 'WAVE');
    asciiBytes(out, 12, 'fmt ');
    dv.setUint32(16, 16, true);
    dv.setUint16(20, isFloat ? 3 : 1, true);         // 3 = IEEE float, 1 = PCM
    dv.setUint16(22, nch, true);
    dv.setUint32(24, sr, true);
    dv.setUint32(28, sr * blockAlign, true);
    dv.setUint16(32, blockAlign, true);
    dv.setUint16(34, bytesPer * 8, true);
    var pos;
    if (isFloat) {
      // fact chunk：非 PCM 格式必须提供
      asciiBytes(out, 36, 'fact');
      dv.setUint32(40, 4, true);
      dv.setUint32(44, n, true);
      asciiBytes(out, 48, 'data');
      dv.setUint32(52, dataSize, true);
      pos = 56;
    } else {
      asciiBytes(out, 36, 'data');
      dv.setUint32(40, dataSize, true);
      pos = 44;
    }

    var ditherOn = (kind === 'wav32f') ? false :
      (kind === 'wav24') ? (options.dither === true) : (options.dither !== false);
    var rng = ditherOn ? new XorShift(0x5EED5EED) : null;

    for (var start = 0; start < n; start += WAV_CHUNK) {
      var end = Math.min(n, start + WAV_CHUNK);
      for (var i = start; i < end; i++) {
        for (var c = 0; c < nch; c++) {
          var x = channels[c][i];
          if (isFloat) {
            dv.setFloat32(pos, cleanFloat(x), true);
            pos += 4;
          } else if (is24) {
            if (!(x === x)) x = 0;
            else if (x > 1) x = 1;
            else if (x < -1) x = -1;
            var d24 = ditherOn ? (rng.unit() + rng.unit() - 1) : 0;
            var v24 = Math.round(x * 8388608 + d24);
            if (v24 > 8388607) v24 = 8388607;
            else if (v24 < -8388608) v24 = -8388608;
            var u24 = v24 < 0 ? (v24 + 16777216) : v24;
            out[pos] = u24 & 0xFF;
            out[pos + 1] = (u24 >>> 8) & 0xFF;
            out[pos + 2] = (u24 >>> 16) & 0xFF;
            pos += 3;
          } else {
            if (!(x === x)) x = 0;
            else if (x > 1) x = 1;
            else if (x < -1) x = -1;
            var d16 = ditherOn ? (rng.unit() + rng.unit() - 1) : 0;
            var v16 = Math.round(x * 32768 + d16);
            if (v16 > 32767) v16 = 32767;
            else if (v16 < -32768) v16 = -32768;
            dv.setInt16(pos, v16, true);
            pos += 2;
          }
        }
      }
      progress.report(0.02 + 0.96 * (end / n));
      await progress.yieldIf();
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // AIFF 16-bit（FORM/AIFF，大端，80-bit extended 采样率）
  // ---------------------------------------------------------------------------

  function extended80(value) {
    var buf = new Uint8Array(10);
    var dv = new DataView(buf.buffer);
    if (!isFinite(value) || value <= 0) {
      dv.setUint16(0, 0);
      dv.setUint32(2, 0);
      dv.setUint32(6, 0);
      return buf;
    }
    var exp = Math.floor(Math.log(value) / Math.LN2);
    var m = value / Math.pow(2, exp);
    while (m >= 2) { m /= 2; exp++; }
    while (m < 1) { m *= 2; exp--; }
    var hiFloat = m * 2147483648;         // mantissa 高 32 位
    var hi = Math.floor(hiFloat);
    var lo = Math.round((hiFloat - hi) * 4294967296);
    if (lo >= 4294967296) { lo -= 4294967296; hi += 1; }
    if (hi >= 4294967296) { hi -= 4294967296; exp += 1; }
    dv.setUint16(0, (exp + 16383) & 0x7FFF);
    dv.setUint32(2, hi >>> 0);
    dv.setUint32(6, lo >>> 0);
    return buf;
  }

  async function encodeAiff(channels, sampleRate, options, progress) {
    var meta = checkChannels(channels);
    var nch = meta.count;
    var n = meta.length;
    var sr = ensureSampleRate(sampleRate);
    var dataSize = n * nch * 2;
    var pad = dataSize & 1;
    var total = 54 + dataSize + pad;
    var out = new Uint8Array(total);
    var dv = new DataView(out.buffer);

    asciiBytes(out, 0, 'FORM');
    dv.setUint32(4, total - 8, false);
    asciiBytes(out, 8, 'AIFF');
    asciiBytes(out, 12, 'COMM');
    dv.setUint32(16, 18, false);
    dv.setUint16(20, nch, false);
    dv.setUint32(22, n, false);
    dv.setUint16(26, 16, false);
    var rate = extended80(sr);
    out.set(rate, 28);
    asciiBytes(out, 38, 'SSND');
    dv.setUint32(42, 8 + dataSize, false);
    dv.setUint32(46, 0, false);
    dv.setUint32(50, 0, false);

    var pos = 54;
    for (var start = 0; start < n; start += WAV_CHUNK) {
      var end = Math.min(n, start + WAV_CHUNK);
      for (var i = start; i < end; i++) {
        for (var c = 0; c < nch; c++) {
          dv.setInt16(pos, quant16(channels[c][i]), false);
          pos += 2;
        }
      }
      progress.report(0.02 + 0.96 * (end / n));
      await progress.yieldIf();
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // FLAC 16-bit（原生编码：STREAMINFO + VORBIS_COMMENT + fixed predictor 帧）
  // 帧头 CRC-8（poly 0x07）、帧 CRC-16（poly 0x8005）必须正确。
  // ---------------------------------------------------------------------------

  var FLAC_BLOCK = 4096;

  var CRC8_TABLE = (function () {
    var t = new Uint8Array(256);
    for (var i = 0; i < 256; i++) {
      var c = i;
      for (var b = 0; b < 8; b++) c = (c & 0x80) ? (((c << 1) ^ 0x07) & 0xFF) : ((c << 1) & 0xFF);
      t[i] = c;
    }
    return t;
  })();

  function crc8(bytes, len) {
    var c = 0;
    for (var i = 0; i < len; i++) c = CRC8_TABLE[c ^ bytes[i]];
    return c;
  }

  var CRC16_TABLE = (function () {
    var t = new Uint16Array(256);
    for (var i = 0; i < 256; i++) {
      var c = (i << 8) & 0xFFFF;
      for (var b = 0; b < 8; b++) c = (c & 0x8000) ? (((c << 1) ^ 0x8005) & 0xFFFF) : ((c << 1) & 0xFFFF);
      t[i] = c;
    }
    return t;
  })();

  function crc16(bytes, len) {
    var c = 0;
    for (var i = 0; i < len; i++) {
      c = ((c << 8) & 0xFFFF) ^ CRC16_TABLE[((c >>> 8) ^ bytes[i]) & 0xFF];
    }
    return c;
  }

  function BitWriter(initial) {
    this.buf = new Uint8Array(initial > 0 ? initial : 256);
    this.len = 0;
    this.bit = 0;
  }

  BitWriter.prototype._ensure = function (extra) {
    if (this.len + extra < this.buf.length) return;
    var cap = this.buf.length || 64;
    while (cap <= this.len + extra) cap *= 2;
    var nb = new Uint8Array(cap);
    nb.set(this.buf.subarray(0, this.len));
    this.buf = nb;
  };

  BitWriter.prototype.writeBit = function (v) {
    if (this.bit === 0) {
      this._ensure(1);
      this.buf[this.len] = 0;
    }
    if (v) this.buf[this.len] |= (0x80 >> this.bit);
    this.bit++;
    if (this.bit === 8) { this.bit = 0; this.len++; }
  };

  BitWriter.prototype.writeBits = function (value, nbits) {
    for (var i = nbits - 1; i >= 0; i--) this.writeBit((value >>> i) & 1);
  };

  BitWriter.prototype.writeSigned = function (value, nbits) {
    var v = value < 0 ? value + (1 << nbits) : value;
    this.writeBits(v, nbits);
  };

  BitWriter.prototype.align = function () {
    if (this.bit !== 0) { this.bit = 0; this.len++; }
  };

  function putUtf8(arr, pos, value) {
    var v = value;
    if (v < 0x80) { arr[pos++] = v; return pos; }
    if (v < 0x800) {
      arr[pos++] = 0xC0 | (v >> 6);
      arr[pos++] = 0x80 | (v & 0x3F);
      return pos;
    }
    if (v < 0x10000) {
      arr[pos++] = 0xE0 | (v >> 12);
      arr[pos++] = 0x80 | ((v >> 6) & 0x3F);
      arr[pos++] = 0x80 | (v & 0x3F);
      return pos;
    }
    if (v < 0x200000) {
      arr[pos++] = 0xF0 | (v >> 18);
      arr[pos++] = 0x80 | ((v >> 12) & 0x3F);
      arr[pos++] = 0x80 | ((v >> 6) & 0x3F);
      arr[pos++] = 0x80 | (v & 0x3F);
      return pos;
    }
    if (v < 0x4000000) {
      arr[pos++] = 0xF8 | (v >> 24);
      arr[pos++] = 0x80 | ((v >> 18) & 0x3F);
      arr[pos++] = 0x80 | ((v >> 12) & 0x3F);
      arr[pos++] = 0x80 | ((v >> 6) & 0x3F);
      arr[pos++] = 0x80 | (v & 0x3F);
      return pos;
    }
    arr[pos++] = 0xFC | (v >> 30);
    arr[pos++] = 0x80 | ((v >> 24) & 0x3F);
    arr[pos++] = 0x80 | ((v >> 18) & 0x3F);
    arr[pos++] = 0x80 | ((v >> 12) & 0x3F);
    arr[pos++] = 0x80 | ((v >> 6) & 0x3F);
    arr[pos++] = 0x80 | (v & 0x3F);
    return pos;
  }

  function flacMetadataBlocks(sampleRate, nch, totalSamples) {
    // STREAMINFO (34 bytes)
    var si = new Uint8Array(34);
    var dv = new DataView(si.buffer);
    var minB = totalSamples >= FLAC_BLOCK ? FLAC_BLOCK : Math.max(16, Math.min(FLAC_BLOCK, totalSamples));
    dv.setUint16(0, minB, false);
    dv.setUint16(2, FLAC_BLOCK, false);
    // bytes 4..9 = min/max frame size = 0（未知）
    // 64 bits: 20 sampleRate | 3 (nch-1) | 5 (bps-1 = 15) | 36 totalSamples
    var high = ((sampleRate & 0xFFFFF) * 4096) + ((nch - 1) * 512) + ((16 - 1) * 16) +
      Math.floor(totalSamples / 4294967296);
    dv.setUint32(10, high >>> 0, false);
    dv.setUint32(14, (totalSamples % 4294967296) >>> 0, false);
    // MD5 16 字节全 0 = 未计算

    var vendor = utf8Bytes('ZAOMAI STUDIO ' + VERSION);
    var vc = new Uint8Array(4 + vendor.length + 4);
    var vdv = new DataView(vc.buffer);
    vdv.setUint32(0, vendor.length, true);
    vc.set(vendor, 4);
    vdv.setUint32(4 + vendor.length, 0, true);   // 0 条 comment

    var out = new Uint8Array(4 + 4 + si.length + 4 + vc.length);
    asciiBytes(out, 0, 'fLaC');
    out[4] = 0x00;                    // 非最后一个 metadata block，type 0 = STREAMINFO
    out[5] = 0; out[6] = 0; out[7] = 34;
    out.set(si, 8);
    var p = 8 + 34;
    out[p] = 0x84;                    // 最后一个 metadata block，type 4 = VORBIS_COMMENT
    out[p + 1] = (vc.length >>> 16) & 0xFF;
    out[p + 2] = (vc.length >>> 8) & 0xFF;
    out[p + 3] = vc.length & 0xFF;
    out.set(vc, p + 4);
    return out;
  }

  function flacFrameHeader(nch, frameNumber, blockSize) {
    var h = new Uint8Array(32);
    var len = 0;
    h[len++] = 0xFF;
    h[len++] = 0xF8;                  // sync 尾部 111110 + reserved 0 + fixed-blocksize 0
    var bsCode, bsExtraLen = 0, bsExtra0 = 0, bsExtra1 = 0;
    if (blockSize === 4096) { bsCode = 12; }
    else if (blockSize === 192) { bsCode = 1; }
    else if (blockSize === 576) { bsCode = 2; }
    else if (blockSize === 1152) { bsCode = 3; }
    else if (blockSize === 2304) { bsCode = 4; }
    else if (blockSize === 4608) { bsCode = 5; }
    else if (blockSize <= 256) { bsCode = 6; bsExtraLen = 1; bsExtra0 = blockSize - 1; }
    else { bsCode = 7; bsExtraLen = 2; bsExtra0 = (blockSize - 1) >>> 8; bsExtra1 = (blockSize - 1) & 0xFF; }
    h[len++] = (bsCode << 4);         // 采样率 code 0 = 从 STREAMINFO 取
    var chCode = nch === 1 ? 0 : (nch - 1);
    h[len++] = (chCode << 4) | (4 << 1);  // 采样位深 code 4 = 16-bit，reserved 0
    len = putUtf8(h, len, frameNumber);
    if (bsExtraLen === 1) { h[len++] = bsExtra0; }
    else if (bsExtraLen === 2) { h[len++] = bsExtra0; h[len++] = bsExtra1; }
    h[len] = crc8(h, len);
    len++;
    return h.subarray(0, len);
  }

  function flacResidual(samples, order, n, out) {
    var i;
    if (order === 0) {
      for (i = 0; i < n; i++) out[i] = samples[i];
      return n;
    }
    if (order === 1) {
      for (i = 1; i < n; i++) out[i - 1] = samples[i] - samples[i - 1];
      return n - 1;
    }
    for (i = 2; i < n; i++) out[i - 2] = samples[i] - 2 * samples[i - 1] + samples[i - 2];
    return n - 2;
  }

  function flacBestRice(res, count) {
    var i, sumAbs = 0;
    for (i = 0; i < count; i++) {
      var v = res[i];
      sumAbs += v < 0 ? -v : v;
    }
    var mean = count > 0 ? sumAbs / count : 0;
    var k0 = 0;
    while (k0 < 14 && mean > (1 << (k0 + 1))) k0++;
    var kLo = Math.max(0, k0 - 2);
    var kHi = Math.min(14, k0 + 3);
    var bestK = 0;
    var bestBits = Infinity;
    for (var k = kLo; k <= kHi; k++) {
      var bits = count * (1 + k);
      for (i = 0; i < count; i++) {
        var u = res[i];
        u = u < 0 ? ((-u) * 2 - 1) : (u * 2);
        bits += (u >>> k);
      }
      if (bits < bestBits) { bestBits = bits; bestK = k; }
    }
    return { k: bestK, bits: bestBits };
  }

  function flacChooseSubframe(samples, n, residual) {
    var i;
    var first = samples[0];
    var allSame = true;
    for (i = 1; i < n; i++) {
      if (samples[i] !== first) { allSame = false; break; }
    }
    if (allSame) return { type: 'constant' };
    var best = { type: 'verbatim' };
    var bestBits = 8 + n * 16;
    var maxOrder = Math.min(2, n - 1);
    for (var ord = 0; ord <= maxOrder; ord++) {
      var count = flacResidual(samples, ord, n, residual);
      if (count <= 0) continue;
      var rice = flacBestRice(residual, count);
      var bits = 8 + ord * 16 + 6 + 4 + rice.bits;
      if (bits < bestBits) {
        bestBits = bits;
        best = { type: 'fixed', order: ord, k: rice.k };
      }
    }
    return best;
  }

  function flacWriteSubframe(bw, samples, n, choice) {
    bw.writeBit(0);                                   // zero bit
    if (choice.type === 'constant') bw.writeBits(0, 6);
    else if (choice.type === 'verbatim') bw.writeBits(1, 6);
    else bw.writeBits(8 + choice.order, 6);           // FIXED，order 0..4
    bw.writeBit(0);                                   // wasted bits = 0

    if (choice.type === 'constant') {
      bw.writeSigned(samples[0], 16);
      return;
    }
    if (choice.type === 'verbatim') {
      for (var i = 0; i < n; i++) bw.writeSigned(samples[i], 16);
      return;
    }
    var ord = choice.order;
    for (var w = 0; w < ord; w++) bw.writeSigned(samples[w], 16);
    bw.writeBits(0, 2);                               // rice coding method = 00（4-bit 参数）
    bw.writeBits(0, 4);                               // partition order = 0
    bw.writeBits(choice.k, 4);                        // rice parameter
    var k = choice.k;
    var mask = (1 << k) - 1;
    for (var j = ord; j < n; j++) {
      var r;
      if (ord === 0) r = samples[j];
      else if (ord === 1) r = samples[j] - samples[j - 1];
      else r = samples[j] - 2 * samples[j - 1] + samples[j - 2];
      var u = r < 0 ? ((-r) * 2 - 1) : (r * 2);
      var q = u >>> k;
      for (var z = 0; z < q; z++) bw.writeBit(0);
      bw.writeBit(1);
      if (k > 0) bw.writeBits(u & mask, k);
    }
  }

  async function encodeFlac(channels, sampleRate, options, progress) {
    var meta = checkChannels(channels);
    var nch = meta.count;
    var n = meta.length;
    var sr = ensureSampleRate(sampleRate);
    if (n < 16) throw fail('FLAC 至少需要 16 个采样点（当前 ' + n + '）');

    var ints = [];
    var c;
    for (c = 0; c < nch; c++) ints.push(new Int16Array(n));

    for (var start = 0; start < n; start += WAV_CHUNK) {
      var end = Math.min(n, start + WAV_CHUNK);
      for (c = 0; c < nch; c++) {
        var dst = ints[c];
        var src = channels[c];
        for (var i = start; i < end; i++) dst[i] = quant16(src[i]);
      }
      progress.report(0.03 + 0.27 * (end / n));
      await progress.yieldIf();
    }

    var parts = [flacMetadataBlocks(sr, nch, n)];
    var residual = new Int32Array(FLAC_BLOCK + 8);
    var frameNumber = 0;
    for (var pos = 0; pos < n; pos += FLAC_BLOCK) {
      var bs = Math.min(FLAC_BLOCK, n - pos);
      var hdr = flacFrameHeader(nch, frameNumber, bs);
      var bw = new BitWriter(bs * nch * 2 + 256);
      for (c = 0; c < nch; c++) {
        var block = ints[c].subarray(pos, pos + bs);
        var choice = flacChooseSubframe(block, bs, residual);
        flacWriteSubframe(bw, block, bs, choice);
      }
      bw.align();
      var bodyLen = bw.len;
      var frame = new Uint8Array(hdr.length + bodyLen + 2);
      frame.set(hdr, 0);
      frame.set(bw.buf.subarray(0, bodyLen), hdr.length);
      var crc = crc16(frame, hdr.length + bodyLen);
      frame[hdr.length + bodyLen] = (crc >> 8) & 0xFF;
      frame[hdr.length + bodyLen + 1] = crc & 0xFF;
      parts.push(frame);
      frameNumber++;
      progress.report(0.3 + 0.7 * (Math.min(n, pos + bs) / n));
      await progress.yieldIf();
    }
    return concatParts(parts);
  }

  // ---------------------------------------------------------------------------
  // MP3（vendor/lame.min.js）
  // ---------------------------------------------------------------------------

  function getLamejsSilent() {
    try {
      if (typeof lamejs !== 'undefined' && lamejs && lamejs.Mp3Encoder) return lamejs;
    } catch (e) { /* 未定义 */ }
    if (root && root.lamejs && root.lamejs.Mp3Encoder) return root.lamejs;
    return null;
  }

  function getLamejs() {
    var lame = getLamejsSilent();
    if (!lame) throw fail('缺少 MP3 编码器 lamejs，请确认已加载 vendor/lame.min.js');
    return lame;
  }

  function lameBytes(b) {
    if (!b || !b.length) return null;
    var u8 = (b instanceof Uint8Array) ? b : new Uint8Array(b.buffer, b.byteOffset || 0, b.byteLength);
    return u8.slice();   // lamejs 复用内部缓冲区，必须立刻复制
  }

  function f32ToI16(x) {
    if (!(x === x)) return 0;
    if (x > 1) x = 1;
    else if (x < -1) x = -1;
    return x < 0 ? (x * 0x8000) : (x * 0x7FFF);
  }

  async function encodeMp3(channels, sampleRate, options, progress) {
    var lame = getLamejs();
    var meta = checkChannels(channels);
    var nch = meta.count;
    var n = meta.length;
    var sr = ensureSampleRate(sampleRate);
    var bitrate = pickOption(options, 'bitrate', [128, 192, 320], 192);
    var enc;
    try {
      enc = new lame.Mp3Encoder(nch, sr, bitrate);
    } catch (e) {
      throw fail('MP3 编码器初始化失败：' + (e && e.message ? e.message : e));
    }
    var BLOCK = 1152;
    var left = new Int16Array(BLOCK);
    var right = nch === 2 ? new Int16Array(BLOCK) : null;
    var parts = [];
    var totalBlocks = Math.ceil(n / BLOCK);
    for (var blk = 0; blk < totalBlocks; blk++) {
      var start = blk * BLOCK;
      var count = Math.min(BLOCK, n - start);
      for (var i = 0; i < count; i++) {
        left[i] = f32ToI16(channels[0][start + i]);
        if (right) right[i] = f32ToI16(channels[1][start + i]);
      }
      var out;
      if (nch === 1) out = enc.encodeBuffer(count === BLOCK ? left : left.subarray(0, count));
      else out = enc.encodeBuffer(count === BLOCK ? left : left.subarray(0, count),
                                  count === BLOCK ? right : right.subarray(0, count));
      var bytes = lameBytes(out);
      if (bytes) parts.push(bytes);
      progress.report(0.02 + 0.96 * ((blk + 1) / totalBlocks));
      if ((blk & 15) === 15) await progress.yieldIf();
    }
    var tail = lameBytes(enc.flush());
    if (tail) parts.push(tail);
    if (!parts.length) throw fail('MP3 编码没有得到任何数据');
    parts.push(new Uint8Array(0));    // 保持结构
    return concatParts(parts);
  }

  // ---------------------------------------------------------------------------
  // OGG Opus（WebCodecs AudioEncoder + 自写 Ogg 封装）
  // ---------------------------------------------------------------------------

  var OGG_CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var i = 0; i < 256; i++) {
      var r = (i << 24) >>> 0;
      for (var j = 0; j < 8; j++) {
        r = (r & 0x80000000) ? (((r << 1) ^ 0x04C11DB7) >>> 0) : ((r << 1) >>> 0);
      }
      t[i] = r >>> 0;
    }
    return t;
  })();

  function oggCrc32(bytes) {
    var c = 0;
    for (var i = 0; i < bytes.length; i++) {
      c = (((c << 8) >>> 0) ^ OGG_CRC_TABLE[((c >>> 24) ^ bytes[i]) & 0xFF]) >>> 0;
    }
    return c >>> 0;
  }

  function oggWriteU32(arr, off, v) {
    arr[off] = v & 0xFF;
    arr[off + 1] = (v >>> 8) & 0xFF;
    arr[off + 2] = (v >>> 16) & 0xFF;
    arr[off + 3] = (v >>> 24) & 0xFF;
  }

  // granulepos 用 64 位小端写；值小于 2^53，安全用 number 拆分
  function oggWriteU64(arr, off, v) {
    var lo = v % 4294967296;
    var hi = Math.floor(v / 4294967296);
    oggWriteU32(arr, off, lo);
    oggWriteU32(arr, off + 4, hi);
  }

  function buildOggPage(headerType, granule, serial, seq, packet) {
    var segs = [];
    var remaining = packet.length;
    while (remaining >= 255) {
      segs.push(255);
      remaining -= 255;
    }
    segs.push(remaining);
    if (segs.length > 255) throw fail('OGG 页分段过多');
    var page = new Uint8Array(27 + segs.length + packet.length);
    asciiBytes(page, 0, 'OggS');
    page[4] = 0;                                  // version
    page[5] = headerType;
    oggWriteU64(page, 6, granule);
    oggWriteU32(page, 14, serial >>> 0);
    oggWriteU32(page, 18, seq >>> 0);
    // CRC 字段 22..25 保持 0
    page[26] = segs.length;
    for (var i = 0; i < segs.length; i++) page[27 + i] = segs[i];
    page.set(packet, 27 + segs.length);
    var crc = oggCrc32(page);
    oggWriteU32(page, 22, crc);
    return page;
  }

  function opusPacketSamples(u8) {
    var toc = u8[0];
    var config = toc >> 3;
    var c = toc & 3;
    var dur;
    if (config < 12) dur = [10, 20, 40, 60][config & 3];
    else if (config < 16) dur = [10, 20][config & 1];
    else dur = [2.5, 5, 10, 20][config & 3];
    var frames;
    if (c === 0) frames = 1;
    else if (c === 1 || c === 2) frames = 2;
    else frames = u8.length > 0 ? (u8[u8.length - 1] & 0x3F) : 1;
    var samples = Math.round(dur * frames * 48);
    return samples > 0 ? samples : 960;
  }

  function muxOggOpus(packets, nch, inputSampleRate, totalFrames) {
    var preSkip = 312;                      // libopus 48k 默认 lookahead
    var serial = (0x5A4D4F21 ^ ((nch & 0xFF) << 8) ^ (inputSampleRate & 0xFFFF)) >>> 0;
    var head = new Uint8Array(19);
    asciiBytes(head, 0, 'OpusHead');
    head[8] = 1;
    head[9] = nch;
    head[10] = preSkip & 0xFF;
    head[11] = (preSkip >>> 8) & 0xFF;
    head[12] = inputSampleRate & 0xFF;
    head[13] = (inputSampleRate >>> 8) & 0xFF;
    head[14] = (inputSampleRate >>> 16) & 0xFF;
    head[15] = (inputSampleRate >>> 24) & 0xFF;
    head[16] = 0; head[17] = 0;             // output gain 0
    head[18] = 0;                           // mapping family 0

    var vendor = utf8Bytes('ZAOMAI STUDIO ' + VERSION);
    var tags = new Uint8Array(8 + 4 + vendor.length + 4);
    asciiBytes(tags, 0, 'OpusTags');
    oggWriteU32(tags, 8, vendor.length);
    tags.set(vendor, 12);
    oggWriteU32(tags, 12 + vendor.length, 0);

    var parts = [];
    parts.push(buildOggPage(0x02, 0, serial, 0, head));
    parts.push(buildOggPage(0x00, 0, serial, 1, tags));

    // Ogg Opus 的 granulepos 是"已解码样本总数"（包含 pre-skip、扣除尾部 padding）。
    // 因此逐包累加，再统一封顶在 pre-skip + 实际输入帧数：
    // 编码器 flush 常会多出 1 个纯 padding 包，封顶后 EOS 页正好裁掉它。
    // 不能在每页都加 pre-skip，否则 ffmpeg 会二次裁剪，末尾少 312 个采样。
    var finalG = preSkip + totalFrames;
    var seq = 2;
    var cum = 0;
    var lastGranule = 0;
    for (var i = 0; i < packets.length; i++) {
      var p = packets[i];
      var samples = p.samples || opusPacketSamples(p.bytes);
      cum += samples;
      var g = Math.min(finalG, cum);
      if (g < lastGranule) g = lastGranule;
      lastGranule = g;
      var eos = (i === packets.length - 1) ? 0x04 : 0x00;
      parts.push(buildOggPage(eos, g, serial, seq, p.bytes));
      seq++;
    }
    // 最后一页 granule 必须落在实际输入长度上（编码器少给样本时补正）
    if (packets.length && lastGranule !== finalG) {
      var last = parts[parts.length - 1];
      var tmp = last.slice();
      oggWriteU64(tmp, 6, finalG);
      oggWriteU32(tmp, 22, 0);
      var crc = oggCrc32(tmp);
      oggWriteU32(tmp, 22, crc);
      parts[parts.length - 1] = tmp;
    }
    return concatParts(parts);
  }

  // 16 抽头 Hann 窗 sinc 重采样（带截止频率，上/下采样都可用）
  function buildResampleTable(ratio, taps, phases) {
    var half = taps / 2;
    var cutoff = Math.min(1, ratio) * 0.96;
    var table = [];
    for (var p = 0; p < phases; p++) {
      var arr = new Float32Array(taps);
      var frac = p / phases;
      var sum = 0;
      for (var t = 0; t < taps; t++) {
        var x = (t - half + 1) - frac;
        var px = x * cutoff * Math.PI;
        var sinc = (Math.abs(px) < 1e-9) ? 1 : (Math.sin(px) / px);
        var win = 0.5 + 0.5 * Math.cos(Math.PI * x / half);
        if (Math.abs(x) >= half) win = 0;
        var val = sinc * cutoff * win;
        arr[t] = val;
        sum += val;
      }
      if (sum !== 0) {
        for (var t2 = 0; t2 < taps; t2++) arr[t2] /= sum;
      }
      table.push(arr);
    }
    return table;
  }

  async function resampleTo48k(channels, inRate, progress) {
    var ratio = 48000 / inRate;
    var nch = channels.length;
    var inLen = channels[0].length;
    var outLen = Math.max(1, Math.round(inLen * ratio));
    var taps = 16;
    var phases = 256;
    var table = buildResampleTable(ratio, taps, phases);
    var half = taps / 2;
    var out = [];
    for (var c = 0; c < nch; c++) out.push(new Float32Array(outLen));
    var CHUNK = 16384;
    for (var start = 0; start < outLen; start += CHUNK) {
      var end = Math.min(outLen, start + CHUNK);
      for (c = 0; c < nch; c++) {
        var src = channels[c];
        var dstArr = out[c];
        for (var o = start; o < end; o++) {
          var srcPos = o / ratio;
          var center = Math.floor(srcPos);
          var frac = srcPos - center;
          var phase = (frac * phases) | 0;
          if (phase >= phases) phase = phases - 1;
          var w = table[phase];
          var base = center - half + 1;
          var acc = 0;
          for (var t = 0; t < taps; t++) {
            var idx = base + t;
            if (idx < 0) idx = 0;
            else if (idx >= inLen) idx = inLen - 1;
            acc += src[idx] * w[t];
          }
          dstArr[o] = cleanFloat(acc);
        }
      }
      progress.report(0.02 + 0.23 * (end / outLen));
      await progress.yieldIf();
    }
    return out;
  }

  function opusAvailable() {
    var w = (typeof window !== 'undefined') ? window : null;
    if (!w || typeof w.AudioEncoder !== 'function') return false;
    return true;
  }

  async function encodeOgg(channels, sampleRate, options, progress) {
    var w = (typeof window !== 'undefined') ? window : null;
    if (!w || typeof w.AudioEncoder !== 'function') {
      throw fail('当前浏览器不支持 OGG Opus 编码（需要最新版 Chrome / Edge 的 WebCodecs）');
    }
    if (typeof w.AudioData !== 'function') {
      throw fail('当前浏览器缺少 WebCodecs AudioData，无法导出 OGG Opus');
    }
    var meta = checkChannels(channels);
    var nch = meta.count;
    var srcRate = ensureSampleRate(sampleRate);
    var bitrate = pickOption(options, 'bitrate', [96, 128, 192], 128);

    var cfg = {
      codec: 'opus',
      sampleRate: 48000,
      numberOfChannels: nch,
      bitrate: bitrate * 1000
    };
    var supported = false;
    try {
      var sup = await w.AudioEncoder.isConfigSupported(cfg);
      supported = !!(sup && sup.supported);
    } catch (e) {
      throw fail('OGG Opus 配置被浏览器拒绝：' + (e && e.message ? e.message : e));
    }
    if (!supported) throw fail('当前浏览器不支持 OGG Opus 编码（AudioEncoder 拒绝 opus 配置）');

    var src = channels;
    if (srcRate !== 48000) {
      src = await resampleTo48k(channels, srcRate, progress);
    }
    var n = src[0].length;

    var packets = [];
    var encError = null;
    var enc = new w.AudioEncoder({
      output: function (chunk) {
        var len = chunk.byteLength;
        var u8 = new Uint8Array(len);
        try {
          chunk.copyTo(u8);
        } catch (e) { return; }
        packets.push({ bytes: u8, ts: chunk.timestamp, dur: chunk.duration, samples: 0 });
      },
      error: function (e) { encError = e || new Error('unknown'); }
    });
    enc.configure(cfg);

    var CHUNK_FRAMES = 4800;            // 100ms
    var dataBuf = new Float32Array(CHUNK_FRAMES * nch);
    for (var start = 0; start < n; start += CHUNK_FRAMES) {
      if (encError) break;
      var count = Math.min(CHUNK_FRAMES, n - start);
      for (var c = 0; c < nch; c++) {
        var sc = src[c];
        var base = c * count;
        for (var i = 0; i < count; i++) dataBuf[base + i] = cleanFloat(sc[start + i]);
      }
      var frameData = (count === CHUNK_FRAMES) ? dataBuf : dataBuf.slice(0, count * nch);
      var ad = new w.AudioData({
        format: 'f32-planar',
        sampleRate: 48000,
        numberOfFrames: count,
        numberOfChannels: nch,
        timestamp: Math.round(start * 1000000 / 48000),
        data: frameData
      });
      enc.encode(ad);
      ad.close();
      progress.report(0.3 + 0.65 * ((start + count) / n));
      await progress.yieldIf();
    }
    if (encError) {
      try { enc.close(); } catch (e) { /* ignore */ }
      throw fail('OGG 编码失败：' + (encError.message || String(encError)));
    }
    try {
      await enc.flush();
    } catch (e) {
      try { enc.close(); } catch (e2) { /* ignore */ }
      throw fail('OGG 编码失败：' + (e && e.message ? e.message : e));
    }
    try { enc.close(); } catch (e) { /* ignore */ }
    if (!packets.length) throw fail('OGG 编码没有得到任何数据');

    packets.sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });
    for (var p = 0; p < packets.length; p++) {
      var pkt = packets[p];
      var byDur = pkt.dur ? Math.round(pkt.dur * 48 / 1000) : 0;
      pkt.samples = byDur > 0 ? byDur : opusPacketSamples(pkt.bytes);
    }
    var bytes = muxOggOpus(packets, nch, srcRate, n);
    progress.report(1);
    return bytes;
  }

  // ---------------------------------------------------------------------------
  // ZIP（store / 不压缩，UTF-8 文件名，固定时间戳）
  // ---------------------------------------------------------------------------

  var ZIP_TIME = 0;          // 00:00:00
  var ZIP_DATE = 0x0021;     // 1980-01-01

  var ZIP_CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) {
        c = (c & 1) ? ((0xEDB88320 ^ (c >>> 1)) >>> 0) : (c >>> 1);
      }
      t[n] = c >>> 0;
    }
    return t;
  })();

  function zipCrc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) {
      c = ZIP_CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function buildZip(files) {
    var i, f;
    var localSize = 0;
    var centralSize = 0;
    for (i = 0; i < files.length; i++) {
      f = files[i];
      f.nameBytes = utf8Bytes(f.name);
      f.crc = zipCrc32(f.bytes);
      localSize += 30 + f.nameBytes.length + f.bytes.length;
      centralSize += 46 + f.nameBytes.length;
    }
    var out = new Uint8Array(localSize + centralSize + 22);
    var dv = new DataView(out.buffer);
    var off = 0;
    for (i = 0; i < files.length; i++) {
      f = files[i];
      f.offset = off;
      dv.setUint32(off, 0x04034B50, true);
      dv.setUint16(off + 4, 20, true);            // version needed
      dv.setUint16(off + 6, 0x0800, true);        // UTF-8 文件名标记
      dv.setUint16(off + 8, 0, true);             // method 0 = store
      dv.setUint16(off + 10, ZIP_TIME, true);
      dv.setUint16(off + 12, ZIP_DATE, true);
      dv.setUint32(off + 14, f.crc, true);
      dv.setUint32(off + 18, f.bytes.length, true);
      dv.setUint32(off + 22, f.bytes.length, true);
      dv.setUint16(off + 26, f.nameBytes.length, true);
      dv.setUint16(off + 28, 0, true);
      off += 30;
      out.set(f.nameBytes, off);
      off += f.nameBytes.length;
      out.set(f.bytes, off);
      off += f.bytes.length;
    }
    var cdOff = off;
    for (i = 0; i < files.length; i++) {
      f = files[i];
      dv.setUint32(off, 0x02014B50, true);
      dv.setUint16(off + 4, 20, true);            // version made by
      dv.setUint16(off + 6, 20, true);            // version needed
      dv.setUint16(off + 8, 0x0800, true);
      dv.setUint16(off + 10, 0, true);
      dv.setUint16(off + 12, ZIP_TIME, true);
      dv.setUint16(off + 14, ZIP_DATE, true);
      dv.setUint32(off + 16, f.crc, true);
      dv.setUint32(off + 20, f.bytes.length, true);
      dv.setUint32(off + 24, f.bytes.length, true);
      dv.setUint16(off + 28, f.nameBytes.length, true);
      dv.setUint16(off + 30, 0, true);            // extra
      dv.setUint16(off + 32, 0, true);            // comment
      dv.setUint16(off + 34, 0, true);            // disk
      dv.setUint16(off + 36, 0, true);            // internal attrs
      dv.setUint32(off + 38, 0, true);            // external attrs
      dv.setUint32(off + 42, f.offset, true);
      off += 46;
      out.set(f.nameBytes, off);
      off += f.nameBytes.length;
    }
    var eocd = off;
    dv.setUint32(eocd, 0x06054B50, true);
    dv.setUint16(eocd + 4, 0, true);
    dv.setUint16(eocd + 6, 0, true);
    dv.setUint16(eocd + 8, files.length, true);
    dv.setUint16(eocd + 10, files.length, true);
    dv.setUint32(eocd + 12, centralSize, true);
    dv.setUint32(eocd + 16, cdOff, true);
    dv.setUint16(eocd + 20, 0, true);
    return out;
  }

  function bytesOfBlobSync(b, name) {
    if (ArrayBuffer.isView(b)) {
      return new Uint8Array(b.buffer, b.byteOffset || 0, b.byteLength);
    }
    if (typeof ArrayBuffer !== 'undefined' && b instanceof ArrayBuffer) {
      return new Uint8Array(b);
    }
    if (b && typeof b === 'object' && BLOB_BYTES && BLOB_BYTES.has(b)) {
      return BLOB_BYTES.get(b);
    }
    throw fail('ZIP 条目“' + name + '”的数据无法同步读取（不是本模块生成的 Blob），请改用 zipAsync() 或传入 Uint8Array');
  }

  async function bytesOfEntryAsync(b, name) {
    if (b === undefined || b === null) throw fail('ZIP 条目“' + name + '”缺少数据');
    if (ArrayBuffer.isView(b)) return new Uint8Array(b.buffer, b.byteOffset || 0, b.byteLength);
    if (typeof ArrayBuffer !== 'undefined' && b instanceof ArrayBuffer) return new Uint8Array(b);
    if (typeof Blob !== 'undefined' && b instanceof Blob) {
      var ab = await b.arrayBuffer();
      return new Uint8Array(ab);
    }
    if (b && typeof b === 'object' && BLOB_BYTES && BLOB_BYTES.has(b)) return BLOB_BYTES.get(b);
    throw fail('ZIP 条目“' + name + '”的数据类型不支持');
  }

  function normalizeEntries(entries) {
    if (!entries || typeof entries.length !== 'number') throw fail('ZIP 条目列表无效');
    var out = [];
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (!e || typeof e.name !== 'string' || !e.name) throw fail('ZIP 条目缺少文件名');
      out.push(e);
    }
    return out;
  }

  // 同步版：entries 里的数据必须是 Uint8Array / ArrayBuffer，或本模块 encode() 产出的 Blob
  function zip(entries) {
    var list = normalizeEntries(entries);
    var files = [];
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      var b = (e.blob !== undefined) ? e.blob : e.bytes;
      files.push({ name: e.name, bytes: bytesOfBlobSync(b, e.name) });
    }
    return wrapBytes(buildZip(files), 'application/zip');
  }

  // 异步版：可读取任意 Blob
  async function zipAsync(entries) {
    var list = normalizeEntries(entries);
    var files = [];
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      var b = (e.blob !== undefined) ? e.blob : e.bytes;
      files.push({ name: e.name, bytes: await bytesOfEntryAsync(b, e.name) });
    }
    return wrapBytes(buildZip(files), 'application/zip');
  }

  // ---------------------------------------------------------------------------
  // 对外 API
  // ---------------------------------------------------------------------------

  function isSupported(formatId) {
    var id = String(formatId);
    if (id === 'ogg') return opusAvailable();
    if (id === 'mp3') return !!getLamejsSilent();
    if (!findFormat(id)) return false;
    return true;
  }

  async function encode(formatId, channels, sampleRate, options, onProgress) {
    if (typeof options === 'function' && onProgress === undefined) {
      onProgress = options;
      options = {};
    }
    if (!options || typeof options !== 'object') options = {};
    var fmt = findFormat(formatId);
    if (!fmt) throw fail('不支持的导出格式：' + String(formatId));
    var progress = new Progress(onProgress);
    progress.report(0);

    var bytes;
    switch (fmt.id) {
      case 'wav16':
        bytes = await encodeWav(channels, sampleRate, 'wav16', options, progress);
        break;
      case 'wav24':
        bytes = await encodeWav(channels, sampleRate, 'wav24', options, progress);
        break;
      case 'wav32f':
        bytes = await encodeWav(channels, sampleRate, 'wav32f', options, progress);
        break;
      case 'aiff':
        bytes = await encodeAiff(channels, sampleRate, options, progress);
        break;
      case 'flac':
        bytes = await encodeFlac(channels, sampleRate, options, progress);
        break;
      case 'mp3':
        bytes = await encodeMp3(channels, sampleRate, options, progress);
        break;
      case 'ogg':
        bytes = await encodeOgg(channels, sampleRate, options, progress);
        break;
      default:
        throw fail('不支持的导出格式：' + fmt.id);
    }
    progress.report(1);
    return wrapBytes(bytes, fmt.mime);
  }

  return {
    version: VERSION,
    FORMATS: FORMATS,
    isSupported: isSupported,
    encode: encode,
    zip: zip,
    zipAsync: zipAsync
  };
});
