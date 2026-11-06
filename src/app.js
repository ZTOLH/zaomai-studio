/*!
 * ZAOMAI LAB - UI controller
 * Pure classic script. No modules, no network, no uploads.
 */
(function () {
  'use strict';

  var VERSION = '1.0.0';

  var FALLBACK_PRESETS = [
    {
      id: 'normal', name: '普通炸麦版', en: 'NORMAL BLAST', tagline: '话筒过载 · 原味炸',
      desc: '复刻 zaomai 配方：低频轰鸣、硬削波颗粒、3kHz 发刺。保留最多动态。',
      color: '#ffd400', accent: '#ff8a00', level: 1, targetLufs: -8.0, ceilingDb: -0.8,
      params: { driveDb: 15, clipThreshold: 0.32, lowBoostDb: 9, highBoostDb: 8, crushBits: 16, sampleHold: 1, firecrackerDensity: 0 },
      chain: ['HPF 25Hz', '+9dB@70Hz', '+15dB 推子', '硬削波 0.32', '+8dB@3.2k', '6:1 压缩', '限幅 -0.8']
    },
    {
      id: 'super', name: '超级炸麦版', en: 'SUPER BLAST', tagline: '更硬 · 更宽 · 更不讲理',
      desc: '更深的过载、更硬的削波、9kHz 空气感。动态再让出 1 LU。',
      color: '#ff8a00', accent: '#ff4d00', level: 2, targetLufs: -6.0, ceilingDb: -0.6,
      params: { driveDb: 18, clipThreshold: 0.25, lowBoostDb: 10, highBoostDb: 10, crushBits: 16, sampleHold: 1, firecrackerDensity: 0 },
      chain: ['HPF 28Hz', '+10dB@60Hz', '+18dB 推子', '硬削波 0.25', 'tanh 1.8', '8:1 压缩', '限幅 -0.6']
    },
    {
      id: 'promax', name: 'Pro Max 炸麦版', en: 'PRO MAX BLAST', tagline: '短视频外放特化',
      desc: '21dB 推子、10bit 量化、双重削波。为手机外放和短视频而生。',
      color: '#ff3b30', accent: '#ff1e00', level: 3, targetLufs: -4.5, ceilingDb: -0.4,
      params: { driveDb: 21, clipThreshold: 0.18, lowBoostDb: 11, highBoostDb: 12, crushBits: 10, sampleHold: 1, firecrackerDensity: 0 },
      chain: ['HPF 30Hz', '+11dB@80Hz', '+21dB 推子', '硬削波 0.18', 'tanh 3.5', '10bit 碎化', '12:1 压缩', '限幅 -0.4']
    },
    {
      id: 'firecracker', name: '极致纯响鞭炮炸麦版', en: 'FIRECRACKER BLAST', tagline: '最响 · 最碎 · 最失控',
      desc: '26dB 推子、6bit 碎化、合成鞭炮层。最响、最碎、最不讲理。',
      color: '#ffe500', accent: '#ff2d00', level: 4, targetLufs: -3.5, ceilingDb: -0.2,
      params: { driveDb: 26, clipThreshold: 0.12, lowBoostDb: 12, highBoostDb: 15, crushBits: 6, sampleHold: 2, firecrackerDensity: 8 },
      chain: ['HPF 32Hz', '+12dB@90Hz', '+26dB 推子', '硬削波 0.12', '6bit + hold2', '鞭炮层', '16:1 压缩', '限幅 -0.2']
    }
  ];

  var FALLBACK_FORMATS = [
    { id: 'wav16', label: 'WAV 16-bit', ext: 'wav', mime: 'audio/wav', kind: 'wav', options: [], note: '通用无损 · 16-bit PCM' },
    { id: 'wav24', label: 'WAV 24-bit', ext: 'wav', mime: 'audio/wav', kind: 'wav', options: [], note: '高精度无损 · 24-bit PCM' },
    { id: 'wav32f', label: 'WAV 32-bit Float', ext: 'wav', mime: 'audio/wav', kind: 'wav', options: [], note: '继续后期 · IEEE float' },
    { id: 'mp3', label: 'MP3', ext: 'mp3', mime: 'audio/mpeg', kind: 'mp3', options: [{ key: 'bitrate', values: [128, 192, 320], default: 192 }], note: '兼容性最好 · 有损' },
    { id: 'flac', label: 'FLAC 16-bit', ext: 'flac', mime: 'audio/flac', kind: 'flac', options: [], note: '无损压缩 · 逐样本还原' },
    { id: 'ogg', label: 'OGG Opus', ext: 'ogg', mime: 'audio/ogg', kind: 'ogg', options: [{ key: 'bitrate', values: [96, 128, 192], default: 128 }], note: '流媒体友好 · 需 Opus 编码器' },
    { id: 'aiff', label: 'AIFF 16-bit', ext: 'aiff', mime: 'audio/aiff', kind: 'aiff', options: [], note: 'macOS / 视频剪辑' }
  ];

  var state = {
    source: null,
    sourceToken: 0,
    presetId: 'normal',
    processed: null,
    processedBuffer: null,
    originalBuffer: null,
    peaks: { original: null, processed: null },
    cache: new Map(),
    processing: false,
    exporting: false,
    formatId: 'wav16',
    ctx: null,
    master: null,
    sourceNode: null,
    playing: false,
    offset: 0,
    startedAt: 0,
    playToken: 0,
    raf: 0,
    abOriginal: false,
    volume: 0.32,
    safetyAccepted: false,
    pendingSafety: null,
    originalStats: null,
    demoId: null,
    loadingDemo: false,
    loadingFile: false,
    demoCache: new Map(),
    seekDragging: false,
    volumeWarned: false,
    progressTimer: null,
    lastExportName: '',
    autoTestMode: null
  };

  var el = {};

  function $(id) { return document.getElementById(id); }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function tick(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms || 16); }); }
  function nextFrame() {
    return new Promise(function (resolve) {
      if (window.requestAnimationFrame) requestAnimationFrame(function () { resolve(); });
      else setTimeout(resolve, 16);
    });
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function formatTime(sec) {
    if (!isFinite(sec) || sec < 0) return '--:--';
    var total = Math.floor(sec + 0.0001);
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return h > 0 ? h + ':' + p(m) + ':' + p(s) : p(m) + ':' + p(s);
  }
  function sanitizeBase(name) {
    var out = String(name || '').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
    out = out.replace(/\.[A-Za-z0-9]{1,5}$/, '').trim();
    if (!out) out = '我的炸麦';
    return out.slice(0, 48);
  }
  function baseFromName(name) {
    return sanitizeBase(String(name || '').replace(/\.[^.]+$/, ''));
  }
  function formatBytes(n) {
    if (!n) return '0 B';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }
  function dbText(v, digits) {
    if (v == null || !isFinite(v)) return '—';
    return Number(v).toFixed(digits == null ? 2 : digits);
  }

  /* ------------------------------------------------------------------ */
  /* boot / support                                                     */
  /* ------------------------------------------------------------------ */

  function getDSP() { return window.ZaomaiDSP || null; }
  function getExport() { return window.ZaomaiExport || null; }
  function getDemo() { return window.ZaomaiDemo || null; }

  function getPresets() {
    var dsp = getDSP();
    if (dsp && Array.isArray(dsp.PRESETS) && dsp.PRESETS.length === 4) return dsp.PRESETS;
    return FALLBACK_PRESETS;
  }

  function getPreset(id) {
    var list = getPresets();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return list[0];
  }

  function getFormats() {
    var ex = getExport();
    if (ex && Array.isArray(ex.FORMATS) && ex.FORMATS.length) return ex.FORMATS;
    return FALLBACK_FORMATS;
  }

  function getFormat(id) {
    var list = getFormats();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return list[0];
  }

  function formatSupported(id) {
    var ex = getExport();
    if (!ex || typeof ex.isSupported !== 'function') return false;
    try { return !!ex.isSupported(id); } catch (e) { return false; }
  }

  function ensureCtx() {
    if (!state.ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error('当前浏览器不支持 Web Audio，无法试听或解码音频。');
      state.ctx = new AC({ latencyHint: 'interactive' });
      state.master = state.ctx.createGain();
      state.master.gain.value = state.volume;
      state.master.connect(state.ctx.destination);
    }
    return state.ctx;
  }

  async function resumeCtx() {
    var ctx = ensureCtx();
    if (ctx.state === 'suspended') {
      try { await ctx.resume(); } catch (e) { /* user gesture may still be required */ }
    }
    return ctx;
  }

  /* ------------------------------------------------------------------ */
  /* toast / progress                                                   */
  /* ------------------------------------------------------------------ */

  function toast(message, isError) {
    if (!el.toast) return;
    el.toast.textContent = String(message);
    el.toast.classList.toggle('is-error', !!isError);
    el.toast.classList.add('is-visible');
    clearTimeout(el.toast._timer);
    el.toast._timer = setTimeout(function () {
      el.toast.classList.remove('is-visible');
    }, isError ? 5200 : 3600);
  }

  function showProgress(label, ratio, sub) {
    if (!el.progress) return;
    el.progress.hidden = false;
    setProgress(ratio, label, sub);
  }
  function setProgress(ratio, label, sub) {
    if (!el.progress) return;
    var p = clamp(ratio || 0, 0, 1);
    if (label != null) el.progressLabel.textContent = label;
    if (sub != null) el.progressSub.textContent = sub;
    el.progressBar.style.width = (p * 100).toFixed(1) + '%';
    el.progressPct.textContent = Math.round(p * 100) + '%';
  }
  function hideProgress(delay) {
    clearTimeout(state.progressTimer);
    state.progressTimer = setTimeout(function () { if (el.progress) el.progress.hidden = true; }, delay == null ? 900 : delay);
  }

  /* ------------------------------------------------------------------ */
  /* rendering: presets / demos / formats / levels                      */
  /* ------------------------------------------------------------------ */

  function renderPresets() {
    if (!el.presetGrid) return;
    var list = getPresets();
    var html = '';
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      var accent = p.color || p.accent || '#ff4d00';
      html += '<button type="button" class="preset-card" role="radio" aria-checked="false" data-preset="' + esc(p.id) + '" style="--accent:' + esc(accent) + '" title="' + esc(p.desc || '') + '">' +
        '<span class="preset-topline"><span class="preset-level">LV.' + esc(p.level) + '</span><span class="preset-tag">' + esc(p.tagline || '') + '</span></span>' +
        '<span class="preset-name">' + esc(p.name) + '</span>' +
        '<span class="preset-en">' + esc(p.en || '') + '</span>' +
        '<span class="preset-target">' + Number(p.targetLufs).toFixed(1) + '<small>LUFS</small></span>' +
        '<span class="preset-desc">' + esc(p.desc || '') + '</span>' +
        '<span class="preset-meter" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>' +
        '</button>';
    }
    el.presetGrid.innerHTML = html;
    var cards = el.presetGrid.querySelectorAll('.preset-card');
    for (var k = 0; k < cards.length; k++) {
      cards[k].addEventListener('click', function () {
        selectPreset(this.getAttribute('data-preset'));
      });
      cards[k].addEventListener('keydown', function (ev) {
        if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
        ev.preventDefault();
        var ids = getPresets().map(function (p) { return p.id; });
        var idx = ids.indexOf(state.presetId);
        var next = ev.key === 'ArrowRight' ? (idx + 1) % ids.length : (idx - 1 + ids.length) % ids.length;
        selectPreset(ids[next]);
        var target = el.presetGrid.querySelector('[data-preset="' + ids[next] + '"]');
        if (target) target.focus();
      });
    }
    syncPresetCards();
  }

  function syncPresetCards() {
    if (!el.presetGrid) return;
    var cards = el.presetGrid.querySelectorAll('.preset-card');
    for (var i = 0; i < cards.length; i++) {
      var on = cards[i].getAttribute('data-preset') === state.presetId;
      cards[i].classList.toggle('is-active', on);
      cards[i].setAttribute('aria-checked', on ? 'true' : 'false');
      cards[i].tabIndex = on ? 0 : -1;
    }
    var p = getPreset(state.presetId);
    if (el.chipLevel) el.chipLevel.textContent = 'LV.' + p.level;
  }

  function renderDemos() {
    if (!el.demoList) return;
    var demo = getDemo();
    if (!demo || typeof demo.list !== 'function') {
      el.demoList.innerHTML = '<p class="mini-unavailable">示例曲模块未加载。</p>';
      return;
    }
    var list = [];
    try { list = demo.list() || []; } catch (e) { list = []; }
    if (!list.length) {
      el.demoList.innerHTML = '<p class="mini-unavailable">暂无内置示例。</p>';
      return;
    }
    var html = '';
    for (var i = 0; i < list.length; i++) {
      var d = list[i];
      var dur = d.bars && d.bpm ? (d.bars * 4 * 60 / d.bpm) : 0;
      html += '<button type="button" class="demo-card" data-demo-id="' + esc(d.id) + '"' + (state.demoId === d.id ? ' aria-current="true"' : '') + '>' +
        '<span class="demo-play" aria-hidden="true">▶</span>' +
        '<span class="demo-main"><strong>' + esc(d.name) + '</strong><small>' + esc(d.tag || d.en || '') + '</small></span>' +
        '<span class="demo-meta">' + esc(d.bpm) + ' BPM<br>' + (dur ? dur.toFixed(1) + 's' : '') + '</span>' +
        '</button>';
    }
    el.demoList.innerHTML = html;
    var cards = el.demoList.querySelectorAll('.demo-card');
    for (var k = 0; k < cards.length; k++) {
      cards[k].addEventListener('click', function () {
        loadDemo(this.getAttribute('data-demo-id'));
      });
    }
  }

  function renderFormats() {
    if (!el.formatGrid) return;
    var list = getFormats();
    var supported = [];
    for (var i = 0; i < list.length; i++) if (formatSupported(list[i].id)) supported.push(list[i].id);
    if (supported.length && supported.indexOf(state.formatId) < 0) state.formatId = supported[0];
    if (!supported.length) state.formatId = list.length ? list[0].id : null;
    var html = '';
    for (var j = 0; j < list.length; j++) {
      var f = list[j];
      var ok = formatSupported(f.id);
      var active = f.id === state.formatId;
      html += '<button type="button" class="format-card' + (active ? ' is-active' : '') + (ok ? '' : ' is-unsupported') + '" data-format="' + esc(f.id) + '" role="radio" aria-checked="' + (active ? 'true' : 'false') + '"' + (ok ? '' : ' disabled') + ' title="' + esc(f.note || '') + '">' +
        '<span class="format-ext">' + esc((f.ext || '').toUpperCase()) + '</span>' +
        '<span class="format-name">' + esc(f.label) + '</span>' +
        '<span class="format-note">' + esc(f.note || '') + '</span>' +
        '<span class="format-check" aria-hidden="true">✓</span>' +
        '</button>';
    }
    el.formatGrid.innerHTML = html;
    var cards = el.formatGrid.querySelectorAll('.format-card');
    for (var k = 0; k < cards.length; k++) {
      cards[k].addEventListener('click', function () {
        if (this.disabled) return;
        selectFormat(this.getAttribute('data-format'));
      });
    }
    updateExportHint();
  }

  function renderLevels() {
    if (!el.levelMatrix) return;
    var list = getPresets();
    var html = '';
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      var accent = p.color || p.accent || '#ff4d00';
      var scale = '';
      for (var s = 0; s < 14; s++) scale += '<i></i>';
      html += '<article class="level-row" data-level-preset="' + esc(p.id) + '" style="--accent:' + esc(accent) + '" tabindex="0" role="button" aria-label="选择 ' + esc(p.name) + '">' +
        '<div class="level-big">0' + (i + 1) + '</div>' +
        '<div class="level-name"><h3>' + esc(p.name) + '</h3><span>' + esc(p.en) + '</span></div>' +
        '<div class="level-target"><b>' + Number(p.targetLufs).toFixed(1) + '</b><span>LUFS · 天花板 ' + Number(p.ceilingDb).toFixed(1) + '</span></div>' +
        '<div class="level-desc">' + esc(p.desc) + '</div>' +
        '<div class="level-scale" aria-hidden="true">' + scale + '</div>' +
        '</article>';
    }
    el.levelMatrix.innerHTML = html;
    var rows = el.levelMatrix.querySelectorAll('.level-row');
    for (var k = 0; k < rows.length; k++) {
      rows[k].addEventListener('click', function () {
        selectPreset(this.getAttribute('data-level-preset'));
        var consoleEl = $('console');
        if (consoleEl) consoleEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      rows[k].addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          this.click();
        }
      });
    }
  }

  /* ------------------------------------------------------------------ */
  /* preset selection                                                   */
  /* ------------------------------------------------------------------ */

  function selectPreset(id, opts) {
    if (!id) return;
    if (state.processing && !(opts && opts.force)) {
      toast('正在渲染，等这一档炸完再切。');
      return;
    }
    var p = getPreset(id);
    if (!p) return;
    if (state.presetId === id && state.processed && !(opts && opts.forceView)) return;
    state.presetId = id;
    syncPresetCards();
    stopPlayback(true);
    state.abOriginal = false;
    state.offset = 0;
    clearProcessedView();
    var cached = state.cache.get(id);
    if (cached) applyProcessed(cached, { silent: true, keepOffset: true });
    else {
      resetStats();
      updateHint();
      updateWaveInfo();
      drawWave();
      updateControls();
    }
    updateExportHint();
  }

  function clearProcessedView() {
    state.processed = null;
    state.processedBuffer = null;
    state.peaks.processed = null;
    state.offset = 0;
    resetStats();
    updatePlayUI();
  }

  /* ------------------------------------------------------------------ */
  /* source loading                                                     */
  /* ------------------------------------------------------------------ */

  async function handleFile(file) {
    if (!file || state.loadingFile) return;
    if (!isAudioFile(file)) { toast('这不是音频文件。请选择 MP3 / WAV / FLAC / OGG / M4A 等格式。', true); return; }
    if (file.size > 300 * 1024 * 1024) { toast('文件超过 300 MB，浏览器可能吃不消。请先压缩或剪短。', true); return; }
    state.loadingFile = true;
    if (el.dropzone) el.dropzone.classList.add('is-busy');
    setSourceStatus('解码中…', true);
    try {
      var ctx = ensureCtx();
      var array = await file.arrayBuffer();
      var audio = await decodeAudio(ctx, array);
      if (!audio || !audio.length) throw new Error('解码结果为空。');
      if (audio.duration > 600) throw new Error('音频超过 10 分钟，浏览器内存可能不够。请先剪成片段。');
      var channels = [];
      for (var i = 0; i < audio.numberOfChannels; i++) channels.push(audio.getChannelData(i));
      setSource({
        channels: channels,
        sampleRate: audio.sampleRate,
        name: file.name,
        duration: audio.duration,
        isDemo: false,
        demoId: null
      });
      state.demoId = null;
      renderDemos();
      toast('已载入「' + file.name + '」，' + formatBytes(file.size) + '。');
      if (getDSP() && audio.duration <= 180) await processCurrent({ auto: true, silent: true });
      else if (getDSP()) {
        toast('长音频已载入。建议手动确认档位后再开始炸麦。');
      }
    } catch (e) {
      console.error(e);
      toast('无法解码这个文件：' + (e && e.message ? e.message : '未知错误'), true);
      if (!state.source) setSourceStatus('等待输入', false);
      else setSourceStatus(state.source.isDemo ? '示例曲' : '已载入', true);
    } finally {
      state.loadingFile = false;
      if (el.dropzone) el.dropzone.classList.remove('is-busy');
      if (el.fileInput) el.fileInput.value = '';
    }
  }

  function isAudioFile(file) {
    if (file.type && /^audio\//i.test(file.type)) return true;
    return /\.(mp3|wav|flac|ogg|oga|m4a|aac|opus|aiff|aif|webm)$/i.test(file.name || '');
  }

  function decodeAudio(ctx, array) {
    return new Promise(function (resolve, reject) {
      var ret = ctx.decodeAudioData(array, resolve, reject);
      if (ret && typeof ret.then === 'function') ret.then(resolve, reject);
    });
  }

  async function loadDemo(id) {
    if (state.loadingDemo) return;
    var demo = getDemo();
    if (!demo || typeof demo.generate !== 'function') { toast('示例曲模块未加载。', true); return; }
    var meta = null;
    var list = [];
    try { list = demo.list() || []; } catch (e) { list = []; }
    for (var i = 0; i < list.length; i++) if (list[i].id === id) meta = list[i];
    if (!meta) { toast('找不到这首示例曲。', true); return; }
    state.loadingDemo = true;
    setSourceStatus('合成示例…', true);
    try {
      var ctx = ensureCtx();
      var sr = ctx.sampleRate || 48000;
      var key = id + '@' + sr;
      var generated = state.demoCache.get(key);
      if (!generated) {
        await tick(30);
        generated = demo.generate(id, sr);
        state.demoCache.set(key, generated);
      }
      state.demoId = id;
      setSource({
        channels: generated.channels,
        sampleRate: generated.sampleRate || sr,
        name: meta.name + '（内置示例）',
        duration: generated.duration || generated.channels[0].length / (generated.sampleRate || sr),
        isDemo: true,
        demoId: id
      });
      renderDemos();
      if (getDSP()) {
        var result = await processCurrent({ auto: true, silent: true });
        if (result) toast('「' + meta.name + '」已自动炸到 ' + dbText(result.stats.lufs, 1) + ' LUFS / TP ' + dbText(result.stats.truePeakDb, 1) + ' dBTP。');
        else toast('示例已载入，但自动渲染失败；可按「开始炸麦」重试。', true);
      } else {
        toast('示例已载入，但 DSP 引擎未加载。', true);
      }
    } catch (e) {
      console.error(e);
      toast('示例曲生成失败：' + (e && e.message ? e.message : '未知错误'), true);
      setSourceStatus(state.source ? (state.source.isDemo ? '示例曲' : '已载入') : '等待输入', !!state.source);
    } finally {
      state.loadingDemo = false;
      setSourceStatus(state.source ? (state.source.isDemo ? '示例曲' : '已载入') : '等待输入', !!state.source);
    }
  }

  function setSource(src) {
    stopPlayback(true);
    state.sourceToken++;
    state.source = src;
    state.processed = null;
    state.processedBuffer = null;
    state.peaks.original = null;
    state.peaks.processed = null;
    state.cache.clear();
    state.originalStats = null;
    state.abOriginal = false;
    state.offset = 0;
    state.demoId = src.demoId || null;
    try {
      var ctx = ensureCtx();
      state.originalBuffer = makeBuffer(ctx, src.channels, src.sampleRate);
    } catch (e) {
      state.originalBuffer = null;
      toast('无法创建播放缓冲区：' + e.message, true);
    }
    state.peaks.original = computePeaks(src.channels, 1400);
    resetStats();
    updateSourceUI();
    updateWaveInfo();
    updatePlayUI();
    updateControls();
    drawWave();
    measureSource(src);
    setSourceStatus(src.isDemo ? '示例曲' : '已载入', true);
    var base = baseFromName(src.name.replace(/（内置示例）$/, ''));
    if (el.filename) el.filename.value = (base || '我的炸麦') + '_炸麦';
  }

  function makeBuffer(ctx, channels, sampleRate) {
    if (!channels || !channels.length || !channels[0].length) throw new Error('音频数据为空。');
    var buf = ctx.createBuffer(channels.length, channels[0].length, sampleRate);
    for (var i = 0; i < channels.length; i++) buf.copyToChannel(channels[i], i);
    return buf;
  }

  function measureSource(src) {
    var dsp = getDSP();
    if (!dsp || typeof dsp.measure !== 'function') return;
    var token = state.sourceToken;
    if (src.duration > 300) {
      if (el.sourceNote) el.sourceNote.textContent = '长音频已跳过原声响度测量。文件只在本机解码，没有上传。';
      return;
    }
    setTimeout(function () {
      if (token !== state.sourceToken || !state.source) return;
      try {
        var stats = dsp.measure(src.channels, src.sampleRate);
        if (token !== state.sourceToken) return;
        state.originalStats = stats;
        if (el.sourceNote) {
          el.sourceNote.textContent = '原声 ' + dbText(stats.lufs, 1) + ' LUFS · TP ' + dbText(stats.truePeakDb, 1) + ' dBTP。文件只在本机解码，没有上传。';
        }
      } catch (e) {
        if (el.sourceNote) el.sourceNote.textContent = '原声响度测量失败。文件只在本机解码，没有上传。';
      }
    }, 80);
  }

  function clearSource() {
    stopPlayback(true);
    state.sourceToken++;
    state.source = null;
    state.processed = null;
    state.processedBuffer = null;
    state.originalBuffer = null;
    state.peaks.original = null;
    state.peaks.processed = null;
    state.cache.clear();
    state.originalStats = null;
    state.demoId = null;
    state.abOriginal = false;
    state.offset = 0;
    if (el.sourceInfo) el.sourceInfo.hidden = true;
    if (el.waveEmpty) el.waveEmpty.style.display = '';
    if (el.filename) el.filename.value = '我的炸麦';
    if (el.fileInput) el.fileInput.value = '';
    setSourceStatus('等待输入', false);
    resetStats();
    updateSourceUI();
    updateWaveInfo();
    updatePlayUI();
    updateControls();
    updateExportHint();
    drawWave();
    renderDemos();
    toast('已清空音源。');
  }

  function setSourceStatus(text, hot) {
    if (!el.sourceStatus) return;
    el.sourceStatus.textContent = text;
    el.sourceStatus.classList.toggle('is-hot', !!hot);
  }

  /* ------------------------------------------------------------------ */
  /* processing                                                         */
  /* ------------------------------------------------------------------ */

  async function processCurrent(opts) {
    opts = opts || {};
    if (!state.source) return null;
    if (state.processing) return null;
    var dsp = getDSP();
    if (!dsp || typeof dsp.process !== 'function') {
      toast('DSP 引擎未加载，无法炸麦。请检查 src/dsp.js。', true);
      return null;
    }
    if (!opts.force && state.cache.has(state.presetId)) {
      var cached = state.cache.get(state.presetId);
      if (state.processed !== cached) applyProcessed(cached, { silent: true });
      return cached;
    }
    var token = state.sourceToken;
    var preset = getPreset(state.presetId);
    state.processing = true;
    state.offset = 0;
    state.abOriginal = false;
    if (el.btnProcess) el.btnProcess.classList.add('is-processing');
    if (el.procElapsed) el.procElapsed.textContent = 'RENDERING…';
    if (el.procHint) el.procHint.textContent = '正在把「' + preset.name + '」推过削波、压缩与真峰值限幅……';
    if (el.btnProcessLabel) el.btnProcessLabel.textContent = '正在炸…';
    updateControls();
    await nextFrame();
    var started = (window.performance && performance.now) ? performance.now() : Date.now();
    try {
      var result = dsp.process(state.source.channels, state.source.sampleRate, state.presetId, {});
      if (!result || !result.channels || !result.channels.length) throw new Error('DSP 没有返回音频。');
      if (token !== state.sourceToken) return null;
      if (!result.stats) result.stats = {};
      result.stats.processingMs = result.stats.processingMs || ((window.performance && performance.now ? performance.now() : Date.now()) - started);
      state.cache.set(state.presetId, result);
      applyProcessed(result, { silent: !!opts.silent });
      if (!opts.silent) {
        toast('已炸到 ' + dbText(result.stats.lufs, 1) + ' LUFS / TP ' + dbText(result.stats.truePeakDb, 2) + ' dBTP。');
      }
      return result;
    } catch (e) {
      console.error(e);
      toast('炸麦失败：' + (e && e.message ? e.message : '未知错误'), true);
      if (el.procHint) el.procHint.textContent = '渲染失败。可以重试，或换一档。';
      return null;
    } finally {
      if (token === state.sourceToken) {
        state.processing = false;
        if (el.btnProcess) el.btnProcess.classList.remove('is-processing');
        updateControls();
        updateHint();
      }
    }
  }

  async function getProcessedFor(id, onStep) {
    if (state.cache.has(id)) return state.cache.get(id);
    var dsp = getDSP();
    if (!dsp) throw new Error('DSP 引擎未加载。');
    if (!state.source) throw new Error('还没有音源。');
    await tick(10);
    var result = dsp.process(state.source.channels, state.source.sampleRate, id, {});
    if (!result || !result.channels) throw new Error('DSP 返回为空。');
    if (!result.stats) result.stats = {};
    state.cache.set(id, result);
    if (state.presetId === id) applyProcessed(result, { silent: true });
    if (onStep) onStep(result);
    await tick(10);
    return result;
  }

  function applyProcessed(result, opts) {
    opts = opts || {};
    if (!result || !result.channels) return;
    try {
      var ctx = ensureCtx();
      state.processed = result;
      state.processedBuffer = makeBuffer(ctx, result.channels, result.sampleRate || state.source.sampleRate);
      state.peaks.processed = computePeaks(result.channels, 1400);
    } catch (e) {
      toast('无法创建炸麦预览：' + e.message, true);
      return;
    }
    if (!opts.keepOffset) state.offset = 0;
    state.abOriginal = false;
    if (!opts.silent) { /* caller shows toast */ }
    updateStats(result);
    updateWaveInfo();
    updatePlayUI();
    updateControls();
    updateExportHint();
    updateHint();
    drawWave();
  }

  /* ------------------------------------------------------------------ */
  /* stats                                                              */
  /* ------------------------------------------------------------------ */

  function statEl(id) { return document.getElementById(id); }

  function resetStats() {
    var p = getPreset(state.presetId);
    var pairs = [
      ['stat-lufs', '—'], ['stat-tp', '—'], ['stat-peak', '—'], ['stat-crest', '—'], ['stat-rms', '—'], ['stat-time', '—']
    ];
    for (var i = 0; i < pairs.length; i++) {
      var e = statEl(pairs[i][0]);
      if (e) e.textContent = pairs[i][1];
      var cell = e ? e.parentElement : null;
      if (cell) cell.classList.remove('is-good', 'is-warn', 'is-bad');
    }
    if (el.statLufsT) el.statLufsT.textContent = '目标 ' + Number(p.targetLufs).toFixed(1);
    if (el.statTpT) el.statTpT.textContent = '天花板 ' + Number(p.ceilingDb).toFixed(1);
    if (el.statsVerdict) el.statsVerdict.textContent = '尚未处理。选择档位，然后按下「开始炸麦」。';
    if (el.statsPreset) el.statsPreset.textContent = 'PRESET —';
  }

  function setStatCell(id, value, status) {
    var e = statEl(id);
    if (!e) return;
    e.textContent = value;
    var cell = e.parentElement;
    if (!cell) return;
    cell.classList.remove('is-good', 'is-warn', 'is-bad');
    if (status) cell.classList.add('is-' + status);
  }

  function updateStats(result) {
    var s = result.stats || {};
    var p = getPreset(result.presetId || state.presetId);
    var lufs = s.lufs;
    var tp = s.truePeakDb;
    var diff = lufs - p.targetLufs;
    var lufsStatus = Math.abs(diff) <= 0.8 ? 'good' : (Math.abs(diff) <= 1.5 ? 'warn' : 'bad');
    var tpStatus = tp <= p.ceilingDb + 0.1 ? 'good' : (tp <= p.ceilingDb + 0.5 ? 'warn' : 'bad');
    setStatCell('stat-lufs', dbText(lufs, 1), lufsStatus);
    setStatCell('stat-tp', dbText(tp, 2), tpStatus);
    setStatCell('stat-peak', dbText(s.peakDb, 2), s.peakDb > -0.05 ? 'warn' : '');
    setStatCell('stat-crest', dbText(s.crestDb, 1), '');
    setStatCell('stat-rms', dbText(s.rmsDb, 1), '');
    setStatCell('stat-time', String(Math.round(s.processingMs || 0)), '');
    if (el.statLufsT) el.statLufsT.textContent = '目标 ' + Number(p.targetLufs).toFixed(1) + ' · Δ ' + (diff >= 0 ? '+' : '') + diff.toFixed(1);
    if (el.statTpT) el.statTpT.textContent = '天花板 ' + Number(p.ceilingDb).toFixed(2);
    if (el.statsPreset) el.statsPreset.textContent = 'PRESET ' + String(p.id).toUpperCase();
    var verdict;
    if (Math.abs(diff) <= 0.8 && tp <= p.ceilingDb + 0.1) {
      verdict = '达标：' + dbText(lufs, 1) + ' LUFS / ' + dbText(tp, 2) + ' dBTP，动态压到 ' + dbText(s.crestDb, 1) + ' LU。已经贴住目标。';
    } else if (tp > p.ceilingDb + 0.1) {
      verdict = '真峰值 ' + dbText(tp, 2) + ' dBTP 超过天花板 ' + Number(p.ceilingDb).toFixed(1) + '，回放可能削波。';
    } else {
      verdict = '响度 ' + dbText(lufs, 1) + ' LUFS，距目标 ' + (diff >= 0 ? '+' : '') + diff.toFixed(1) + ' LU。极端素材可能压不到目标。';
    }
    if (el.statsVerdict) el.statsVerdict.textContent = verdict;
  }

  /* ------------------------------------------------------------------ */
  /* playback                                                           */
  /* ------------------------------------------------------------------ */

  function currentPlayable() {
    if (!state.source) return null;
    if (state.abOriginal) {
      if (!state.originalBuffer) return null;
      return { buffer: state.originalBuffer, duration: state.source.duration, kind: 'original' };
    }
    if (state.processedBuffer) {
      return { buffer: state.processedBuffer, duration: state.processed.duration || state.source.duration, kind: 'processed' };
    }
    if (state.originalBuffer) {
      return { buffer: state.originalBuffer, duration: state.source.duration, kind: 'original' };
    }
    return null;
  }

  function getDuration() {
    if (state.processed) return state.processed.duration || (state.processed.channels[0].length / state.processed.sampleRate);
    if (state.source) return state.source.duration;
    return 0;
  }

  function currentPosition() {
    if (!state.source) return 0;
    if (state.playing && state.ctx) {
      var pos = state.ctx.currentTime - state.startedAt;
      if (pos < 0) pos = 0;
      var d = getDuration();
      if (pos > d) pos = d;
      return pos;
    }
    return state.offset;
  }

  function ensureSafety(cb) {
    if (state.safetyAccepted) { cb(); return; }
    state.pendingSafety = cb;
    if (el.safetyModal) el.safetyModal.hidden = false;
    setTimeout(function () { if (el.btnSafetyOk) el.btnSafetyOk.focus(); }, 30);
  }

  function closeSafety(accepted) {
    if (el.safetyModal) el.safetyModal.hidden = true;
    var cb = state.pendingSafety;
    state.pendingSafety = null;
    if (accepted) {
      state.safetyAccepted = true;
      if (typeof cb === 'function') cb();
    }
  }

  function togglePlay() {
    if (state.processing) { toast('正在渲染，稍等再播放。'); return; }
    if (state.playing) { pausePlayback(); return; }
    var data = currentPlayable();
    if (!data) { toast('还没有可播放的音频。', true); return; }
    ensureSafety(function () { startPlayback(); });
  }

  async function startPlayback() {
    var data = currentPlayable();
    if (!data) return;
    try {
      var ctx = await resumeCtx();
      stopNode();
      var duration = data.duration || data.buffer.duration;
      var offset = state.offset;
      if (!isFinite(offset) || offset < 0) offset = 0;
      if (offset >= duration - 0.02) offset = 0;
      var node = ctx.createBufferSource();
      node.buffer = data.buffer;
      node.connect(state.master);
      state.master.gain.value = state.volume;
      var token = state.playToken;
      node.onended = function () {
        if (token !== state.playToken) return;
        state.playing = false;
        state.sourceNode = null;
        state.offset = 0;
        cancelRaf();
        updatePlayUI();
        drawWave();
      };
      node.start(0, Math.min(offset, Math.max(0, duration - 0.005)));
      state.sourceNode = node;
      state.playing = true;
      state.startedAt = ctx.currentTime - offset;
      state.playToken = token;
      updatePlayUI();
      startRaf();
    } catch (e) {
      console.error(e);
      toast('播放失败：' + (e && e.message ? e.message : '未知错误'), true);
    }
  }

  function stopNode() {
    state.playToken++;
    cancelRaf();
    if (state.sourceNode) {
      try {
        state.sourceNode.onended = null;
        state.sourceNode.stop(0);
        state.sourceNode.disconnect();
      } catch (e) { /* already stopped */ }
      state.sourceNode = null;
    }
    state.playing = false;
  }

  function pausePlayback() {
    if (!state.playing) return;
    var pos = currentPosition();
    stopNode();
    state.offset = clamp(pos, 0, getDuration());
    updatePlayUI();
    drawWave();
  }

  function stopPlayback() {
    stopNode();
    state.offset = 0;
    updatePlayUI();
    drawWave();
  }

  function cancelRaf() {
    if (state.raf) cancelAnimationFrame(state.raf);
    state.raf = 0;
  }

  function startRaf() {
    cancelRaf();
    function frame() {
      if (!state.playing) return;
      var pos = currentPosition();
      state.offset = pos;
      updateTimeUI();
      if (!state.seekDragging && el.seek) {
        var d = getDuration();
        el.seek.value = String(d > 0 ? Math.round(pos / d * 1000) : 0);
      }
      drawWave();
      state.raf = requestAnimationFrame(frame);
    }
    state.raf = requestAnimationFrame(frame);
  }

  function seekToRatio(ratio) {
    if (!state.source) return;
    var d = getDuration();
    if (!d) return;
    var pos = clamp(ratio, 0, 1) * d;
    if (state.playing) {
      stopNode();
      state.offset = pos;
      startPlayback();
    } else {
      state.offset = pos;
      updatePlayUI();
      drawWave();
    }
  }

  function updatePlayUI() {
    var data = currentPlayable();
    if (el.playIcon) el.playIcon.textContent = state.playing ? '❚❚' : '▶';
    if (el.btnPlay) {
      el.btnPlay.classList.toggle('is-playing', state.playing);
      el.btnPlay.disabled = !data;
      el.btnPlay.setAttribute('aria-label', state.playing ? '暂停' : '播放');
    }
    if (el.btnAb) {
      el.btnAb.disabled = !state.processedBuffer;
      el.btnAb.setAttribute('aria-pressed', state.abOriginal ? 'true' : 'false');
      var txt = el.btnAb.querySelector('.switch-text');
      if (txt) txt.textContent = state.abOriginal ? 'B / 原曲' : 'A / 炸麦';
    }
    updateTimeUI();
  }

  function updateTimeUI() {
    var d = getDuration();
    var pos = currentPosition();
    if (el.timeNow) el.timeNow.textContent = state.source ? formatTime(pos) : '00:00';
    if (el.timeTotal) el.timeTotal.textContent = state.source ? formatTime(d) : '00:00';
  }

  /* ------------------------------------------------------------------ */
  /* drawing                                                            */
  /* ------------------------------------------------------------------ */

  function computePeaks(channels, bins) {
    if (!channels || !channels.length) return null;
    bins = bins || 1400;
    var n = channels[0].length;
    if (!n) return null;
    var peaks = new Float32Array(bins);
    var step = n / bins;
    var chCount = channels.length;
    for (var b = 0; b < bins; b++) {
      var start = Math.floor(b * step);
      var end = Math.min(n, Math.floor((b + 1) * step));
      if (end <= start) end = start + 1;
      var max = 0;
      for (var i = start; i < end; i++) {
        for (var c = 0; c < chCount; c++) {
          var v = channels[c][i];
          if (v < 0) v = -v;
          if (v > max) max = v;
        }
      }
      peaks[b] = Math.min(1.25, max);
    }
    return peaks;
  }

  function drawPeaksOn(ctx, peaks, x, y, w, h, color, fillAlpha, lineAlpha) {
    if (!peaks || !peaks.length) return;
    var center = y + h / 2;
    var amp = h * 0.45;
    var len = peaks.length;
    ctx.beginPath();
    for (var i = 0; i < len; i++) {
      var px = x + (i / (len - 1)) * w;
      var py = center - peaks[i] * amp;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    for (var j = len - 1; j >= 0; j--) {
      var px2 = x + (j / (len - 1)) * w;
      var py2 = center + peaks[j] * amp;
      ctx.lineTo(px2, py2);
    }
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.globalAlpha = fillAlpha;
    ctx.fill();
    ctx.globalAlpha = lineAlpha == null ? 1 : lineAlpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function drawWave() {
    if (!el.waveCanvas) return;
    var canvas = el.waveCanvas;
    var rect = canvas.getBoundingClientRect();
    var w = Math.max(1, rect.width);
    var h = Math.max(1, rect.height || 210);
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var pixelW = Math.max(1, Math.round(w * dpr));
    var pixelH = Math.max(1, Math.round(h * dpr));
    if (canvas.width !== pixelW || canvas.height !== pixelH) {
      canvas.width = pixelW;
      canvas.height = pixelH;
    }
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#07090b';
    ctx.fillRect(0, 0, w, h);

    var center = h / 2;
    ctx.strokeStyle = 'rgba(255,255,255,.055)';
    ctx.lineWidth = 1;
    for (var gx = 1; gx < 8; gx++) {
      var x = (w / 8) * gx;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(255,255,255,.09)';
    ctx.beginPath();
    ctx.moveTo(0, center);
    ctx.lineTo(w, center);
    ctx.stroke();

    if (!state.source) {
      ctx.strokeStyle = 'rgba(255,77,0,.25)';
      ctx.beginPath();
      ctx.moveTo(0, center);
      for (var nx = 0; nx < w; nx += 4) {
        var yy = center + Math.sin(nx * 0.02) * Math.sin(nx * 0.003) * 8;
        if (nx === 0) ctx.moveTo(nx, yy); else ctx.lineTo(nx, yy);
      }
      ctx.stroke();
      return;
    }

    var pOrig = state.peaks.original;
    var pProc = state.peaks.processed;
    if (pOrig) {
      drawPeaksOn(ctx, pOrig, 0, 2, w, h - 4,
        state.abOriginal ? 'rgba(255,179,0,.55)' : 'rgba(150,158,169,.42)',
        state.abOriginal ? 0.42 : 0.2,
        state.abOriginal ? 0.8 : 0.45);
    }
    if (pProc) {
      drawPeaksOn(ctx, pProc, 0, 2, w, h - 4,
        state.abOriginal ? 'rgba(120,128,140,.38)' : 'rgba(255,77,0,.78)',
        state.abOriginal ? 0.12 : 0.26,
        state.abOriginal ? 0.35 : 0.95);
    }

    var d = getDuration();
    if (d > 0) {
      var pos = currentPosition();
      var px = clamp(pos / d, 0, 1) * w;
      ctx.strokeStyle = 'rgba(255,229,0,.85)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, h);
      ctx.stroke();
      ctx.fillStyle = '#ffe500';
      ctx.beginPath();
      ctx.moveTo(px - 4, 0);
      ctx.lineTo(px + 4, 0);
      ctx.lineTo(px, 6);
      ctx.closePath();
      ctx.fill();
    }

    ctx.fillStyle = 'rgba(150,158,170,.5)';
    ctx.font = '8px "SFMono-Regular", Consolas, monospace';
    ctx.fillText('00:00', 6, h - 6);
    var endLabel = formatTime(d);
    var tw = ctx.measureText(endLabel).width;
    ctx.fillText(endLabel, w - tw - 6, h - 6);
    if (state.abOriginal) {
      ctx.fillStyle = 'rgba(255,179,0,.75)';
      ctx.fillText('B / ORIGINAL', 6, 12);
    }
  }

  function initWaveSizing() {
    if (window.ResizeObserver && el.waveStage) {
      var ro = new ResizeObserver(function () { drawWave(); });
      ro.observe(el.waveStage);
    } else {
      window.addEventListener('resize', function () { drawWave(); });
    }
  }

  function initHero() {
    var canvas = el.heroCanvas;
    if (!canvas) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var W = 720, H = 420;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    var ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var bars = 64;
    function draw(t) {
      ctx.clearRect(0, 0, W, H);
      var base = H * 0.84;
      var maxH = H * 0.62;
      ctx.strokeStyle = 'rgba(255,77,0,.18)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(20, base);
      ctx.lineTo(W - 20, base);
      ctx.stroke();
      for (var i = 0; i < bars; i++) {
        var x = 24 + i * ((W - 48) / bars);
        var bw = Math.max(2, (W - 48) / bars - 3);
        var ph = i * 0.31;
        var v = 0.5 + 0.5 * Math.sin(t * 0.0021 + ph) * Math.sin(t * 0.0007 + ph * 0.4);
        var spike = Math.pow(Math.max(0, Math.sin(t * 0.004 + i * 1.7)), 18);
        var hgt = maxH * (0.06 + 0.74 * v * v + 0.55 * spike);
        if (hgt > maxH) hgt = maxH;
        var grad = ctx.createLinearGradient(0, base - hgt, 0, base);
        grad.addColorStop(0, i % 8 === 0 ? '#ffe500' : '#ff7a1a');
        grad.addColorStop(1, 'rgba(255,77,0,.15)');
        ctx.fillStyle = grad;
        ctx.fillRect(x, base - hgt, bw, hgt);
        if (i % 8 === 0) {
          ctx.fillStyle = 'rgba(255,229,0,.8)';
          ctx.fillRect(x, base - hgt - 4, bw, 2);
        }
      }
      ctx.strokeStyle = 'rgba(255,77,0,.32)';
      ctx.beginPath();
      for (var px = 0; px <= W; px += 6) {
        var yy = base - maxH * (0.14 + 0.12 * Math.sin(px * 0.013 + t * 0.0016) + 0.06 * Math.sin(px * 0.041 - t * 0.002));
        if (px === 0) ctx.moveTo(px, yy); else ctx.lineTo(px, yy);
      }
      ctx.stroke();
      var scan = ((t * 0.06) % H);
      ctx.fillStyle = 'rgba(255,77,0,.045)';
      ctx.fillRect(0, scan, W, 2);
      if (!reduced) requestAnimationFrame(draw);
    }
    if (reduced) draw(0);
    else requestAnimationFrame(draw);
  }

  /* ------------------------------------------------------------------ */
  /* export                                                             */
  /* ------------------------------------------------------------------ */

  function selectFormat(id) {
    if (!formatSupported(id)) { toast('这个格式在当前浏览器里不可用。', true); return; }
    state.formatId = id;
    var cards = el.formatGrid ? el.formatGrid.querySelectorAll('.format-card') : [];
    for (var i = 0; i < cards.length; i++) {
      var on = cards[i].getAttribute('data-format') === id;
      cards[i].classList.toggle('is-active', on);
      cards[i].setAttribute('aria-checked', on ? 'true' : 'false');
    }
    updateExportHint();
    updateControls();
  }

  function getFormatOptions(formatId) {
    if (formatId === 'mp3') return { bitrate: parseInt(el.mp3Bitrate ? el.mp3Bitrate.value : '192', 10) || 192 };
    if (formatId === 'ogg') return { bitrate: 128 };
    return {};
  }

  function targetSampleRate(formatId) {
    var sel = el.sampleRate ? el.sampleRate.value : 'source';
    var sourceSr = state.processed ? state.processed.sampleRate : (state.source ? state.source.sampleRate : 48000);
    var sr = sel === 'source' ? sourceSr : parseInt(sel, 10);
    if (!isFinite(sr) || sr < 8000) sr = 48000;
    if (formatId === 'mp3' || formatId === 'ogg') sr = Math.min(sr, 48000);
    return sr;
  }

  async function prepareAudio(formatId) {
    var result = state.processed;
    if (!result) throw new Error('还没有炸麦结果。');
    var sr = targetSampleRate(formatId);
    if (sr === result.sampleRate) return { channels: result.channels, sampleRate: sr, resampled: false };
    var channels = await resampleChannels(result.channels, result.sampleRate, sr);
    return { channels: channels, sampleRate: sr, resampled: true };
  }

  async function resampleChannels(channels, srcSr, dstSr) {
    if (srcSr === dstSr) return channels;
    var OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OAC) throw new Error('当前浏览器不支持离线重采样。');
    var length = Math.max(1, Math.ceil(channels[0].length * dstSr / srcSr));
    var off = new OAC(channels.length, length, dstSr);
    var buffer = off.createBuffer(channels.length, channels[0].length, srcSr);
    for (var i = 0; i < channels.length; i++) buffer.copyToChannel(channels[i], i);
    var src = off.createBufferSource();
    src.buffer = buffer;
    src.connect(off.destination);
    src.start(0);
    var rendered = await off.startRendering();
    var out = [];
    for (var c = 0; c < rendered.numberOfChannels; c++) out.push(rendered.getChannelData(c));
    return out;
  }

  async function encodeBlob(formatId, channels, sampleRate, options, onProgress) {
    var ex = getExport();
    if (!ex || typeof ex.encode !== 'function') throw new Error('导出模块未加载。请检查 src/exporters.js。');
    var blob = await ex.encode(formatId, channels, sampleRate, options || {}, onProgress);
    if (blob && typeof blob.size === 'number') return blob;
    if (blob && blob.buffer) return new Blob([blob], { type: getFormat(formatId).mime || 'application/octet-stream' });
    throw new Error('编码器没有返回文件。');
  }

  function filenameForPreset(preset, format) {
    var base = sanitizeBase(el.filename ? el.filename.value : '我的炸麦');
    return base + '_' + preset.name.replace(/\s+/g, '') + '.' + (format.ext || 'wav');
  }

  function downloadBlob(blob, filename) {
    if (!blob) throw new Error('文件为空。');
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    state.lastExportName = filename;
    setTimeout(function () { URL.revokeObjectURL(url); }, 12000);
  }

  function blobFromText(text) {
    return new Blob([text], { type: 'text/plain;charset=utf-8' });
  }

  async function exportCurrent() {
    if (state.exporting) return;
    if (!state.processed) { toast('先渲染一档炸麦，再导出。', true); return; }
    var fmt = getFormat(state.formatId);
    if (!formatSupported(state.formatId)) { toast('当前格式不可用，请换一个。', true); return; }
    state.exporting = true;
    updateControls();
    showProgress('准备编码 ' + fmt.label + '…', 0, '浏览器本地编码，别关页面。');
    try {
      var prepared = await prepareAudio(state.formatId);
      if (prepared.resampled) setProgress(0.08, '重采样到 ' + (prepared.sampleRate / 1000).toFixed(1) + ' kHz…', '');
      var blob = await encodeBlob(state.formatId, prepared.channels, prepared.sampleRate, getFormatOptions(state.formatId), function (p) {
        var ratio = 0.1 + p * 0.88;
        setProgress(ratio, '编码 ' + fmt.label + '…', Math.round(p * 100) + '%');
      });
      var name = filenameForPreset(getPreset(state.presetId), fmt);
      downloadBlob(blob, name);
      setProgress(1, '完成', name + ' · ' + formatBytes(blob.size));
      toast('已导出 ' + name + '（' + formatBytes(blob.size) + '）。');
      hideProgress(1800);
    } catch (e) {
      console.error(e);
      setProgress(0, '导出失败', e && e.message ? e.message : '未知错误');
      toast('导出失败：' + (e && e.message ? e.message : '未知错误'), true);
      hideProgress(4000);
    } finally {
      state.exporting = false;
      updateControls();
      updateExportHint();
    }
  }

  async function collectAllResults(progressFn) {
    var presets = getPresets();
    var results = [];
    for (var i = 0; i < presets.length; i++) {
      if (progressFn) progressFn(i, presets[i], 0);
      var r = await getProcessedFor(presets[i].id);
      results.push(r);
      if (progressFn) progressFn(i, presets[i], 1);
    }
    var current = state.cache.get(state.presetId);
    if (current && !state.processed) applyProcessed(current, { silent: true });
    return results;
  }

  async function exportAll() {
    if (state.exporting) return;
    if (!state.source) { toast('先载入音源。', true); return; }
    if (!getDSP()) { toast('DSP 引擎未加载。', true); return; }
    var fmt = getFormat(state.formatId);
    if (!formatSupported(state.formatId)) { toast('当前格式不可用，请换一个。', true); return; }
    state.exporting = true;
    updateControls();
    showProgress('四档处理 1 / 4…', 0.02, '四档要各跑一遍 DSP，长音频请耐心。');
    try {
      var presets = getPresets();
      var results = [];
      for (var i = 0; i < presets.length; i++) {
        setProgress(0.02 + (i / (presets.length + 1)) * 0.55, '四档处理 ' + (i + 1) + ' / 4 · ' + presets[i].name, '');
        var r = await getProcessedFor(presets[i].id);
        results.push(r);
        setProgress(0.02 + ((i + 1) / (presets.length + 1)) * 0.55, '四档处理 ' + (i + 1) + ' / 4 完成', '');
      }
      var entries = [];
      for (var j = 0; j < results.length; j++) {
        var result = results[j];
        var sr = targetSampleRate(state.formatId);
        var ch = result.channels;
        if (sr !== result.sampleRate) ch = await resampleChannels(result.channels, result.sampleRate, sr);
        var baseRatio = 0.62 + (j / results.length) * 0.3;
        var blob = await encodeBlob(state.formatId, ch, sr, getFormatOptions(state.formatId), function (p) {
          setProgress(baseRatio + (p * 0.3 / results.length), '编码 ' + presets[j].name + '…', Math.round(p * 100) + '%');
        });
        entries.push({ name: filenameForPreset(presets[j], fmt), blob: blob });
      }
      setProgress(0.93, '生成对比图…', '');
      var pngBlob = null;
      try {
        var canvas = makeCompareCanvas(results);
        pngBlob = await canvasToBlob(canvas);
        entries.push({ name: '四档对比.png', blob: pngBlob });
      } catch (e) { console.warn('compare png failed', e); }
      entries.push({ name: '炸麦说明.txt', blob: blobFromText(buildManifest(results, fmt)) });
      setProgress(0.96, '打包 ZIP…', '');
      var ex = getExport();
      if (!ex || typeof ex.zipAsync !== 'function') throw new Error('ZIP 模块未加载。');
      var zipBlob = await ex.zipAsync(entries);
      var base = sanitizeBase(el.filename ? el.filename.value : '我的炸麦');
      var zipName = base + '_四档炸麦.zip';
      downloadBlob(zipBlob, zipName);
      setProgress(1, '打包完成', zipName + ' · ' + formatBytes(zipBlob.size));
      toast('四档已打包：' + zipName + '（' + formatBytes(zipBlob.size) + '）。');
      hideProgress(2200);
    } catch (e) {
      console.error(e);
      setProgress(0, '打包失败', e && e.message ? e.message : '未知错误');
      toast('四档打包失败：' + (e && e.message ? e.message : '未知错误'), true);
      hideProgress(5000);
    } finally {
      state.exporting = false;
      updateControls();
      updateExportHint();
    }
  }

  async function exportComparePng() {
    if (state.exporting) return;
    if (!state.source) { toast('先载入音源。', true); return; }
    if (!getDSP()) { toast('DSP 引擎未加载。', true); return; }
    state.exporting = true;
    updateControls();
    showProgress('准备四档对比…', 0.01, '会先把四档都跑一遍。');
    try {
      var results = await collectAllResults(function (i, preset, phase) {
        setProgress(0.02 + ((i + phase) / 5) * 0.86, (phase ? '完成 ' : '处理 ') + preset.name + ' ' + (i + 1) + ' / 4', '');
      });
      setProgress(0.94, '绘制对比图…', '');
      var canvas = makeCompareCanvas(results);
      var blob = await canvasToBlob(canvas);
      var base = sanitizeBase(el.filename ? el.filename.value : '我的炸麦');
      var name = base + '_四档对比.png';
      downloadBlob(blob, name);
      setProgress(1, '完成', name + ' · ' + formatBytes(blob.size));
      toast('已导出对比图 ' + name + '。');
      hideProgress(1800);
    } catch (e) {
      console.error(e);
      setProgress(0, '对比图导出失败', e && e.message ? e.message : '未知错误');
      toast('对比图导出失败：' + (e && e.message ? e.message : '未知错误'), true);
      hideProgress(4000);
    } finally {
      state.exporting = false;
      updateControls();
      updateExportHint();
    }
  }

  function buildManifest(results, fmt) {
    var lines = [];
    var now = new Date();
    lines.push('ZAOMAI LAB / 四档炸麦');
    lines.push('生成时间：' + now.toLocaleString('zh-CN'));
    lines.push('音源：' + (state.source ? state.source.name : '—'));
    lines.push('时长：' + (state.source ? formatTime(state.source.duration) : '—'));
    lines.push('采样率：' + (state.source ? state.source.sampleRate + ' Hz' : '—'));
    lines.push('导出格式：' + fmt.label + ' (. ' + fmt.ext + ')');
    lines.push('文件名前缀：' + sanitizeBase(el.filename ? el.filename.value : '我的炸麦'));
    lines.push('');
    lines.push('注意：四档输出都是成品响度，最高约 -3.5 LUFS。不要再叠加播放器增益。');
    lines.push('------------------------------------------------------------');
    for (var i = 0; i < results.length; i++) {
      var r = results[i];
      var p = getPreset(r.presetId);
      var s = r.stats || {};
      lines.push('');
      lines.push((i + 1) + '. ' + p.name + ' / ' + p.en);
      lines.push('   目标：' + Number(p.targetLufs).toFixed(1) + ' LUFS / 真峰值 ' + Number(p.ceilingDb).toFixed(1) + ' dBTP');
      lines.push('   实测：' + dbText(s.lufs, 2) + ' LUFS / TP ' + dbText(s.truePeakDb, 2) + ' dBTP / RMS ' + dbText(s.rmsDb, 1) + ' dBFS / 动态 ' + dbText(s.crestDb, 1) + ' LU');
      lines.push('   处理链：' + (p.chain ? p.chain.join(' → ') : '—'));
    }
    lines.push('');
    lines.push('由 ZAOMAI LAB 在浏览器内生成。音频没有上传。');
    return lines.join('\n');
  }

  function makeCompareCanvas(results) {
    var W = 1600, H = 1200;
    var canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#08090b';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(255,255,255,.035)';
    ctx.lineWidth = 1;
    for (var gx = 0; gx < W; gx += 50) {
      ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, H); ctx.stroke();
    }
    for (var gy = 0; gy < H; gy += 50) {
      ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W, gy); ctx.stroke();
    }
    ctx.fillStyle = '#ff4d00';
    ctx.fillRect(60, 54, 58, 5);
    ctx.fillStyle = '#ff7a1a';
    ctx.font = '700 13px "SFMono-Regular", Consolas, monospace';
    ctx.fillText('ZAOMAI LAB / COMPARISON REPORT', 60, 88);
    ctx.fillStyle = '#f2efe8';
    ctx.font = '900 58px "Arial Black", "Microsoft YaHei", "PingFang SC", sans-serif';
    ctx.fillText('四档炸麦对比', 58, 160);
    ctx.fillStyle = '#8d949f';
    ctx.font = '14px "Helvetica Neue", "Microsoft YaHei", sans-serif';
    var srcName = state.source ? state.source.name : '—';
    if (srcName.length > 54) srcName = srcName.slice(0, 51) + '…';
    ctx.fillText('SOURCE / ' + srcName, 60, 198);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#5d6570';
    ctx.font = '11px "SFMono-Regular", Consolas, monospace';
    ctx.fillText(new Date().toLocaleString('zh-CN'), W - 60, 88);
    ctx.fillText('BROWSER DSP · NO UPLOAD', W - 60, 110);
    ctx.textAlign = 'left';

    var origPeaks = state.peaks.original || computePeaks(state.source.channels, 1200);
    if (origPeaks) {
      ctx.fillStyle = '#5d6570';
      ctx.font = '700 10px "SFMono-Regular", Consolas, monospace';
      ctx.fillText('SOURCE WAVEFORM', 60, 238);
      drawPeaksOn(ctx, origPeaks, 60, 250, 1480, 72, 'rgba(150,158,169,.55)', 0.2, 0.55);
      if (state.originalStats) {
        ctx.fillStyle = '#8d949f';
        ctx.font = '11px "SFMono-Regular", Consolas, monospace';
        ctx.fillText('ORIGINAL  ' + dbText(state.originalStats.lufs, 1) + ' LUFS  /  TP ' + dbText(state.originalStats.truePeakDb, 1) + ' dBTP', 60, 342);
      }
    }

    var startY = 380;
    var rowH = 190;
    for (var i = 0; i < results.length; i++) {
      var r = results[i];
      var p = getPreset(r.presetId);
      var s = r.stats || {};
      var accent = p.color || '#ff4d00';
      var y = startY + i * rowH;
      ctx.fillStyle = 'rgba(255,255,255,.04)';
      ctx.fillRect(0, y - 18, W, 1);
      ctx.fillStyle = accent;
      ctx.font = '700 11px "SFMono-Regular", Consolas, monospace';
      ctx.fillText('LV.' + p.level + ' / ' + String(p.id).toUpperCase(), 60, y + 8);
      ctx.fillStyle = '#f2efe8';
      ctx.font = '900 30px "Arial Black", "Microsoft YaHei", "PingFang SC", sans-serif';
      ctx.fillText(p.name, 58, y + 48);
      ctx.fillStyle = '#8d949f';
      ctx.font = '12px "Helvetica Neue", "Microsoft YaHei", sans-serif';
      ctx.fillText(p.en, 60, y + 70);
      ctx.fillStyle = accent;
      ctx.font = '700 24px "SFMono-Regular", Consolas, monospace';
      ctx.fillText(Number(p.targetLufs).toFixed(1), 60, y + 112);
      ctx.fillStyle = '#5d6570';
      ctx.font = '9px "SFMono-Regular", Consolas, monospace';
      ctx.fillText('LUFS TARGET', 60, y + 128);

      var peaks = computePeaks(r.channels, 1200);
      drawPeaksOn(ctx, peaks, 330, y - 4, 1190, 108, accent, 0.2, 0.9);
      ctx.fillStyle = accent;
      ctx.font = '700 16px "SFMono-Regular", Consolas, monospace';
      ctx.fillText(dbText(s.lufs, 1) + ' LUFS', 330, y + 136);
      ctx.fillStyle = '#8d949f';
      ctx.font = '11px "SFMono-Regular", Consolas, monospace';
      ctx.fillText('TP ' + dbText(s.truePeakDb, 2) + ' dBTP   ·   RMS ' + dbText(s.rmsDb, 1) + ' dBFS   ·   CREST ' + dbText(s.crestDb, 1) + ' LU   ·   ' + Math.round(s.processingMs || 0) + ' ms', 330, y + 158);
    }

    ctx.fillStyle = '#ff4d00';
    ctx.fillRect(60, H - 58, 28, 3);
    ctx.fillStyle = '#76635c';
    ctx.font = '10px "SFMono-Regular", Consolas, monospace';
    ctx.fillText('警告：输出为成品响度，最高约 -3.5 LUFS。请勿长时间高音量试听。', 100, H - 52);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#4d5560';
    ctx.fillText('ZAOMAI LAB · ' + VERSION, W - 60, H - 52);
    ctx.textAlign = 'left';
    return canvas;
  }

  function canvasToBlob(canvas) {
    return new Promise(function (resolve, reject) {
      if (!canvas.toBlob) { reject(new Error('当前浏览器不支持 canvas.toBlob。')); return; }
      canvas.toBlob(function (blob) {
        if (blob) resolve(blob); else reject(new Error('对比图生成失败。'));
      }, 'image/png');
    });
  }

  /* ------------------------------------------------------------------ */
  /* UI state                                                           */
  /* ------------------------------------------------------------------ */

  function updateSourceUI() {
    var s = state.source;
    if (!s) {
      if (el.sourceInfo) el.sourceInfo.hidden = true;
      if (el.chipSr) el.chipSr.textContent = '-- kHz';
      if (el.chipDur) el.chipDur.textContent = '--:--';
      if (el.timeTotal) el.timeTotal.textContent = '00:00';
      if (el.waveEmpty) el.waveEmpty.style.display = '';
      return;
    }
    if (el.sourceInfo) el.sourceInfo.hidden = false;
    if (el.sourceName) el.sourceName.textContent = s.name;
    if (el.sourceDur) el.sourceDur.textContent = formatTime(s.duration);
    if (el.sourceSr) el.sourceSr.textContent = (s.sampleRate / 1000).toFixed(1) + ' kHz';
    if (el.sourceCh) el.sourceCh.textContent = s.channels.length === 1 ? 'Mono' : 'Stereo';
    if (el.sourceNote) el.sourceNote.textContent = '文件只在本机解码，没有上传。';
    if (el.chipSr) el.chipSr.textContent = (s.sampleRate / 1000).toFixed(1) + ' kHz';
    if (el.chipDur) el.chipDur.textContent = formatTime(s.duration);
    if (el.chipLevel) el.chipLevel.textContent = 'LV.' + getPreset(state.presetId).level;
    if (el.waveEmpty) el.waveEmpty.style.display = 'none';
    if (el.timeTotal) el.timeTotal.textContent = formatTime(s.duration);
  }

  function updateWaveInfo() {
    if (!el.waveInfo) return;
    var p = getPreset(state.presetId);
    if (state.processed) {
      var s = state.processed.stats || {};
      el.waveInfo.textContent = 'FIRE / ' + dbText(s.lufs, 1) + ' LUFS / TP ' + dbText(s.truePeakDb, 2) + ' dBTP';
      if (el.waveSub) el.waveSub.textContent = '原曲 vs ' + p.name;
      if (el.waveScale) el.waveScale.textContent = '0 — 1.0';
    } else if (state.source) {
      el.waveInfo.textContent = 'ORIGINAL / ' + (state.source.sampleRate / 1000).toFixed(1) + ' kHz / ' + state.source.channels.length + 'ch';
      if (el.waveSub) el.waveSub.textContent = '原曲预览';
      if (el.waveScale) el.waveScale.textContent = '0 — 1.0';
    } else {
      el.waveInfo.textContent = 'NO SIGNAL';
      if (el.waveSub) el.waveSub.textContent = '原曲 vs 炸麦后';
      if (el.waveScale) el.waveScale.textContent = '0 — 1';
    }
  }

  function updateHint() {
    if (!el.procHint) return;
    var dsp = getDSP();
    if (!state.source) {
      el.procHint.textContent = '先导入一首歌，或载入示例曲。';
    } else if (state.processing) {
      el.procHint.textContent = '正在把整首歌推过削波、压缩与限幅……';
    } else if (!dsp) {
      el.procHint.textContent = 'DSP 引擎未加载，请检查 src/dsp.js。';
    } else if (state.processed && state.processed.presetId === state.presetId) {
      var s = state.processed.stats || {};
      el.procHint.textContent = '已生成「' + getPreset(state.presetId).name + '」· ' + dbText(s.lufs, 1) + ' LUFS / TP ' + dbText(s.truePeakDb, 2) + ' dBTP。按播放试听。';
    } else {
      el.procHint.textContent = '已选「' + getPreset(state.presetId).name + '」，按下开始炸麦。';
    }
  }

  function updateControls() {
    var hasSource = !!state.source;
    var hasProcessed = !!state.processed;
    var dsp = !!getDSP();
    var fmt = state.formatId ? getFormat(state.formatId) : null;
    var fmtOk = state.formatId ? formatSupported(state.formatId) : false;
    if (el.btnProcess) {
      el.btnProcess.disabled = !hasSource || state.processing || !dsp;
      if (el.btnProcessLabel) {
        el.btnProcessLabel.textContent = state.processing ? '正在炸…' : (hasProcessed && state.processed.presetId === state.presetId ? '再来一次' : '开始炸麦');
      }
    }
    if (el.btnPlay) el.btnPlay.disabled = !currentPlayable() || state.processing;
    if (el.btnAb) el.btnAb.disabled = !state.processedBuffer;
    if (el.btnExportOne) {
      el.btnExportOne.disabled = !hasProcessed || !fmtOk || state.exporting;
      if (fmt) {
        var arrow = el.btnExportOne.querySelector('.btn-arrow');
        el.btnExportOne.textContent = '导出 ' + fmt.label + ' ';
        if (arrow) el.btnExportOne.appendChild(arrow);
        else {
          var span = document.createElement('span');
          span.className = 'btn-arrow';
          span.setAttribute('aria-hidden', 'true');
          span.textContent = '↓';
          el.btnExportOne.appendChild(span);
        }
      }
    }
    if (el.btnExportAll) el.btnExportAll.disabled = !hasSource || !fmtOk || state.exporting || !dsp;
    if (el.btnExportPng) el.btnExportPng.disabled = !hasSource || state.exporting || !dsp;
    if (el.btnClear) el.btnClear.hidden = !hasSource;
    if (el.procElapsed && !state.processing) {
      if (state.processed) {
        var s = state.processed.stats || {};
        el.procElapsed.textContent = 'RENDER ' + Math.round(s.processingMs || 0) + ' ms · ' + (state.processed.sampleRate / 1000).toFixed(1) + ' kHz · ' + state.processed.channels.length + ' ch';
      } else {
        el.procElapsed.textContent = '—';
      }
    }
    updateHint();
    updatePlayUI();
    updateExportHint();
    updateWaveInfo();
  }

  function updateExportHint() {
    if (!el.exportHint) return;
    var fmt = state.formatId ? getFormat(state.formatId) : null;
    if (!getExport()) {
      el.exportHint.textContent = '导出模块未加载，请检查 src/exporters.js。';
      el.exportHint.classList.add('is-warn');
      return;
    }
    if (!state.source) {
      el.exportHint.textContent = '先导入音源并炸一档，再选择格式导出。';
      el.exportHint.classList.remove('is-warn');
      return;
    }
    if (!state.processed) {
      el.exportHint.textContent = '还没有炸麦结果。先按「开始炸麦」。';
      el.exportHint.classList.remove('is-warn');
      return;
    }
    if (fmt && !formatSupported(fmt.id)) {
      el.exportHint.textContent = '当前浏览器不支持 ' + fmt.label + '，请换一种格式。';
      el.exportHint.classList.add('is-warn');
      return;
    }
    var sr = fmt ? targetSampleRate(fmt.id) : state.processed.sampleRate;
    var note = '当前 ' + (fmt ? fmt.label : '—') + ' · 导出 ' + (sr / 1000).toFixed(1) + ' kHz · ' + dbText(state.processed.stats.lufs, 1) + ' LUFS / TP ' + dbText(state.processed.stats.truePeakDb, 2) + ' dBTP。';
    if (fmt && (fmt.id === 'mp3' || fmt.id === 'ogg') && state.processed.sampleRate > 48000) note += ' 该格式上限 48 kHz，会自动重采样。';
    el.exportHint.textContent = note;
    el.exportHint.classList.remove('is-warn');
  }

  /* ------------------------------------------------------------------ */
  /* events                                                             */
  /* ------------------------------------------------------------------ */

  function bindEvents() {
    if (el.btnProcess) el.btnProcess.addEventListener('click', function () { processCurrent({ force: true }); });
    if (el.btnPlay) el.btnPlay.addEventListener('click', togglePlay);
    if (el.btnAb) el.btnAb.addEventListener('click', function () {
      if (!state.processedBuffer) return;
      var wasPlaying = state.playing;
      var pos = currentPosition();
      stopNode();
      state.abOriginal = !state.abOriginal;
      state.offset = pos;
      updatePlayUI();
      drawWave();
      if (wasPlaying) startPlayback();
    });
    if (el.btnClear) el.btnClear.addEventListener('click', clearSource);
    if (el.btnHeroDemo) el.btnHeroDemo.addEventListener('click', async function () {
      var demo = getDemo();
      var list = [];
      try { list = demo && demo.list ? demo.list() : []; } catch (e) { list = []; }
      if (!list.length) { toast('示例曲模块未加载。', true); return; }
      await loadDemo(list[0].id);
      var consoleEl = $('console');
      if (consoleEl) consoleEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    if (el.dropzone) {
      el.dropzone.addEventListener('click', function () { if (el.fileInput) el.fileInput.click(); });
      el.dropzone.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          if (el.fileInput) el.fileInput.click();
        }
      });
      el.dropzone.addEventListener('dragover', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        el.dropzone.classList.add('is-drag');
      });
      el.dropzone.addEventListener('dragleave', function () { el.dropzone.classList.remove('is-drag'); });
      el.dropzone.addEventListener('drop', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        el.dropzone.classList.remove('is-drag');
        hideDropOverlay();
        if (ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files.length) handleFile(ev.dataTransfer.files[0]);
      });
    }
    if (el.fileInput) {
      el.fileInput.addEventListener('change', function () {
        if (this.files && this.files.length) handleFile(this.files[0]);
        this.value = '';
      });
    }

    var dragDepth = 0;
    window.addEventListener('dragenter', function (ev) {
      if (!ev.dataTransfer || Array.prototype.indexOf.call(ev.dataTransfer.types || [], 'Files') < 0) return;
      ev.preventDefault();
      dragDepth++;
      showDropOverlay();
    });
    window.addEventListener('dragover', function (ev) {
      if (!ev.dataTransfer || Array.prototype.indexOf.call(ev.dataTransfer.types || [], 'Files') < 0) return;
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
    });
    window.addEventListener('dragleave', function (ev) {
      if (!ev.dataTransfer) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) hideDropOverlay();
    });
    window.addEventListener('drop', function (ev) {
      if (!ev.dataTransfer || !ev.dataTransfer.files || !ev.dataTransfer.files.length) return;
      ev.preventDefault();
      dragDepth = 0;
      hideDropOverlay();
      if (ev.target === el.dropzone) return;
      handleFile(ev.dataTransfer.files[0]);
    });

    if (el.seek) {
      el.seek.addEventListener('pointerdown', function () { state.seekDragging = true; });
      window.addEventListener('pointerup', function () { state.seekDragging = false; });
      el.seek.addEventListener('input', function () {
        if (!state.source) return;
        var ratio = Number(this.value) / 1000;
        if (state.playing) {
          // keep the drag smooth; seek on pointer release via change
          if (!state.seekDragging) seekToRatio(ratio);
        } else {
          seekToRatio(ratio);
        }
      });
      el.seek.addEventListener('change', function () {
        if (!state.source) return;
        seekToRatio(Number(this.value) / 1000);
      });
    }
    if (el.volume) {
      el.volume.addEventListener('input', function () {
        var v = clamp(Number(this.value) / 100, 0, 1);
        state.volume = v;
        if (el.volumeOut) el.volumeOut.textContent = Math.round(v * 100) + '%';
        if (state.master) state.master.gain.value = v;
        if (v > 0.8 && !state.volumeWarned) {
          state.volumeWarned = true;
          toast('音量已超过 80%。高响度素材容易伤耳，也容易让耳机失真。', true);
        }
      });
    }
    if (el.waveCanvas) {
      el.waveCanvas.addEventListener('pointerdown', function (ev) {
        if (!state.source) return;
        var rect = el.waveCanvas.getBoundingClientRect();
        var ratio = clamp((ev.clientX - rect.left) / rect.width, 0, 1);
        seekToRatio(ratio);
      });
    }
    if (el.formatGrid) {
      el.formatGrid.addEventListener('click', function (ev) {
        var card = ev.target.closest ? ev.target.closest('.format-card') : null;
        if (!card || card.disabled) return;
        selectFormat(card.getAttribute('data-format'));
      });
    }
    if (el.btnExportOne) el.btnExportOne.addEventListener('click', exportCurrent);
    if (el.btnExportAll) el.btnExportAll.addEventListener('click', exportAll);
    if (el.btnExportPng) el.btnExportPng.addEventListener('click', exportComparePng);
    if (el.sampleRate) el.sampleRate.addEventListener('change', updateExportHint);
    if (el.mp3Bitrate) el.mp3Bitrate.addEventListener('change', function () { /* options read at encode time */ });
    if (el.btnSafetyOk) el.btnSafetyOk.addEventListener('click', function () { closeSafety(true); });
    if (el.btnSafetyCancel) el.btnSafetyCancel.addEventListener('click', function () { closeSafety(false); });
    if (el.safetyModal) {
      el.safetyModal.addEventListener('click', function (ev) { if (ev.target === el.safetyModal) closeSafety(false); });
    }
    document.addEventListener('keydown', function (ev) {
      if (!el.safetyModal || el.safetyModal.hidden) {
        var tag = (ev.target && ev.target.tagName) || '';
        if (ev.code === 'Space' && tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT' && tag !== 'BUTTON' && !(ev.target && ev.target.isContentEditable)) {
          ev.preventDefault();
          togglePlay();
        }
        return;
      }
      if (ev.key === 'Escape') { ev.preventDefault(); closeSafety(false); }
    });
  }

  function showDropOverlay() { if (el.dropOverlay) el.dropOverlay.classList.add('is-active'); }
  function hideDropOverlay() { if (el.dropOverlay) el.dropOverlay.classList.remove('is-active'); }

  /* ------------------------------------------------------------------ */
  /* autotest + debug                                                   */
  /* ------------------------------------------------------------------ */

  async function runAutotest(mode) {
    var full = mode === 'full';
    console.log('[autotest] start mode=' + mode);
    state.safetyAccepted = true;
    var out = { ok: false, version: VERSION, mode: full ? 'full' : 'basic', presets: [], exports: {}, errors: [] };
    try {
      if (!getDSP()) throw new Error('ZaomaiDSP 未加载');
      if (!getDemo()) throw new Error('ZaomaiDemo 未加载');
      await loadDemo('neon-overdrive');
      if (!state.source) throw new Error('示例曲没有载入');
      if (!state.processed) throw new Error('示例曲没有自动渲染');
      out.demo = { name: state.source.name, duration: state.source.duration, sampleRate: state.source.sampleRate, channels: state.source.channels.length };
      var ids = getPresets().map(function (p) { return p.id; });
      var loopIds = full ? ids : [state.presetId];
      for (var i = 0; i < loopIds.length; i++) {
        if (loopIds[i] !== state.presetId) selectPreset(loopIds[i]);
        var r = await getProcessedFor(loopIds[i]);
        var s = r.stats || {};
        out.presets.push({ id: loopIds[i], lufs: s.lufs, truePeakDb: s.truePeakDb, peakDb: s.peakDb, rmsDb: s.rmsDb, crestDb: s.crestDb, processingMs: s.processingMs, duration: s.durationSec });
      }
      if (full) {
        var normal = state.cache.get('normal');
        var prepared = { channels: normal.channels, sampleRate: normal.sampleRate };
        var wav = await encodeBlob('wav16', prepared.channels, prepared.sampleRate, {}, null);
        out.exports.wav16 = { size: wav.size, type: wav.type };
        var mp3 = await encodeBlob('mp3', prepared.channels, prepared.sampleRate, { bitrate: 192 }, null);
        out.exports.mp3 = { size: mp3.size, type: mp3.type };
        var flac = await encodeBlob('flac', prepared.channels, prepared.sampleRate, {}, null);
        out.exports.flac = { size: flac.size, type: flac.type };
        if (formatSupported('ogg')) {
          try {
            var ogg = await encodeBlob('ogg', prepared.channels, prepared.sampleRate, { bitrate: 128 }, null);
            out.exports.ogg = { size: ogg.size, type: ogg.type };
          } catch (e) { out.errors.push('ogg: ' + e.message); }
        }
      }
      out.ok = true;
      document.body.setAttribute('data-autotest', 'done');
    } catch (e) {
      console.error(e);
      out.error = e && e.message ? e.message : String(e);
      document.body.setAttribute('data-autotest', 'error');
    }
    var pre = document.createElement('pre');
    pre.id = 'autotest-json';
    pre.style.cssText = 'position:absolute;left:-9999px;top:0;width:1px;height:1px;overflow:hidden;';
    pre.textContent = JSON.stringify(out);
    document.body.appendChild(pre);
    window.__AUTOTEST__ = out;
    console.log('[autotest] done ok=' + out.ok);
    var status = document.createElement('div');
    status.id = 'autotest-status';
    status.textContent = out.ok ? 'AUTOTEST PASS' : 'AUTOTEST FAIL';
    status.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:99999;font:11px monospace;color:' + (out.ok ? '#a6ff4d' : '#ff6b5a') + ';background:#111;padding:4px 8px;border:1px solid #333;';
    document.body.appendChild(status);
  }

  function init() {
    el = {
      toast: $('toast'),
      progress: $('export-progress'),
      progressLabel: $('progress-label'),
      progressPct: $('progress-pct'),
      progressBar: $('progress-bar'),
      progressSub: $('progress-sub'),
      presetGrid: $('preset-grid'),
      demoList: $('demo-list'),
      formatGrid: $('format-grid'),
      levelMatrix: $('level-matrix'),
      dropzone: $('dropzone'),
      fileInput: $('file-input'),
      sourceInfo: $('source-info'),
      sourceName: $('source-name'),
      sourceDur: $('source-dur'),
      sourceSr: $('source-sr'),
      sourceCh: $('source-ch'),
      sourceNote: $('source-note'),
      sourceStatus: $('source-status'),
      btnClear: $('btn-clear'),
      btnProcess: $('btn-process'),
      btnProcessLabel: document.querySelector('#btn-process .fire-btn-label'),
      procHint: $('proc-hint'),
      procElapsed: $('proc-elapsed'),
      chipSr: $('chip-sr'),
      chipDur: $('chip-dur'),
      chipLevel: $('chip-level'),
      btnPlay: $('btn-play'),
      playIcon: $('play-icon'),
      btnAb: $('btn-ab'),
      seek: $('seek'),
      volume: $('volume'),
      volumeOut: $('volume-out'),
      timeNow: $('time-now'),
      timeTotal: $('time-total'),
      waveCanvas: $('wave-canvas'),
      waveStage: $('wave-stage'),
      waveEmpty: $('wave-empty'),
      waveSub: $('wave-sub'),
      waveInfo: $('wave-info'),
      waveScale: $('wave-scale'),
      statLufsT: $('stat-lufs-t'),
      statTpT: $('stat-tp-t'),
      statsVerdict: $('stats-verdict'),
      statsPreset: $('stats-preset'),
      filename: $('filename'),
      sampleRate: $('sample-rate'),
      mp3Bitrate: $('mp3-bitrate'),
      btnExportOne: $('btn-export-one'),
      btnExportAll: $('btn-export-all'),
      btnExportPng: $('btn-export-png'),
      exportHint: $('export-hint'),
      heroCanvas: $('hero-canvas'),
      dropOverlay: $('drop-overlay'),
      safetyModal: $('safety-modal'),
      btnSafetyOk: $('btn-safety-ok'),
      btnSafetyCancel: $('btn-safety-cancel'),
      btnHeroDemo: $('btn-hero-demo')
    };

    renderPresets();
    renderDemos();
    renderFormats();
    renderLevels();
    bindEvents();
    initHero();
    initWaveSizing();
    updateSourceUI();
    updateWaveInfo();
    updatePlayUI();
    updateControls();
    resetStats();
    drawWave();

    if (!getDSP()) toast('DSP 引擎未加载：请确认 src/dsp.js 存在且没有语法错误。', true);
    if (!getExport()) toast('导出引擎未加载：请确认 src/exporters.js 存在。', true);
    if (!getDemo()) toast('示例曲模块未加载：请确认 src/demo-track.js 存在。', true);

    var query = new URLSearchParams(window.location.search);
    var mode = query.get('autotest');
    if (mode) {
      state.autoTestMode = mode;
      setTimeout(function () { runAutotest(mode); }, 120);
    }
  }

  window.ZaomaiApp = {
    version: VERSION,
    getPresets: getPresets,
    getFormats: getFormats,
    getState: function () {
      return {
        presetId: state.presetId,
        formatId: state.formatId,
        hasSource: !!state.source,
        hasProcessed: !!state.processed,
        processing: state.processing,
        exporting: state.exporting,
        source: state.source ? { name: state.source.name, duration: state.source.duration, sampleRate: state.source.sampleRate, channels: state.source.channels.length, isDemo: state.source.isDemo } : null,
        processed: state.processed ? { presetId: state.processed.presetId, stats: state.processed.stats } : null,
        cached: Array.from(state.cache.keys()),
        safetyAccepted: state.safetyAccepted
      };
    },
    loadDemo: loadDemo,
    loadFile: handleFile,
    selectPreset: selectPreset,
    processCurrent: processCurrent,
    exportCurrent: exportCurrent,
    exportAll: exportAll,
    exportComparePng: exportComparePng,
    encodeCurrent: async function (formatId, options) {
      if (!state.processed) throw new Error('还没有炸麦结果。');
      var sr = targetSampleRate(formatId);
      var ch = state.processed.channels;
      if (sr !== state.processed.sampleRate) ch = await resampleChannels(state.processed.channels, state.processed.sampleRate, sr);
      return encodeBlob(formatId, ch, sr, options || getFormatOptions(formatId), null);
    },
    makeCompareCanvas: makeCompareCanvas
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
