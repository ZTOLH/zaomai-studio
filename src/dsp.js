/*!
 * ZAOMAI STUDIO - DSP 引擎
 * 版本 1.0.0
 * 纯 JS：(1) 浏览器 classic script 挂 window.ZaomaiDSP；(2) Node CJS module.exports。
 * 不依赖 AudioContext / DOM / 网络，可在 Node 中直接跑验收测试。
 *
 * 处理链：RBJ 滤波 -> 预增益 -> 2x 过采样硬削波 -> tanh 饱和 -> bitcrush/降采样
 *        -> 三段 EQ -> 立体声联动压缩 -> 鞭炮层/爆炸泵 -> 真峰值限幅
 *        -> BS.1770-4 响度归一化到 targetLufs（TP 不超过 ceilingDb）。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.ZaomaiDSP = api;
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  var VERSION = '1.0.0';
  var LN10_20 = 0.11512925464970229; /* ln(10) / 20 */
  /* 4x 真峰值插值滤波在 8–15kHz 会低估约 0.1–0.7dB；加 0.4dB 安全余量，
     与 ffmpeg ebur128(peak=true) 的交叉验证更稳，也避免实际 TP 越界。 */
  var TP_SAFETY_DB = 0.4;
  var TP_SAFETY_LIN = Math.pow(10, TP_SAFETY_DB / 20);

  /* ======================================================================
   * 1. 基础数值工具
   * ==================================================================== */

  function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  }

  function dbToGain(db) {
    return Math.pow(10, db / 20);
  }

  function gainToDb(g) {
    return 20 * Math.log10(g > 1e-12 ? g : 1e-12);
  }

  function isNum(v) {
    return typeof v === 'number' && isFinite(v);
  }

  function nowMs() {
    if (typeof performance !== 'undefined' && performance &&
        typeof performance.now === 'function') {
      return performance.now();
    }
    return Date.now();
  }

  /* 固定种子 PRNG（mulberry32），保证同一输入 + 参数逐样本一致 */
  function makePRNG(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* 输入校验 + 深拷贝清洗（NaN/Infinity -> 0），绝不修改调用方数据 */
  function validateAndCopy(channels, sampleRate) {
    if (!channels || typeof channels.length !== 'number' || channels.length < 1) {
      throw new Error('音频数据为空：至少需要 1 个声道');
    }
    if (channels.length > 2) {
      throw new Error('音频数据无效：仅支持单声道或立体声');
    }
    var sr = Number(sampleRate);
    if (!isFinite(sr) || sr < 8000 || sr > 192000) {
      throw new Error('采样率无效：需在 8000–192000 Hz 之间');
    }
    sr = Math.round(sr);
    var out = [];
    var len = -1;
    for (var c = 0; c < channels.length; c++) {
      var ch = channels[c];
      if (!ch || typeof ch.length !== 'number') {
        throw new Error('音频声道数据无效');
      }
      var n = ch.length;
      if (n < 1) {
        throw new Error('音频数据为空：声道长度必须大于 0');
      }
      if (len < 0) {
        len = n;
      } else if (n !== len) {
        throw new Error('音频声道长度不一致');
      }
      var copy = new Float64Array(n);
      for (var i = 0; i < n; i++) {
        var v = ch[i];
        copy[i] = (typeof v === 'number' && isFinite(v)) ? v : 0;
      }
      out.push(copy);
    }
    return { channels: out, sampleRate: sr, length: len };
  }

  function toFloat32(arr) {
    var out = new Float32Array(arr.length);
    for (var i = 0; i < arr.length; i++) {
      var v = arr[i];
      if (!isFinite(v)) v = 0;
      else if (v > 1) v = 1;
      else if (v < -1) v = -1;
      out[i] = v;
    }
    return out;
  }

  function applyGainDb(channels, db) {
    if (!isFinite(db) || Math.abs(db) < 1e-12) return;
    var g = dbToGain(db);
    for (var c = 0; c < channels.length; c++) {
      var x = channels[c];
      for (var i = 0; i < x.length; i++) x[i] *= g;
    }
  }

  /* ======================================================================
   * 2. RBJ biquad 滤波器（每声道独立状态）
   * ==================================================================== */

  function biquadCoeffs(type, sr, freq, gainDb, q) {
    var f = clamp(freq, 10, sr * 0.495);
    var w0 = 2 * Math.PI * f / sr;
    var cw = Math.cos(w0);
    var sw = Math.sin(w0);
    var Q = (q && q > 0) ? q : 0.7071067811865476;
    var A = Math.pow(10, (gainDb || 0) / 40);
    var alpha, b0, b1, b2, a0, a1, a2;

    if (type === 'peaking') {
      alpha = sw / (2 * Q);
      b0 = 1 + alpha * A;
      b1 = -2 * cw;
      b2 = 1 - alpha * A;
      a0 = 1 + alpha / A;
      a1 = -2 * cw;
      a2 = 1 - alpha / A;
    } else if (type === 'lowshelf') {
      alpha = sw * 0.7071067811865476; /* S = 1 */
      var sqA = Math.sqrt(A);
      b0 = A * ((A + 1) - (A - 1) * cw + 2 * sqA * alpha);
      b1 = 2 * A * ((A - 1) - (A + 1) * cw);
      b2 = A * ((A + 1) - (A - 1) * cw - 2 * sqA * alpha);
      a0 = (A + 1) + (A - 1) * cw + 2 * sqA * alpha;
      a1 = -2 * ((A - 1) + (A + 1) * cw);
      a2 = (A + 1) + (A - 1) * cw - 2 * sqA * alpha;
    } else if (type === 'highshelf') {
      alpha = sw * 0.7071067811865476;
      var sqA2 = Math.sqrt(A);
      b0 = A * ((A + 1) + (A - 1) * cw + 2 * sqA2 * alpha);
      b1 = -2 * A * ((A - 1) + (A + 1) * cw);
      b2 = A * ((A + 1) + (A - 1) * cw - 2 * sqA2 * alpha);
      a0 = (A + 1) - (A - 1) * cw + 2 * sqA2 * alpha;
      a1 = 2 * ((A - 1) - (A + 1) * cw);
      a2 = (A + 1) - (A - 1) * cw - 2 * sqA2 * alpha;
    } else if (type === 'highpass') {
      alpha = sw / (2 * Q);
      b0 = (1 + cw) / 2;
      b1 = -(1 + cw);
      b2 = (1 + cw) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cw;
      a2 = 1 - alpha;
    } else if (type === 'lowpass') {
      alpha = sw / (2 * Q);
      b0 = (1 - cw) / 2;
      b1 = 1 - cw;
      b2 = (1 - cw) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cw;
      a2 = 1 - alpha;
    } else {
      throw new Error('未知的滤波器类型: ' + type);
    }

    var inv = 1 / a0;
    return {
      b0: b0 * inv, b1: b1 * inv, b2: b2 * inv,
      a1: a1 * inv, a2: a2 * inv
    };
  }

  function applyCoeffsInPlace(x, k) {
    var x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (var i = 0; i < x.length; i++) {
      var xi = x[i];
      var y = k.b0 * xi + k.b1 * x1 + k.b2 * x2 - k.a1 * y1 - k.a2 * y2;
      x2 = x1; x1 = xi;
      y2 = y1;
      if (y > -1e-20 && y < 1e-20) y = 0; /* 去 denormal */
      y1 = y;
      x[i] = y;
    }
  }

  function filterAll(channels, type, sr, freq, gainDb, q) {
    var k = biquadCoeffs(type, sr, freq, gainDb, q);
    for (var c = 0; c < channels.length; c++) {
      applyCoeffsInPlace(channels[c], k);
    }
  }

  /* ======================================================================
   * 3. 削波 / 饱和 / 量化 / 压缩
   * ==================================================================== */

  /* 硬削波，2x 线性插值过采样 + 平均抽取，减少刺耳混叠 */
  function hardClip2x(channels, threshold) {
    var thr = clamp(threshold, 0.01, 1);
    for (var c = 0; c < channels.length; c++) {
      var x = channels[c];
      var n = x.length;
      for (var i = 0; i < n; i++) {
        var a = x[i];
        var b = (i + 1 < n) ? 0.5 * (a + x[i + 1]) : a;
        var ca = a > thr ? thr : (a < -thr ? -thr : a);
        var cb = b > thr ? thr : (b < -thr ? -thr : b);
        x[i] = 0.5 * (ca + cb);
      }
    }
  }

  /* 硬削波（不做过采样）：归一化阶段用于制造密度、压低 crest */
  function hardClipInPlace(channels, threshold) {
    var thr = clamp(threshold, 0.01, 1);
    for (var c = 0; c < channels.length; c++) {
      var x = channels[c];
      for (var i = 0; i < x.length; i++) {
        x[i] = x[i] > thr ? thr : (x[i] < -thr ? -thr : x[i]);
      }
    }
  }

  /* tanh 饱和：drive 越大越硬，wet 为湿声比例；归一化保证 ±1 映射稳定 */
  function saturate(channels, drive, wet) {
    var norm = Math.tanh(drive);
    if (!isFinite(norm) || Math.abs(norm) < 1e-9) norm = 1;
    var dry = 1 - wet;
    for (var c = 0; c < channels.length; c++) {
      var x = channels[c];
      for (var i = 0; i < x.length; i++) {
        var v = x[i];
        x[i] = dry * v + wet * (Math.tanh(drive * v) / norm);
      }
    }
  }

  /* bitcrush + sample-hold，量化到 [-1, 1] */
  function bitCrush(channels, bits, hold) {
    var b = clamp(Math.round(bits), 2, 16);
    var h = clamp(Math.round(hold), 1, 8);
    var levels = Math.pow(2, b - 1);
    for (var c = 0; c < channels.length; c++) {
      var x = channels[c];
      var held = 0;
      for (var i = 0; i < x.length; i++) {
        if ((i % h) === 0) {
          var q = Math.round(x[i] * levels) / levels;
          held = q > 1 ? 1 : (q < -1 ? -1 : q);
        }
        x[i] = held;
      }
    }
  }

  /* feed-forward 软拐点压缩，立体声联动（两声道最大值检测） */
  function compress(channels, sr, thresholdDb, ratio, attackMs, releaseMs, kneeDb, makeupDb) {
    var nch = channels.length;
    var n = channels[0].length;
    var att = Math.exp(-1 / Math.max(1, attackMs * 0.001 * sr));
    var rel = Math.exp(-1 / Math.max(1, releaseMs * 0.001 * sr));
    var slope = 1 - 1 / Math.max(1.0001, ratio);
    var knee = Math.max(0.0001, kneeDb);
    var makeup = dbToGain(makeupDb);
    var gr = 0;
    var halfKnee = knee / 2;
    for (var i = 0; i < n; i++) {
      var peak = Math.abs(channels[0][i]);
      if (nch > 1) {
        var p2 = Math.abs(channels[1][i]);
        if (p2 > peak) peak = p2;
      }
      var over = gainToDb(peak) - thresholdDb;
      var target;
      if (over <= -halfKnee) {
        target = 0;
      } else if (over < halfKnee) {
        var t = over + halfKnee;
        target = slope * t * t / (2 * knee);
      } else {
        target = slope * over;
      }
      if (target > gr) gr = att * gr + (1 - att) * target;
      else gr = rel * gr + (1 - rel) * target;
      if (gr < 0) gr = 0;
      var g = Math.exp(-gr * LN10_20) * makeup;
      for (var c = 0; c < nch; c++) {
        channels[c][i] *= g;
      }
    }
  }

  /* ======================================================================
   * 4. 鞭炮层（firecracker 专属，固定种子）
   * ==================================================================== */

  var bandCache = {};

  function getBandCoeffs(sr, lo, hi) {
    var key = sr + '|' + lo + '|' + hi;
    if (bandCache[key] !== undefined) return bandCache[key];
    var nyq = sr * 0.45;
    var h = Math.min(hi, nyq);
    var l = Math.max(lo, 20);
    var res = null;
    if (h > l * 1.1) {
      res = {
        hp: biquadCoeffs('highpass', sr, l, 0, 0.7071067811865476),
        lp: biquadCoeffs('lowpass', sr, h, 0, 0.7071067811865476)
      };
    }
    bandCache[key] = res;
    return res;
  }

  function renderNoiseEvent(out, start, len, sr, band, amp, decay, rng) {
    if (start >= out.length) return;
    var count = Math.min(len, out.length - start);
    var tmp = new Float64Array(count);
    for (var j = 0; j < count; j++) {
      tmp[j] = (rng() * 2 - 1) * Math.exp(-j / decay);
    }
    if (band) {
      applyCoeffsInPlace(tmp, band.hp);
      applyCoeffsInPlace(tmp, band.lp);
    }
    for (var j2 = 0; j2 < count; j2++) {
      out[start + j2] += amp * tmp[j2];
    }
  }

  /*
   * 鞭炮层：
   * - 单声道包络（attack 1ms / release 80ms）做 onset 检测，自适应阈值，refractory 60ms；
   * - onset 触发炮仗：1.5–7kHz 噪声 + 80–110Hz 闷响，指数衰减；
   * - 连续噼啪：密度 0–20 个/秒的 5–12kHz 短 click；
   * - 爆炸泵：由炮仗包络驱动 25% 深度 ducking，恢复 ~120ms；
   * - 全部使用 0x5EED 固定种子，逐样本可复现。
   */
  function addFirecrackerLayer(channels, sr, density) {
    var nch = channels.length;
    var n = channels[0].length;
    var d = clamp(isNum(density) ? density : 8, 0, 20);
    var att = Math.exp(-1 / Math.max(1, 0.001 * sr));
    var rel = Math.exp(-1 / Math.max(1, 0.080 * sr));
    var slowRel = Math.exp(-1 / Math.max(1, 0.300 * sr));
    var env = 0;
    var slow = 0;
    var sumSq = 0;
    var popStarts = [];
    var lastOnset = -1e12;
    var refractory = Math.max(1, Math.round(0.06 * sr));

    for (var i = 0; i < n; i++) {
      var x0 = channels[0][i];
      var a = x0 < 0 ? -x0 : x0;
      sumSq += x0 * x0;
      if (nch > 1) {
        var x1 = channels[1][i];
        var a1 = x1 < 0 ? -x1 : x1;
        if (a1 > a) a = a1;
        sumSq += x1 * x1;
      }
      if (a > env) env = att * env + (1 - att) * a;
      else env = rel * env + (1 - rel) * a;
      if (a > slow) slow = att * slow + (1 - att) * a;
      else slow = slowRel * slow + (1 - slowRel) * a;
      if (i - lastOnset >= refractory && env > 0.008 && env > slow * 2.0 + 0.006) {
        popStarts.push(i);
        lastOnset = i;
      }
    }

    var musicRms = Math.sqrt(sumSq / (n * nch));
    if (!(musicRms > 1e-6)) return; /* 静音不生成鞭炮 */

    var rng = makePRNG(0x5EED);
    var layer = new Float64Array(n);
    var pump = new Float64Array(n);
    var popAmp = musicRms * 2.6;
    var crackleAmp = popAmp * 0.5;
    var popBand = getBandCoeffs(sr, 1500, 7000);
    var crackBand = getBandCoeffs(sr, 5000, 12000);
    var pumpLen = Math.max(1, Math.round(0.12 * sr));
    var pumpTau = Math.max(1, 0.04 * sr);

    for (var p = 0; p < popStarts.length; p++) {
      var start = popStarts[p];
      var durSec = 0.015 + rng() * 0.035;
      var len = Math.max(8, Math.round(durSec * sr));
      var decay = Math.max(2, len / 2.5);
      renderNoiseEvent(layer, start, len, sr, popBand,
        popAmp * (0.75 + 0.5 * rng()), decay, rng);
      /* 80–110Hz 闷响，衰减约 80ms */
      var f = 80 + rng() * 30;
      var tlen = Math.min(n - start, Math.round(0.08 * sr));
      var tdecay = Math.max(2, tlen / 3);
      var w = 2 * Math.PI * f / sr;
      for (var j = 0; j < tlen; j++) {
        layer[start + j] += popAmp * 0.85 * Math.sin(w * j) * Math.exp(-j / tdecay);
      }
      /* 爆炸泵包络 */
      var plen = Math.min(n - start, pumpLen);
      for (var j2 = 0; j2 < plen; j2++) {
        var e = Math.exp(-j2 / pumpTau);
        if (e > pump[start + j2]) pump[start + j2] = e;
      }
    }

    /* 连续噼啪层：密度个/秒，位置随机但种子固定 */
    var crackleCount = Math.round(d * (n / sr));
    for (var c = 0; c < crackleCount; c++) {
      var cstart = Math.floor(rng() * n);
      var clen = Math.max(4, Math.round((0.005 + rng() * 0.010) * sr));
      var cdecay = Math.max(2, clen / 3);
      renderNoiseEvent(layer, cstart, clen, sr, crackBand,
        crackleAmp * (0.7 + 0.6 * rng()), cdecay, rng);
    }

    for (var i2 = 0; i2 < n; i2++) {
      var duck = 1 - 0.25 * pump[i2];
      var lv = layer[i2];
      for (var ch = 0; ch < nch; ch++) {
        channels[ch][i2] = channels[ch][i2] * duck + lv;
      }
    }
  }

  /*
   * 归一化后的鞭炮瞬态层：5–12kHz 高频 crackle，固定种子。
   * 归一化会重度硬削波，链内鞭炮层的高频瞬态容易被削平；这一层在归一化之后
   * 用「全频段 duck + 短促高频爆发」替换对应瞬间，既保留可闻瞬态，又不抬高真峰值。
   */
  function addFirecrackerPost(channels, sr, density, ceilingLin) {
    var nch = channels.length;
    var n = channels[0].length;
    var d = clamp(isNum(density) ? density : 8, 0, 20);
    if (!(d > 0) || n < 8) return;

    var rng = makePRNG(0x5EED);
    var count = Math.round(d * (n / sr));
    if (count < 1) return;
    var starts = [];
    for (var k = 0; k < count; k++) starts.push(Math.floor(rng() * n));
    starts.sort(function (a, b) { return a - b; });

    var click = new Float64Array(n);
    var duck = new Float64Array(n);
    var amp = (isFinite(ceilingLin) && ceilingLin > 0 ? ceilingLin : 0.98) * 0.88;
    var maxF = Math.min(10000, sr * 0.42);
    var release = Math.max(1, Math.round(0.002 * sr));
    var tauRel = Math.max(1, 0.0015 * sr);

    for (var e = 0; e < starts.length; e++) {
      var start = starts[e];
      var dur = 0.006 + rng() * 0.004;
      var len = Math.max(4, Math.round(dur * sr));
      if (start + len >= n) continue;
      var attack = Math.max(1, Math.round(0.00035 * sr));
      var tau = 0.0025 + rng() * 0.002;
      var f1 = maxF * (0.55 + rng() * 0.18);
      var f2 = maxF * (0.72 + rng() * 0.15);
      var f3 = maxF * (0.86 + rng() * 0.12);
      var buf = new Float64Array(len);
      var mx = 0;
      for (var i = 0; i < len; i++) {
        var env = (i < attack ? i / attack : 1) * Math.exp(-i / (tau * sr));
        var v = (0.5 * Math.sin(2 * Math.PI * f1 * i / sr) +
          0.3 * Math.sin(2 * Math.PI * f2 * i / sr + 1.1) +
          0.2 * Math.sin(2 * Math.PI * f3 * i / sr + 2.3)) * env;
        buf[i] = v;
        var av = v < 0 ? -v : v;
        if (av > mx) mx = av;
      }
      var g = mx > 0 ? amp / mx : 0;
      for (var j = 0; j < len; j++) click[start + j] += buf[j] * g;
      for (var j2 = 0; j2 < len + release; j2++) {
        var idx = start + j2;
        if (idx >= n) break;
        var dd = j2 < len ? 1 : Math.exp(-(j2 - len) / tauRel);
        if (dd > duck[idx]) duck[idx] = dd;
      }
    }

    for (var i2 = 0; i2 < n; i2++) {
      var keep = 1 - duck[i2];
      var lv = click[i2];
      for (var c = 0; c < nch; c++) channels[c][i2] = channels[c][i2] * keep + lv;
    }
  }

  function hasAudibleSignal(channels) {
    for (var c = 0; c < channels.length; c++) {
      var x = channels[c];
      for (var i = 0; i < x.length; i++) {
        if (x[i] > 1e-7 || x[i] < -1e-7) return true;
      }
    }
    return false;
  }

  /* ======================================================================
   * 5. BS.1770-4 响度 + 4x 真峰值
   * ==================================================================== */

  function besselI0(x) {
    var sum = 1;
    var term = 1;
    var y = x * x / 4;
    for (var k = 1; k <= 40; k++) {
      term *= y / (k * k);
      sum += term;
      if (term < sum * 1e-14) break;
    }
    return sum;
  }

  function sinc(x) {
    if (Math.abs(x) < 1e-9) return 1;
    var px = Math.PI * x;
    return Math.sin(px) / px;
  }

  var TP_PHASES = null;

  /* 4x 过采样 48-tap Kaiser windowed-sinc（beta≈8），每相 12 taps，相位和归一化 */
  function getTruePeakPhases() {
    if (TP_PHASES) return TP_PHASES;
    var L = 6;
    var beta = 8;
    var denom = besselI0(beta);
    var phases = [];
    for (var p = 0; p < 4; p++) {
      var taps = new Float64Array(2 * L);
      var sum = 0;
      for (var k = -L + 1; k <= L; k++) {
        var d = p / 4 - k;
        var w = d / L;
        var win = (w <= -1 || w >= 1) ? 0 : besselI0(beta * Math.sqrt(1 - w * w)) / denom;
        var h = sinc(d) * win;
        taps[k + L - 1] = h;
        sum += h;
      }
      if (Math.abs(sum) > 1e-12) {
        for (var j = 0; j < taps.length; j++) taps[j] /= sum;
      }
      phases.push(taps);
    }
    TP_PHASES = phases;
    return phases;
  }

  /* K 加权系数：按实际 sampleRate 从 libebur128 公式推导（非硬编码 48k） */
  function kWeightCoeffs(sr) {
    var f0 = 1681.974450955533;
    var G = 3.999843853973347;
    var Q = 0.7071752369554196;
    var K = Math.tan(Math.PI * f0 / sr);
    var Vh = Math.pow(10, G / 20);
    var Vb = Math.pow(Vh, 0.4996667741545416);
    var a0 = 1 + K / Q + K * K;
    var s1 = {
      b0: (Vh + Vb * K / Q + K * K) / a0,
      b1: 2 * (K * K - Vh) / a0,
      b2: (Vh - Vb * K / Q + K * K) / a0,
      a1: 2 * (K * K - 1) / a0,
      a2: (1 - K / Q + K * K) / a0
    };
    f0 = 38.13547087602444;
    Q = 0.5003270373238773;
    K = Math.tan(Math.PI * f0 / sr);
    var a0h = 1 + K / Q + K * K;
    var s2 = {
      b0: 1,
      b1: -2,
      b2: 1,
      a1: 2 * (K * K - 1) / a0h,
      a2: (1 - K / Q + K * K) / a0h
    };
    return [s1, s2];
  }

  /*
   * 一次扫描同时得到：积分响度（400ms block / 100ms hop，双门限）、4x 真峰值、
   * sample peak、RMS。K 加权按声道独立状态，能量按声道求和（与 libebur128 一致）。
   */
  function analyzeAll(channels, sr) {
    var nch = channels.length;
    var n = channels[0].length;
    var hop = Math.max(1, Math.round(sr * 0.1));
    var shortDur = n < hop * 4;
    var numHops = Math.floor(n / hop);
    var hopEnergy = shortDur ? null : new Float64Array(Math.max(1, numHops));
    var hopIdx = 0;
    var hopCount = 0;
    var hopAcc = 0;

    var kw = kWeightCoeffs(sr);
    var s1 = kw[0];
    var s2 = kw[1];
    var x1a = new Float64Array(nch), x2a = new Float64Array(nch);
    var y1a = new Float64Array(nch), y2a = new Float64Array(nch);
    var x1b = new Float64Array(nch), x2b = new Float64Array(nch);
    var y1b = new Float64Array(nch), y2b = new Float64Array(nch);

    var peak = 0;
    var sumSq = 0;
    var tp = 0;
    var phases = getTruePeakPhases();
    var t1 = phases[1], t2 = phases[2], t3 = phases[3];

    for (var i = 0; i < n; i++) {
      var acc = 0;
      var fast = (i >= 5 && i < n - 6);
      for (var c = 0; c < nch; c++) {
        var x = channels[c];
        var xv = x[i];
        var av = xv < 0 ? -xv : xv;
        if (av > peak) peak = av;
        sumSq += xv * xv;

        /* 4x 真峰值插值 */
        var v1 = 0, v2 = 0, v3 = 0;
        if (fast) {
          var base = i - 5;
          for (var k = 0; k < 12; k++) {
            var sv = x[base + k];
            v1 += t1[k] * sv;
            v2 += t2[k] * sv;
            v3 += t3[k] * sv;
          }
        } else {
          for (var k2 = 0; k2 < 12; k2++) {
            var idx = i + k2 - 5;
            if (idx >= 0 && idx < n) {
              var sv2 = x[idx];
              v1 += t1[k2] * sv2;
              v2 += t2[k2] * sv2;
              v3 += t3[k2] * sv2;
            }
          }
        }
        if (v1 < 0) v1 = -v1;
        if (v2 < 0) v2 = -v2;
        if (v3 < 0) v3 = -v3;
        if (v1 > tp) tp = v1;
        if (v2 > tp) tp = v2;
        if (v3 > tp) tp = v3;

        /* K 加权两级 biquad */
        var p1 = x1a[c], p2 = x2a[c], q1 = y1a[c], q2 = y2a[c];
        var w1 = s1.b0 * xv + s1.b1 * p1 + s1.b2 * p2 - s1.a1 * q1 - s1.a2 * q2;
        x2a[c] = p1; x1a[c] = xv; y2a[c] = q1; y1a[c] = w1;
        var r1 = x1b[c], r2 = x2b[c], u1 = y1b[c], u2 = y2b[c];
        var w2 = s2.b0 * w1 + s2.b1 * r1 + s2.b2 * r2 - s2.a1 * u1 - s2.a2 * u2;
        x2b[c] = r1; x1b[c] = w1; y2b[c] = u1; y1b[c] = w2;
        acc += w2 * w2;
      }

      if (shortDur) {
        hopAcc += acc;
      } else {
        hopAcc += acc;
        hopCount++;
        if (hopCount === hop) {
          if (hopIdx < hopEnergy.length) hopEnergy[hopIdx++] = hopAcc;
          hopAcc = 0;
          hopCount = 0;
        }
      }
    }

    /* 每 100ms hop 的能量 -> 400ms block 能量 */
    var blocks = [];
    if (shortDur) {
      if (hopAcc > 0 && n > 0) blocks.push(hopAcc / n);
    } else {
      var bc = numHops - 3;
      for (var j = 0; j < bc; j++) {
        var msum = hopEnergy[j] + hopEnergy[j + 1] + hopEnergy[j + 2] + hopEnergy[j + 3];
        blocks.push(msum / (hop * 4));
      }
    }

    /* 绝对门限 -70 LUFS + 相对门限 -10 LU */
    var gatedMs = [];
    var gatedL = [];
    for (var b = 0; b < blocks.length; b++) {
      var ms = blocks[b];
      if (ms > 0) {
        var l = -0.691 + 10 * Math.log10(ms);
        if (l > -70) {
          gatedMs.push(ms);
          gatedL.push(l);
        }
      }
    }
    var lufs = -70;
    if (gatedMs.length > 0) {
      var sumMs = 0;
      for (var g = 0; g < gatedMs.length; g++) sumMs += gatedMs[g];
      var meanMs = sumMs / gatedMs.length;
      var rel = -0.691 + 10 * Math.log10(meanMs) - 10;
      var finalSum = 0;
      var finalCount = 0;
      for (var g2 = 0; g2 < gatedMs.length; g2++) {
        if (gatedL[g2] > rel) {
          finalSum += gatedMs[g2];
          finalCount++;
        }
      }
      if (finalCount > 0) {
        lufs = -0.691 + 10 * Math.log10(finalSum / finalCount);
      }
    }

    return {
      lufs: lufs,
      truePeak: tp * TP_SAFETY_LIN,
      peak: peak,
      rms: Math.sqrt(sumSq / (n * nch))
    };
  }

  /* 4x 真峰值包络：每个基础采样点取 4 个过采样相位的最大绝对值（跨声道） */
  function truePeakEnvelope(channels) {
    var nch = channels.length;
    var n = channels[0].length;
    var env = new Float64Array(n);
    var phases = getTruePeakPhases();
    var t1 = phases[1], t2 = phases[2], t3 = phases[3];
    for (var c = 0; c < nch; c++) {
      var x = channels[c];
      for (var i = 0; i < n; i++) {
        var m = x[i] < 0 ? -x[i] : x[i];
        var v1 = 0, v2 = 0, v3 = 0;
        if (i >= 5 && i < n - 6) {
          var base = i - 5;
          for (var k = 0; k < 12; k++) {
            var sv = x[base + k];
            v1 += t1[k] * sv;
            v2 += t2[k] * sv;
            v3 += t3[k] * sv;
          }
        } else {
          for (var k2 = 0; k2 < 12; k2++) {
            var idx = i + k2 - 5;
            if (idx >= 0 && idx < n) {
              var sv2 = x[idx];
              v1 += t1[k2] * sv2;
              v2 += t2[k2] * sv2;
              v3 += t3[k2] * sv2;
            }
          }
        }
        if (v1 < 0) v1 = -v1;
        if (v2 < 0) v2 = -v2;
        if (v3 < 0) v3 = -v3;
        if (v1 > m) m = v1;
        if (v2 > m) m = v2;
        if (v3 > m) m = v3;
        if (m > env[i]) env[i] = m;
      }
    }
    return env;
  }

  /* 单调队列滑窗最小 */
  function slidingMin(arr, W) {
    var n = arr.length;
    var out = new Float64Array(n);
    var dq = new Int32Array(n);
    var head = 0;
    var tail = 0;
    for (var i = 0; i < n; i++) {
      while (head < tail && dq[head] <= i - W) head++;
      while (tail > head && arr[dq[tail - 1]] >= arr[i]) tail--;
      dq[tail++] = i;
      out[i] = arr[dq[head]];
    }
    return out;
  }

  /*
   * lookahead 真峰值限幅：4x 真峰值检测 -> 未来 5ms 滑窗最小 -> 1ms attack / 80ms release
   * 平滑增益包络 -> sample clamp 兜底。
   */
  function limitToCeiling(channels, sr, ceilingLin) {
    var nch = channels.length;
    var n = channels[0].length;
    if (n < 1) return;
    var env = truePeakEnvelope(channels);
    var req = new Float64Array(n);
    for (var i = 0; i < n; i++) {
      var e = env[i];
      req[i] = e > ceilingLin ? ceilingLin / e : 1;
    }
    var look = Math.max(1, Math.round(0.005 * sr));
    var revReq = new Float64Array(n);
    for (var j = 0; j < n; j++) revReq[j] = req[n - 1 - j];
    var revMin = slidingMin(revReq, look + 1);
    var target = new Float64Array(n);
    for (var j2 = 0; j2 < n; j2++) target[n - 1 - j2] = revMin[j2];

    var att = Math.exp(-1 / Math.max(1, 0.001 * sr));
    var rel = Math.exp(-1 / Math.max(1, 0.080 * sr));
    var g = 1;
    for (var i2 = 0; i2 < n; i2++) {
      var t = target[i2];
      if (t < g) g = att * g + (1 - att) * t;
      else g = rel * g + (1 - rel) * t;
      for (var c = 0; c < nch; c++) {
        var v = channels[c][i2] * g;
        if (v > ceilingLin) v = ceilingLin;
        else if (v < -ceilingLin) v = -ceilingLin;
        channels[c][i2] = v;
      }
    }
  }

  /* ======================================================================
   * 6. 响度归一化 + 峰值兜底（最多 3 次迭代）
   * ==================================================================== */

  function normalizeToTarget(channels, sr, targetLufs, ceilingDb, clipFactor) {
    var ceilingLin = dbToGain(ceilingDb);
    var limiterCeil = dbToGain(ceilingDb - 0.1);
    /* 真峰值削波阈值：低于 ceiling 留出重建余量，硬削波同时降低 crest */
    var clipLin = ceilingLin * (isNum(clipFactor) ? clipFactor : 0.66);
    var a = analyzeAll(channels, sr);
    if (!(a.lufs > -69.9)) return; /* 静音/不可测：保持原样 */

    for (var iter = 0; iter < 3; iter++) {
      var err = targetLufs - a.lufs;
      var tpSafe = a.truePeak <= limiterCeil;
      if (Math.abs(err) < 0.05 && tpSafe) break;
      if (Math.abs(err) >= 0.02) {
        var g = clamp(err, -40, 40);
        applyGainDb(channels, g);
      }
      /* 硬限幅：把 base sample 压到 clipLin，重建真峰值仍低于 ceiling */
      hardClipInPlace(channels, clipLin);
      a = analyzeAll(channels, sr);
      /* 极端情况下重建峰值仍越过 ceiling 的离线安全垫：lookahead limiter */
      if (a.truePeak > ceilingLin) {
        limitToCeiling(channels, sr, limiterCeil);
        a = analyzeAll(channels, sr);
      }
    }

    /* 最终兜底：确保真峰值不超过 ceiling，宁肯略低也不超限 */
    if (a.truePeak > dbToGain(ceilingDb - 0.02)) {
      var tpDb = gainToDb(a.truePeak);
      var need = ceilingDb - 0.05 - tpDb;
      if (need < 0) applyGainDb(channels, need);
    }
  }

  /* ======================================================================
   * 7. preset 元数据（字段严格按契约 4.2）
   * ==================================================================== */

  var PRESETS = [
    {
      id: 'normal',
      name: '普通炸麦版',
      en: 'NORMAL BLAST',
      tagline: '话筒过载 · 原味炸',
      desc: '话筒前级直接过载，低频厚实、中频发糙，还能听出原曲轮廓，适合第一次试炸。',
      color: '#ffd400',
      accent: '#ff8a00',
      level: 1,
      targetLufs: -8.0,
      ceilingDb: -0.8,
      params: {
        driveDb: 15,
        clipThreshold: 0.32,
        lowBoostDb: 9,
        highBoostDb: 8,
        crushBits: 16,
        sampleHold: 1,
        firecrackerDensity: 0
      },
      chain: ['HPF 25Hz', '+9dB@70Hz', '硬削波 0.32', '+8dB@3.2k', '快压缩']
    },
    {
      id: 'super',
      name: '超级炸麦版',
      en: 'SUPER BLAST',
      tagline: '低频轰鸣 · 再狠一档',
      desc: '低频下潜更深，硬削波带出颗粒，3.2kHz 开始发刺，动态被压掉一层。',
      color: '#ff8c1a',
      accent: '#ff4d00',
      level: 2,
      targetLufs: -6.0,
      ceilingDb: -0.6,
      params: {
        driveDb: 18,
        clipThreshold: 0.25,
        lowBoostDb: 10,
        highBoostDb: 10,
        crushBits: 16,
        sampleHold: 1,
        firecrackerDensity: 0
      },
      chain: ['HPF 28Hz', '+10dB@60Hz', 'tanh 饱和', '硬削波 0.25', '+10dB@3.2k', '8:1 压缩']
    },
    {
      id: 'promax',
      name: 'Pro Max 炸麦版',
      en: 'PRO MAX BLAST',
      tagline: '削波颗粒 · 全面压扁',
      desc: '多段削波叠 10bit 量化，颗粒粗粝，高低两头一起顶，响度再上一档。',
      color: '#ff4d6d',
      accent: '#ff0055',
      level: 3,
      targetLufs: -4.5,
      ceilingDb: -0.4,
      params: {
        driveDb: 21,
        clipThreshold: 0.18,
        lowBoostDb: 11,
        highBoostDb: 12,
        crushBits: 10,
        sampleHold: 1,
        firecrackerDensity: 0
      },
      chain: ['HPF 30Hz', '+11dB@80Hz', '硬削波 0.18', '10bit 粉碎', '+12dB@3.2k', '12:1 压缩']
    },
    {
      id: 'firecracker',
      name: '极致纯响鞭炮炸麦版',
      en: 'FIRECRACKER BLAST',
      tagline: '纯响鞭炮 · 炸穿音箱',
      desc: '鞭炮层在音箱里炸开，爆炸泵抽气，6bit 颗粒加 3.2kHz 尖刺，极限响度。',
      color: '#ff2020',
      accent: '#ffe600',
      level: 4,
      targetLufs: -3.5,
      ceilingDb: -0.2,
      params: {
        driveDb: 26,
        clipThreshold: 0.12,
        lowBoostDb: 12,
        highBoostDb: 15,
        crushBits: 6,
        sampleHold: 2,
        firecrackerDensity: 8
      },
      chain: ['HPF 32Hz', '+12dB@90Hz', '硬削波 0.12', '6bit + 降采样', '+15dB@3.2k', '16:1 压缩', '鞭炮瞬态层']
    }
  ];

  function getPreset(id) {
    var key = String(id);
    for (var i = 0; i < PRESETS.length; i++) {
      if (PRESETS[i].id === key) return PRESETS[i];
    }
    throw new Error('未知的预设 ID: ' + key);
  }

  /* ======================================================================
   * 8. 四档处理链
   * ==================================================================== */

  var COMP_SETTINGS = {
    normal: { thresholdDb: -16, ratio: 6, attackMs: 1, releaseMs: 50, kneeDb: 6, makeupDb: 3 },
    super: { thresholdDb: -18, ratio: 8, attackMs: 0.5, releaseMs: 40, kneeDb: 6, makeupDb: 4 },
    promax: { thresholdDb: -20, ratio: 12, attackMs: 0.3, releaseMs: 30, kneeDb: 6, makeupDb: 5 },
    firecracker: { thresholdDb: -22, ratio: 16, attackMs: 0.2, releaseMs: 25, kneeDb: 6, makeupDb: 6 }
  };

  function processChain(channels, sr, presetId, applied) {
    var hp = { normal: 25, super: 28, promax: 30, firecracker: 32 }[presetId];
    filterAll(channels, 'highpass', sr, hp, 0, 0.7071067811865476);

    var low = applied.lowBoostDb;
    if (presetId === 'normal') {
      filterAll(channels, 'peaking', sr, 70, low, 1.0);
      filterAll(channels, 'peaking', sr, 200, low * (4 / 9), 1.5);
    } else if (presetId === 'super') {
      filterAll(channels, 'peaking', sr, 60, low, 0.9);
      filterAll(channels, 'peaking', sr, 180, low * 0.5, 1.4);
    } else if (presetId === 'promax') {
      filterAll(channels, 'lowshelf', sr, 80, low, 0.7071067811865476);
      filterAll(channels, 'peaking', sr, 200, low * (6 / 11), 1.2);
    } else {
      filterAll(channels, 'lowshelf', sr, 90, low, 0.7071067811865476);
      filterAll(channels, 'peaking', sr, 220, low * (7 / 12), 1.2);
    }

    applyGainDb(channels, applied.driveDb);
    hardClip2x(channels, applied.clipThreshold);

    if (presetId === 'super') {
      saturate(channels, 1.8, 0.5);
    } else if (presetId === 'promax') {
      saturate(channels, 3.5, 0.7);
      hardClip2x(channels, clamp(applied.clipThreshold * (0.35 / 0.18), 0.02, 0.99));
    } else if (presetId === 'firecracker') {
      saturate(channels, 6.0, 0.85);
      hardClip2x(channels, clamp(applied.clipThreshold * (0.4 / 0.12), 0.02, 0.99));
    }

    if (applied.crushBits < 16 || applied.sampleHold > 1) {
      bitCrush(channels, applied.crushBits, applied.sampleHold);
    }

    var midGain = { normal: 3, super: 3.5, promax: 4, firecracker: 5 }[presetId];
    var midQ = { normal: 1.5, super: 1.4, promax: 1.2, firecracker: 1.4 }[presetId];
    filterAll(channels, 'peaking', sr, 1000, midGain, midQ);

    var highQ = { normal: 2.5, super: 2.6, promax: 2.8, firecracker: 3.0 }[presetId];
    filterAll(channels, 'peaking', sr, 3200, applied.highBoostDb, highQ);

    if (presetId === 'super') {
      filterAll(channels, 'highshelf', sr, 9000, 2, 0.7071067811865476);
    } else if (presetId === 'promax') {
      filterAll(channels, 'highshelf', sr, 10000, 4, 0.7071067811865476);
    } else if (presetId === 'firecracker') {
      filterAll(channels, 'highshelf', sr, 12000, 5, 0.7071067811865476);
    }

    var comp = COMP_SETTINGS[presetId];
    compress(channels, sr, comp.thresholdDb, comp.ratio,
      comp.attackMs, comp.releaseMs, comp.kneeDb, comp.makeupDb);

    if (presetId === 'firecracker') {
      addFirecrackerLayer(channels, sr, applied.firecrackerDensity);
    }
  }

  /* ======================================================================
   * 9. overrides 解析（越界 clamp，未知键忽略）
   * ==================================================================== */

  var PARAM_RANGES = {
    driveDb: [-6, 36],
    clipThreshold: [0.02, 0.99],
    lowBoostDb: [-6, 30],
    highBoostDb: [-6, 30],
    crushBits: [2, 16],
    sampleHold: [1, 8],
    firecrackerDensity: [0, 20]
  };

  function resolveApplied(preset, overrides) {
    var p = preset.params;
    var applied = {
      driveDb: p.driveDb,
      clipThreshold: p.clipThreshold,
      lowBoostDb: p.lowBoostDb,
      highBoostDb: p.highBoostDb,
      crushBits: p.crushBits,
      sampleHold: p.sampleHold,
      firecrackerDensity: p.firecrackerDensity
    };
    if (overrides && typeof overrides === 'object') {
      for (var key in PARAM_RANGES) {
        if (!Object.prototype.hasOwnProperty.call(PARAM_RANGES, key)) continue;
        var raw = overrides[key];
        if (raw === undefined || raw === null) continue;
        var v = Number(raw);
        if (!isFinite(v)) continue;
        var range = PARAM_RANGES[key];
        v = clamp(v, range[0], range[1]);
        if (key === 'crushBits' || key === 'sampleHold') v = Math.round(v);
        applied[key] = v;
      }
    }
    return applied;
  }

  /* ======================================================================
   * 10. 统计与公开 API
   * ==================================================================== */

  function buildStats(channels, sr, startedAt) {
    var a = analyzeAll(channels, sr);
    var peakDb = a.peak > 1e-12 ? gainToDb(a.peak) : -120;
    var rmsDb = a.rms > 1e-12 ? gainToDb(a.rms) : -120;
    var tpDb = a.truePeak > 1e-12 ? gainToDb(a.truePeak) : -120;
    var lufs = a.lufs;
    if (!isFinite(lufs)) lufs = -70;
    var crest = (a.peak > 1e-12 && a.rms > 1e-12) ? (peakDb - rmsDb) : 0;
    return {
      lufs: lufs,
      truePeakDb: tpDb,
      peakDb: peakDb,
      rmsDb: rmsDb,
      crestDb: crest,
      durationSec: channels[0].length / sr,
      processingMs: startedAt != null ? Math.max(0, nowMs() - startedAt) : 0
    };
  }

  function process(channels, sampleRate, presetId, overrides) {
    var started = nowMs();
    var input = validateAndCopy(channels, sampleRate);
    var preset = getPreset(presetId);
    var applied = resolveApplied(preset, overrides);
    /* stats.applied 按契约 4.3 同时暴露目标响度与真峰值上限 */
    applied.targetLufs = preset.targetLufs;
    applied.ceilingDb = preset.ceilingDb;
    var sr = input.sampleRate;
    var work = input.channels;

    processChain(work, sr, preset.id, applied);
    normalizeToTarget(work, sr, preset.targetLufs, preset.ceilingDb,
      preset.id === 'firecracker' ? 0.64 : 0.66);
    if (preset.id === 'firecracker' && applied.firecrackerDensity > 0 && hasAudibleSignal(work)) {
      addFirecrackerPost(work, sr, applied.firecrackerDensity, dbToGain(preset.ceilingDb));
      /* 鞭炮瞬态层会带来新的峰值与 duck 损失，必须在 post 之后再归一化一次：
         - 目标先抬 0.2dB，抵消瞬态层替换音乐造成的响度损失；
         - clipFactor 用 0.7，比主归一化更温和，保留 5–12k 瞬态形状；
         - normalizeToTarget 内部仍做真峰值兜底，保证 TP 不越 ceiling。 */
      normalizeToTarget(work, sr, preset.targetLufs + 0.2, preset.ceilingDb, 0.7);
    }

    var out = [];
    for (var c = 0; c < work.length; c++) out.push(toFloat32(work[c]));

    var stats = buildStats(out, sr, started);
    stats.applied = applied;
    return {
      channels: out,
      sampleRate: sr,
      presetId: preset.id,
      stats: stats
    };
  }

  function measure(channels, sampleRate) {
    var started = nowMs();
    var input = validateAndCopy(channels, sampleRate);
    return buildStats(input.channels, input.sampleRate, started);
  }

  return {
    version: VERSION,
    PRESETS: PRESETS,
    getPreset: getPreset,
    process: process,
    measure: measure
  };
});
