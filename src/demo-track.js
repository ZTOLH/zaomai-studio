/*!
 * ZAOMAI LAB - built-in demo track synthesizer
 * Pure JS, deterministic, no Web Audio dependency.
 * API: window.ZaomaiDemo = { list(), generate(id, sampleRate) }
 */
(function (root) {
  'use strict';

  var VERSION = '1.0.0';

  var TRACKS = [
    {
      id: 'neon-overdrive',
      name: '霓虹炸街',
      en: 'NEON OVERDRIVE',
      bpm: 128,
      bars: 12,
      tag: 'EDM / 4-ON-FLOOR',
      desc: '128 BPM 四踩底鼓、锯齿贝斯与霓虹主音，专门用来测试低频下潜和 3kHz 穿刺力。'
    },
    {
      id: 'cyber-firecracker',
      name: '电子鞭炮',
      en: 'CYBER FIRECRACKER',
      bpm: 150,
      bars: 12,
      tag: 'FESTIVAL / BASS',
      desc: '150 BPM 电子锣鼓与合成鞭炮，瞬态密集，最能检验鞭炮层的噼啪密度。'
    }
  ];

  function mulberry32(a) {
    return function () {
      a |= 0;
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function mtof(m) {
    return 440 * Math.pow(2, (m - 69) / 12);
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  }

  function makeCtx(sampleRate, seconds, seed) {
    var n = Math.ceil(seconds * sampleRate);
    return {
      sr: sampleRate,
      n: n,
      drums: [new Float32Array(n), new Float32Array(n)],
      music: [new Float32Array(n), new Float32Array(n)],
      fx: [new Float32Array(n), new Float32Array(n)],
      duck: new Float32Array(n),
      rng: mulberry32(seed)
    };
  }

  function panGains(p) {
    p = clamp(p, -1, 1);
    var a = (p + 1) * Math.PI / 4;
    return [Math.cos(a), Math.sin(a)];
  }

  function put(bus, i, v, gl, gr) {
    if (i < 0 || i >= bus[0].length) return;
    bus[0][i] += v * gl;
    bus[1][i] += v * gr;
  }

  function duckAt(ctx, startSample, depth, tauSec) {
    var len = Math.floor(ctx.sr * 0.5);
    var tau = Math.max(1, tauSec * ctx.sr);
    for (var j = 0; j < len; j++) {
      var idx = startSample + j;
      if (idx >= ctx.n) break;
      var g = 1 - depth * Math.exp(-j / tau);
      if (g < ctx.duck[idx]) ctx.duck[idx] = g;
    }
  }

  /* ------------------------------------------------------------------ */
  /* tonal voice: saw / square / triangle / sine, 2-pole SVF lowpass    */
  /* ------------------------------------------------------------------ */
  function tone(ctx, busName, t0, dur, freq, o) {
    o = o || {};
    var sr = ctx.sr;
    var n = Math.max(1, Math.floor(dur * sr));
    var start = Math.floor(t0 * sr);
    var bus = ctx[busName];
    var pan = o.pan == null ? 0 : o.pan;
    var pg = panGains(pan);
    var gain = o.gain == null ? 0.1 : o.gain;
    var wave = o.wave || 'saw';
    var attack = o.attack == null ? 0.004 : o.attack;
    var decay = o.decay == null ? 0.25 : o.decay;
    var sustain = o.sustain == null ? 0 : o.sustain;
    var release = o.release == null ? 0.02 : o.release;
    var drive = o.drive == null ? 1 : o.drive;
    var detune = o.detune == null ? 0 : o.detune;
    var vibRate = o.vibratoRate == null ? 0 : o.vibratoRate;
    var vibDepth = o.vibratoDepth == null ? 0 : o.vibratoDepth;
    var glide = o.glide == null ? 0 : o.glide;
    var cutoff0 = o.cutoff0 == null ? 12000 : o.cutoff0;
    var cutoff1 = o.cutoff1 == null ? cutoff0 : o.cutoff1;
    var q = o.q == null ? 0.8 : o.q;
    var f0 = mtof(freq);
    var f1 = f0 * Math.pow(2, glide / 12);
    var ratio = f1 / f0;
    var phase1 = 0;
    var phase2 = 0;
    var det = Math.pow(2, detune / 1200);
    var cutoff = cutoff0;
    var fcMul = Math.pow(cutoff1 / cutoff0, 1 / n);
    var amp = 1;
    var ampMul = Math.exp(-1 / Math.max(1, decay * sr));
    var relN = Math.max(1, Math.floor(release * sr));
    var atk = Math.max(1, Math.floor(attack * sr));
    var b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0;
    var x1 = 0, x2 = 0, y1 = 0, y2 = 0;

    function updateFilter(fc) {
      fc = Math.max(20, Math.min(fc, sr * 0.47));
      var w0 = 2 * Math.PI * fc / sr;
      var cw = Math.cos(w0);
      var sw = Math.sin(w0);
      var alpha = sw / (2 * Math.max(0.05, q));
      var a0 = 1 + alpha;
      b0 = (1 - cw) * 0.5 / a0;
      b1 = (1 - cw) / a0;
      b2 = b0;
      a1 = -2 * cw / a0;
      a2 = (1 - alpha) / a0;
    }
    updateFilter(cutoff0);

    for (var i = 0; i < n; i++) {
      var t = i / sr;
      var f = f0 * Math.pow(ratio, i / n);
      if (vibRate > 0) f *= 1 + vibDepth * Math.sin(2 * Math.PI * vibRate * t);

      var s1 = phase1;
      phase1 += f / sr;
      if (phase1 >= 1) phase1 -= Math.floor(phase1);
      var s2 = phase2;
      phase2 += (f * det) / sr;
      if (phase2 >= 1) phase2 -= Math.floor(phase2);

      var x;
      if (wave === 'sine') {
        x = Math.sin(2 * Math.PI * s1);
        if (detune) x = (x + Math.sin(2 * Math.PI * s2)) * 0.5;
      } else if (wave === 'square') {
        x = (s1 < 0.5 ? 1 : -1);
        if (detune) x = (x + (s2 < 0.5 ? 1 : -1)) * 0.5;
      } else if (wave === 'triangle') {
        x = 4 * Math.abs(s1 - 0.5) - 1;
        if (detune) x = (x + (4 * Math.abs(s2 - 0.5) - 1)) * 0.5;
      } else {
        x = 2 * s1 - 1;
        if (detune) x = (x + (2 * s2 - 1)) * 0.5;
      }

      cutoff *= fcMul;
      if ((i & 31) === 0) updateFilter(cutoff);
      var y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1;
      x1 = x;
      y2 = y1;
      y1 = y;
      x = y;

      if (drive !== 1) x = Math.tanh(x * drive);

      var env;
      if (i < atk) env = i / atk;
      else env = 1;
      var d = sustain + (1 - sustain) * amp;
      env *= d;
      if (i > n - relN) env *= (n - i) / relN;
      amp *= ampMul;

      put(bus, start + i, x * env * gain, pg[0], pg[1]);
    }
  }

  /* ------------------------------------------------------------------ */
  /* percussion                                                         */
  /* ------------------------------------------------------------------ */
  function kick(ctx, t0, gain, tune) {
    var sr = ctx.sr;
    var n = Math.floor(0.46 * sr);
    var start = Math.floor(t0 * sr);
    var phase = 0;
    var lp = 0;
    var base = tune == null ? 46 : tune;
    for (var i = 0; i < n; i++) {
      var t = i / sr;
      var f = base + 145 * Math.exp(-t / 0.028);
      phase += f / sr;
      var env = Math.exp(-t / 0.19);
      var click = (ctx.rng() * 2 - 1) * Math.exp(-t / 0.0025);
      var v = Math.sin(2 * Math.PI * phase) * env * 1.25 + click * 0.22;
      lp += 0.25 * (v - lp);
      v = Math.tanh(v * 1.7);
      put(ctx.drums, start + i, v * gain, 0.707, 0.707);
    }
    duckAt(ctx, start, 0.55, 0.095);
  }

  function snare(ctx, t0, gain, pan) {
    var sr = ctx.sr;
    var n = Math.floor(0.2 * sr);
    var start = Math.floor(t0 * sr);
    var pg = panGains(pan == null ? 0 : pan);
    var lp = 0;
    var phase = 0;
    for (var i = 0; i < n; i++) {
      var t = i / sr;
      var noise = ctx.rng() * 2 - 1;
      lp += 0.18 * (noise - lp);
      var hp = noise - lp;
      var body = Math.sin(2 * Math.PI * 185 * t) * Math.exp(-t / 0.055);
      var v = hp * Math.exp(-t / 0.075) * 0.9 + body * 0.5;
      v = Math.tanh(v * 1.3);
      put(ctx.drums, start + i, v * gain, pg[0], pg[1]);
    }
  }

  function clap(ctx, t0, gain, pan) {
    var sr = ctx.sr;
    var n = Math.floor(0.18 * sr);
    var start = Math.floor(t0 * sr);
    var pg = panGains(pan == null ? 0 : pan);
    var lp = 0;
    for (var i = 0; i < n; i++) {
      var t = i / sr;
      var noise = ctx.rng() * 2 - 1;
      lp += 0.3 * (noise - lp);
      var hp = noise - lp;
      var burst = Math.exp(-t / 0.012) + 0.7 * Math.exp(-Math.max(0, t - 0.012) / 0.012) + 0.5 * Math.exp(-Math.max(0, t - 0.024) / 0.018);
      var v = hp * burst * 0.75;
      put(ctx.drums, start + i, v * gain, pg[0], pg[1]);
    }
  }

  function hat(ctx, t0, gain, open, pan) {
    var sr = ctx.sr;
    var dur = open ? 0.16 : 0.045;
    var n = Math.floor(dur * sr);
    var start = Math.floor(t0 * sr);
    var pg = panGains(pan == null ? 0.1 : pan);
    var lp = 0;
    var hp2 = 0;
    for (var i = 0; i < n; i++) {
      var t = i / sr;
      var noise = ctx.rng() * 2 - 1;
      lp += 0.55 * (noise - lp);
      hp2 += 0.9 * ((noise - lp) - hp2);
      var v = (noise - lp - hp2) * Math.exp(-t / (open ? 0.06 : 0.012)) * 0.55;
      put(ctx.drums, start + i, v * gain, pg[0], pg[1]);
    }
  }

  function crash(ctx, t0, gain) {
    var sr = ctx.sr;
    var n = Math.floor(1.7 * sr);
    var start = Math.floor(t0 * sr);
    var lpL = 0, lpR = 0, hpL = 0, hpR = 0;
    for (var i = 0; i < n; i++) {
      var t = i / sr;
      var nl = ctx.rng() * 2 - 1;
      var nr = ctx.rng() * 2 - 1;
      lpL += 0.2 * (nl - lpL);
      lpR += 0.2 * (nr - lpR);
      hpL += 0.95 * ((nl - lpL) - hpL);
      hpR += 0.95 * ((nr - lpR) - hpR);
      var env = Math.exp(-t / 0.55);
      put(ctx.fx, start + i, (nl - lpL - hpL) * env * 0.45 * gain, 0.85, 0.55);
      put(ctx.fx, start + i, (nr - lpR - hpR) * env * 0.45 * gain, 0.55, 0.85);
    }
  }

  function impact(ctx, t0, gain) {
    var sr = ctx.sr;
    var n = Math.floor(1.1 * sr);
    var start = Math.floor(t0 * sr);
    var phase = 0;
    var lp = 0;
    for (var i = 0; i < n; i++) {
      var t = i / sr;
      var f = 32 + 55 * Math.exp(-t / 0.09);
      phase += f / sr;
      var env = Math.exp(-t / 0.32);
      var noise = ctx.rng() * 2 - 1;
      lp += 0.08 * (noise - lp);
      var v = Math.sin(2 * Math.PI * phase) * env * 1.4 + lp * Math.exp(-t / 0.12) * 1.6;
      put(ctx.fx, start + i, Math.tanh(v) * gain, 0.707, 0.707);
    }
    duckAt(ctx, start, 0.35, 0.16);
  }

  function riser(ctx, t0, dur, gain) {
    var sr = ctx.sr;
    var n = Math.floor(dur * sr);
    var start = Math.floor(t0 * sr);
    var lp = 0;
    var lp2 = 0;
    for (var i = 0; i < n; i++) {
      var t = i / sr;
      var p = i / n;
      var fc = 300 * Math.pow(30, p);
      var a = 1 - Math.exp(-2 * Math.PI * Math.min(fc, sr * 0.4) / sr);
      var noise = ctx.rng() * 2 - 1;
      lp += a * (noise - lp);
      lp2 += a * (lp - lp2);
      var amp = Math.pow(p, 1.7) * (1 - 0.25 * p);
      put(ctx.fx, start + i, lp2 * amp * gain, 0.7, 0.9);
    }
  }

  function gong(ctx, t0, gain) {
    var sr = ctx.sr;
    var n = Math.floor(2.4 * sr);
    var start = Math.floor(t0 * sr);
    var partials = [1, 1.47, 2.09, 2.56, 3.1, 4.17];
    var amps = [1, 0.62, 0.42, 0.3, 0.2, 0.12];
    var phases = [0, 0, 0, 0, 0, 0];
    var base = 92;
    for (var i = 0; i < n; i++) {
      var t = i / sr;
      var v = 0;
      for (var k = 0; k < partials.length; k++) {
        phases[k] += (base * partials[k]) / sr;
        v += Math.sin(2 * Math.PI * phases[k]) * amps[k] * Math.exp(-t / (1.4 / partials[k] + 0.12));
      }
      var strike = (ctx.rng() * 2 - 1) * Math.exp(-t / 0.02) * 0.5;
      v = Math.tanh((v * 0.6 + strike) * 1.3);
      put(ctx.fx, start + i, v * gain, 0.8, 0.6);
      put(ctx.fx, start + i, v * gain * 0.35, 0.6, 0.8);
    }
  }

  function firecrackerBurst(ctx, t0, count, spread, gain) {
    var sr = ctx.sr;
    for (var k = 0; k < count; k++) {
      var dt = ctx.rng() * spread;
      var start = Math.floor((t0 + dt) * sr);
      var dur = 0.006 + ctx.rng() * 0.02;
      var n = Math.max(1, Math.floor(dur * sr));
      var pan = ctx.rng() * 2 - 1;
      var pg = panGains(pan);
      var amp = gain * (0.25 + ctx.rng() * 0.75);
      var lp = 0;
      var hp = 0;
      for (var i = 0; i < n; i++) {
        var t = i / sr;
        var noise = ctx.rng() * 2 - 1;
        lp += 0.35 * (noise - lp);
        hp += 0.5 * ((noise - lp) - hp);
        var v = (noise - lp - hp) * Math.exp(-t / (dur * 0.35)) * 1.4;
        put(ctx.fx, start + i, v * amp, pg[0], pg[1]);
      }
    }
    var thumpStart = Math.floor(t0 * sr);
    var tn = Math.floor(0.09 * sr);
    var lp2 = 0;
    for (var j = 0; j < tn; j++) {
      var tt = j / sr;
      var nz = ctx.rng() * 2 - 1;
      lp2 += 0.12 * (nz - lp2);
      put(ctx.fx, thumpStart + j, lp2 * Math.exp(-tt / 0.025) * gain * 0.8, 0.707, 0.707);
    }
  }

  function vinyl(ctx, seconds) {
    var n = Math.floor(seconds * ctx.sr);
    var lp = 0;
    for (var i = 0; i < n; i++) {
      var noise = ctx.rng() * 2 - 1;
      lp += 0.4 * (noise - lp);
      put(ctx.fx, i, (noise - lp) * 0.0025, 0.707, 0.707);
    }
  }

  /* ------------------------------------------------------------------ */
  /* track A: neon overdrive                                            */
  /* ------------------------------------------------------------------ */
  function renderNeon(sr) {
    var bpm = 128;
    var beat = 60 / bpm;
    var barDur = beat * 4;
    var ctx = makeCtx(sr, barDur * 12, 0x4E454F4E);
    var roots = [45, 41, 48, 43];
    var chords = [
      [57, 60, 64],
      [53, 57, 60],
      [48, 52, 55],
      [55, 59, 62]
    ];
    var bar, step, t;

    vinyl(ctx, barDur * 12);

    for (bar = 0; bar < 12; bar++) {
      var tBar = bar * barDur;
      var ci = bar % 4;
      var root = roots[ci];
      var chord = chords[ci];
      var inDrop = bar >= 6 && bar < 10;
      var inOutro = bar >= 10;
      var padGain = inDrop ? 0.05 : 0.04;
      var padCut = bar < 4 ? 520 + bar * 120 : (bar < 6 ? 1400 : 2400);

      for (var c = 0; c < 3; c++) {
        tone(ctx, 'music', tBar, barDur * 0.96, chord[c], {
          wave: 'saw', gain: padGain, pan: (c - 1) * 0.45, detune: 9,
          attack: 0.06, decay: 1.8, sustain: 0.55, release: 0.18,
          cutoff0: padCut, cutoff1: padCut * 0.8, q: 0.9, drive: 1.1
        });
      }
      tone(ctx, 'music', tBar, barDur * 0.9, root - 12, {
        wave: 'sine', gain: 0.035, attack: 0.01, decay: 2.2, sustain: 0.4, release: 0.2
      });

      if (bar >= 2 && !(bar === 5 && false)) {
        var pattern = [0, 0, 12, 0, 0, 12, 7, 0];
        for (step = 0; step < 8; step++) {
          if (bar === 5 && step >= 6) continue;
          if (bar === 11 && step >= 4) continue;
          t = tBar + step * beat / 2;
          var note = root + pattern[step];
          tone(ctx, 'music', t, beat * 0.42, note, {
            wave: 'saw', gain: inDrop ? 0.12 : 0.085, pan: 0, detune: 0,
            attack: 0.003, decay: 0.16, sustain: 0.05, release: 0.03,
            cutoff0: inDrop ? 420 : 300, cutoff1: 90, q: 1.1, drive: 2.2
          });
          tone(ctx, 'music', t, beat * 0.38, root - 24, {
            wave: 'sine', gain: inDrop ? 0.1 : 0.07, attack: 0.002, decay: 0.2, sustain: 0.1, release: 0.04
          });
        }
      }

      if (bar < 5 || bar === 11) {
        for (var b = 0; b < 4; b++) {
          if (bar === 5 && b >= 2) continue;
          kick(ctx, tBar + b * beat, bar < 2 ? 0.55 : 0.68, 45);
        }
      }
      if (inDrop || inOutro) {
        for (var b2 = 0; b2 < 4; b2++) {
          if (bar === 11 && b2 >= 2) continue;
          kick(ctx, tBar + b2 * beat, 0.95, 43);
        }
        clap(ctx, tBar + beat, 0.32, -0.12);
        clap(ctx, tBar + 3 * beat, 0.32, 0.12);
      }

      if (bar >= 1) {
        var hatStep = inDrop ? 0.5 : 1;
        for (var hs = 0; hs < 8; hs += hatStep > 0.5 ? 1 : 2) {
          if (bar === 5 && hs >= 4) continue;
          hat(ctx, tBar + hs * beat / 2, inDrop ? 0.12 : 0.08, hs % 4 === 3, -0.25);
        }
        if (inDrop) {
          for (var hh = 0; hh < 8; hh++) {
            hat(ctx, tBar + hh * beat / 2 + beat / 4, 0.04, false, 0.35);
          }
        }
      }

      if ((bar >= 2 && bar < 5) || inDrop || inOutro) {
        if (bar !== 5 || true) {
          snare(ctx, tBar + beat, 0.28, -0.05);
          snare(ctx, tBar + 3 * beat, 0.28, 0.05);
        }
      }
    }

    for (var i = 0; i < 32; i++) {
      var tt = (4 * barDur) + (i / 16) * barDur * 2;
      if (tt >= 6 * barDur) break;
      snare(ctx, tt, 0.06 + 0.18 * (i / 32), (i % 2) * 0.3 - 0.15);
    }
    riser(ctx, 4 * barDur + 2 * beat, barDur * 2 - 2 * beat, 0.11);
    impact(ctx, 6 * barDur, 0.55);
    crash(ctx, 6 * barDur, 0.5);
    crash(ctx, 10 * barDur, 0.45);

    var hookA = [
      [69, 0], [72, 0.5], [76, 1], [74, 1.5], [72, 2], [69, 2.5], [67, 3], [69, 3.5]
    ];
    var hookB = [
      [72, 0], [74, 0.5], [76, 1], [79, 1.5], [76, 2], [74, 2.5], [72, 3], [69, 3.5]
    ];
    var hookC = [
      [76, 0], [79, 0.5], [81, 1], [79, 1.5], [76, 2], [74, 2.5], [72, 3], [74, 3.5]
    ];
    var hooks = [hookA, hookB, hookA, hookC];

    for (var hb = 0; hb < 4; hb++) {
      var baseT = (6 + hb) * barDur;
      var hook = hooks[hb];
      for (var hn = 0; hn < hook.length; hn++) {
        var nt = baseT + hook[hn][1] * beat;
        var midi = hook[hn][0] + (hb === 3 && hn < 3 ? 12 : 0);
        leadNote(ctx, nt, midi, 0.17, 0.115);
        if (hn % 2 === 0) leadNote(ctx, nt + beat * 0.375, midi, 0.1, 0.028);
      }
    }
    for (var hn2 = 0; hn2 < 4; hn2++) {
      leadNote(ctx, 10 * barDur + hn2 * beat, [81, 79, 76, 72][hn2], 0.2, 0.1);
    }
    leadNote(ctx, 11 * barDur, 69, 1.2, 0.06);

    return finalize(ctx, 0.92);
  }

  function leadNote(ctx, t0, midi, dur, gain) {
    tone(ctx, 'music', t0, dur, midi, {
      wave: 'saw', gain: gain, pan: 0.08, detune: 12, vibratoRate: 5.5, vibratoDepth: 0.004,
      attack: 0.004, decay: 0.16, sustain: 0.12, release: 0.04,
      cutoff0: 5200, cutoff1: 1800, q: 0.9, drive: 1.6
    });
    tone(ctx, 'music', t0, dur, midi + 12, {
      wave: 'square', gain: gain * 0.35, pan: -0.12, attack: 0.004, decay: 0.12,
      sustain: 0.08, release: 0.03, cutoff0: 4200, cutoff1: 1200
    });
  }

  /* ------------------------------------------------------------------ */
  /* track B: cyber firecracker                                         */
  /* ------------------------------------------------------------------ */
  function renderFirecracker(sr) {
    var bpm = 150;
    var beat = 60 / bpm;
    var barDur = beat * 4;
    var ctx = makeCtx(sr, barDur * 12, 0x46495245);
    var roots = [38, 34, 41, 36];
    var chords = [
      [50, 53, 57],
      [46, 50, 53],
      [53, 57, 60],
      [48, 52, 55]
    ];
    var bar, step, t;

    vinyl(ctx, barDur * 12);
    gong(ctx, 0, 0.5);
    gong(ctx, 6 * barDur, 0.42);
    gong(ctx, 10 * barDur, 0.55);

    for (bar = 0; bar < 12; bar++) {
      var tBar = bar * barDur;
      var ci = bar % 4;
      var root = roots[ci];
      var chord = chords[ci];
      var drop = bar >= 6 && bar < 10;
      var outro = bar >= 10;

      for (var c = 0; c < 3; c++) {
        tone(ctx, 'music', tBar, barDur * 0.9, chord[c], {
          wave: 'triangle', gain: 0.035, pan: (c - 1) * 0.5, detune: 6,
          attack: 0.08, decay: 1.6, sustain: 0.4, release: 0.2,
          cutoff0: 1300, cutoff1: 900, q: 0.7
        });
      }

      if (bar >= 2 && bar < 11) {
        var bassPat = [0, 0, 7, 0, 12, 0, 7, 0];
        for (step = 0; step < 8; step++) {
          if (bar === 11) break;
          t = tBar + step * beat / 2;
          tone(ctx, 'music', t, beat * 0.4, root + bassPat[step], {
            wave: 'square', gain: drop ? 0.1 : 0.075, attack: 0.003, decay: 0.15,
            sustain: 0.08, release: 0.03, cutoff0: drop ? 360 : 260, cutoff1: 90, q: 1.2, drive: 2
          });
          tone(ctx, 'music', t, beat * 0.36, root - 12, {
            wave: 'sine', gain: drop ? 0.11 : 0.08, attack: 0.002, decay: 0.2, sustain: 0.1, release: 0.04
          });
        }
      }

      var beats = (bar < 2) ? [0, 2] : [0, 1, 2, 3];
      for (var bi = 0; bi < beats.length; bi++) {
        taiko(ctx, tBar + beats[bi] * beat, drop ? 0.8 : 0.55, 0.0);
      }
      if (drop) {
        taiko(ctx, tBar + 1.5 * beat, 0.28, -0.25);
        taiko(ctx, tBar + 3.5 * beat, 0.28, 0.25);
        clap(ctx, tBar + beat, 0.25, -0.1);
        clap(ctx, tBar + 3 * beat, 0.25, 0.1);
      }
      if (bar >= 2) {
        for (var hs = 0; hs < 8; hs++) {
          hat(ctx, tBar + hs * beat / 2, drop ? 0.085 : 0.06, hs % 4 === 3, 0.2);
        }
      }

      if (bar >= 2 && bar < 6) {
        var penta = [74, 77, 79, 81, 79, 77, 74, 72];
        for (var pn = 0; pn < 8; pn++) {
          if (bar === 5 && pn >= 5) break;
          pluck(ctx, tBar + pn * beat / 2, penta[(pn + bar) % penta.length], 0.07);
        }
      }
      if (drop || outro) {
        var leadLine = [[74, 0], [77, 0.5], [81, 1], [79, 1.5], [77, 2], [74, 2.5], [72, 3], [74, 3.5]];
        for (var ln = 0; ln < leadLine.length; ln++) {
          var lt = tBar + leadLine[ln][1] * beat;
          pluck(ctx, lt, leadLine[ln][0] + (drop ? 12 : 0), 0.085);
          if (ln % 2 === 1) pluck(ctx, lt + beat * 0.375, leadLine[ln][0] + 12, 0.025);
        }
      }
    }

    var burstBars = [1, 3, 5, 6, 7, 8, 9, 10, 11];
    for (var bb = 0; bb < burstBars.length; bb++) {
      var bt = burstBars[bb] * barDur - beat * 0.12;
      var count = burstBars[bb] >= 6 ? 42 : 24;
      firecrackerBurst(ctx, bt, count, beat * 0.9, 0.18);
    }
    for (var rd = 0; rd < 24; rd++) {
      var rt = (6 * barDur) + ctx.rng() * (4 * barDur);
      firecrackerBurst(ctx, rt, 3 + Math.floor(ctx.rng() * 5), 0.05, 0.08);
    }

    crash(ctx, 6 * barDur, 0.42);
    impact(ctx, 6 * barDur, 0.45);
    riser(ctx, 4 * barDur + 2 * beat, barDur * 2 - 2 * beat, 0.09);

    return finalize(ctx, 0.92);
  }

  function taiko(ctx, t0, gain, pan) {
    var sr = ctx.sr;
    var n = Math.floor(0.38 * sr);
    var start = Math.floor(t0 * sr);
    var pg = panGains(pan == null ? 0 : pan);
    var phase = 0;
    var lp = 0;
    for (var i = 0; i < n; i++) {
      var t = i / sr;
      var f = 58 + 90 * Math.exp(-t / 0.04);
      phase += f / sr;
      var env = Math.exp(-t / 0.16);
      var nz = ctx.rng() * 2 - 1;
      lp += 0.1 * (nz - lp);
      var v = Math.sin(2 * Math.PI * phase) * env + lp * Math.exp(-t / 0.03) * 1.3;
      v = Math.tanh(v * 1.5);
      put(ctx.drums, start + i, v * gain, pg[0], pg[1]);
    }
    duckAt(ctx, start, 0.3, 0.1);
  }

  function pluck(ctx, t0, midi, gain) {
    tone(ctx, 'music', t0, 0.22, midi, {
      wave: 'square', gain: gain, pan: (midi % 3 - 1) * 0.25,
      attack: 0.002, decay: 0.07, sustain: 0.02, release: 0.03,
      cutoff0: 7000, cutoff1: 900, q: 1.2, drive: 1.2
    });
    tone(ctx, 'music', t0, 0.18, midi + 12, {
      wave: 'triangle', gain: gain * 0.45, pan: 0.15, attack: 0.002, decay: 0.05,
      sustain: 0.01, release: 0.02, cutoff0: 9000, cutoff1: 2000
    });
  }

  /* ------------------------------------------------------------------ */
  /* mixdown                                                            */
  /* ------------------------------------------------------------------ */
  function finalize(ctx, targetPeak) {
    var n = ctx.n;
    var sr = ctx.sr;
    var outL = new Float32Array(n);
    var outR = new Float32Array(n);
    var dcL = 0, dcR = 0, xL = 0, xR = 0;
    var peak = 0;
    for (var i = 0; i < n; i++) {
      var d = ctx.duck[i];
      var l = ctx.drums[0][i] + ctx.music[0][i] * d + ctx.fx[0][i];
      var r = ctx.drums[1][i] + ctx.music[1][i] * d + ctx.fx[1][i];
      xL = l - dcL + 0.995 * xL;
      xR = r - dcR + 0.995 * xR;
      dcL = l;
      dcR = r;
      l = Math.tanh(xL * 1.1);
      r = Math.tanh(xR * 1.1);
      outL[i] = l;
      outR[i] = r;
      var a = Math.abs(l);
      var b = Math.abs(r);
      if (a > peak) peak = a;
      if (b > peak) peak = b;
    }
    if (peak > 1e-9) {
      var g = targetPeak / peak;
      for (var j = 0; j < n; j++) {
        outL[j] *= g;
        outR[j] *= g;
      }
    }
    var fade = Math.max(1, Math.floor(sr * 0.008));
    for (var k = 0; k < fade; k++) {
      var f = k / fade;
      outL[k] *= f;
      outR[k] *= f;
      outL[n - 1 - k] *= f;
      outR[n - 1 - k] *= f;
    }
    return [outL, outR];
  }

  /* ------------------------------------------------------------------ */
  /* public API                                                         */
  /* ------------------------------------------------------------------ */
  function list() {
    var out = [];
    for (var i = 0; i < TRACKS.length; i++) {
      var t = TRACKS[i];
      out.push({
        id: t.id, name: t.name, en: t.en, bpm: t.bpm, bars: t.bars,
        tag: t.tag, desc: t.desc
      });
    }
    return out;
  }

  function generate(id, sampleRate) {
    var def = null;
    for (var i = 0; i < TRACKS.length; i++) {
      if (TRACKS[i].id === id) { def = TRACKS[i]; break; }
    }
    if (!def) throw new Error('未知示例曲目: ' + id);
    var sr = Math.round(sampleRate || 48000);
    if (!(sr >= 22050 && sr <= 96000)) throw new Error('不支持的采样率: ' + sampleRate);
    var channels;
    if (def.id === 'neon-overdrive') channels = renderNeon(sr);
    else channels = renderFirecracker(sr);
    return {
      id: def.id,
      name: def.name,
      en: def.en,
      bpm: def.bpm,
      sampleRate: sr,
      channels: channels,
      duration: channels[0].length / sr
    };
  }

  var api = { version: VERSION, list: list, generate: generate };
  root.ZaomaiDemo = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
