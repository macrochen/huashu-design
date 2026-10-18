#!/usr/bin/env node
/**
 * narrate-pipeline.mjs · L2 长解说总指挥
 *
 * 输入：markdown 解说稿（## scene-id 分段，[[cue:id]] 标关键句）
 * 输出：voiceover.mp3（拼接好的整段人声）+ timeline.json（每段 start/end + cues 绝对时间）
 *
 * 用法：
 *   node scripts/narrate-pipeline.mjs --script demo.md --out-dir _narration_demo
 *
 * 解说稿格式：
 *   ---
 *   title: 什么是 LLM
 *   tts: edge            # 可选：edge（默认，免费免 key）| doubao
 *   voice: zh-CN-XiaoxiaoNeural   # 可选，不填用该引擎的默认音色
 *   speed: 1.0           # 可选
 *   gap: 0.3             # 段间静音秒数，默认 0.3
 *   ---
 *
 *   ## intro
 *   大家好，我是花叔。今天我们 5 分钟讲清楚 LLM 是什么。
 *
 *   ## what-is
 *   LLM 全称 Large Language Model，[[cue:bigmodel]]它是一个有几千亿参数的神经网络。
 *   本质是一个文字接龙的预测器。
 *
 * 输出文件结构（out-dir 下）：
 *   audio/
 *     intro.mp3
 *     what-is.mp3
 *   voiceover.mp3       拼接全部 scene 的整段人声
 *   timeline.json       schema 见 references/voiceover-pipeline.md
 *
 * 依赖：edge-tts>=7.3（默认引擎，pip install -U "edge-tts>=7.3"）；
 *       豆包引擎额外要自备 key；ffmpeg、ffprobe
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(__dirname, '..');

// 引擎注册表。edge 是默认：免费、无需 key、无需 .env
const ENGINES = {
  edge: {
    script: path.join(__dirname, 'edge', 'tts-edge.mjs'),
    label: 'Microsoft Edge TTS',
    host: 'speech.platform.bing.com',
    needsConsent: false, // 免费、无需 key，不拦确认门
    defaultVoice: 'zh-CN-XiaoxiaoNeural',
  },
  doubao: {
    script: path.join(__dirname, 'cloud', 'tts-doubao.mjs'),
    label: '豆包 TTS 官方接口',
    host: 'openspeech.bytedance.com',
    needsConsent: true, // 用你自己的 key，需显式确认
    defaultVoice: null, // 走 .env
  },
};
const DEFAULT_ENGINE = 'edge';

let ENGINE = ENGINES[DEFAULT_ENGINE]; // main() 里按参数/前端元信息覆盖

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--script') args.script = argv[++i];
    else if (a === '--out-dir') args.outDir = argv[++i];
    else if (a === '--tts') args.tts = argv[++i];
    else if (a === '--no-timestamps') args.noTimestamps = true;
    else if (a === '--yes') args.yes = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function usage() {
  console.error(`
narrate-pipeline.mjs · L2 长解说总指挥

  --script <path>     解说稿 .md 文件（必填）
  --out-dir <path>    输出目录（必填）
  --tts <engine>      语音引擎：edge（默认，免费免 key）| doubao（需自备 key）
  --no-timestamps     不请求字级时间戳（默认请求，chunks 里带 words 供卡拉OK字幕）
  --yes               仅 doubao 引擎需要：确认把文本发到豆包接口（或设 HUASHU_CLOUD_OK=1）

引擎也可用解说稿 frontmatter 的 tts: 指定，优先级 --tts > frontmatter > 默认(edge)。

输出：<out-dir>/voiceover.mp3 + <out-dir>/timeline.json
`.trim());
  process.exit(1);
}

/**
 * Parse frontmatter + scene blocks from markdown
 * Returns { meta, scenes: [{ id, raw }] }
 */
function parseScript(md) {
  const meta = {};
  let body = md;
  const fmMatch = md.match(/^---\n([\s\S]*?)\n---\n/);
  if (fmMatch) {
    for (const line of fmMatch[1].split('\n')) {
      const idx = line.indexOf(':');
      if (idx < 0) continue;
      const key = line.slice(0, idx).trim();
      const val = line.slice(idx + 1).trim();
      meta[key] = val;
    }
    body = md.slice(fmMatch[0].length);
  }
  const scenes = [];
  const re = /^##\s+([\w-]+)\s*\n([\s\S]*?)(?=^##\s+[\w-]+\s*\n|$(?![\r\n]))/gm;
  let m;
  while ((m = re.exec(body)) !== null) {
    scenes.push({ id: m[1], raw: m[2].trim() });
  }
  return { meta, scenes };
}

/**
 * Split a scene's text by [[cue:id]] markers into chunks.
 * Returns: { chunks: [{ text, cueAfter? }] }
 *   cueAfter is the cue id that follows this chunk (chunk's end = cue position)
 *
 * Example: "A[[cue:x]]B[[cue:y]]C" =>
 *   chunks: [
 *     { text: "A", cueAfter: "x" },
 *     { text: "B", cueAfter: "y" },
 *     { text: "C" }
 *   ]
 */
function splitByCues(text) {
  const chunks = [];
  const re = /\[\[cue:([\w-]+)\]\]/g;
  let lastIdx = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    const before = text.slice(lastIdx, m.index).trim();
    chunks.push({ text: before, cueAfter: m[1] });
    lastIdx = m.index + m[0].length;
  }
  const tail = text.slice(lastIdx).trim();
  chunks.push({ text: tail });
  // 过滤空文本块（cue 紧贴段首/段尾时）
  return chunks.filter((c) => c.text.length > 0 || c.cueAfter);
}

function getDuration(filePath) {
  const out = execFileSync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath,
  ], { encoding: 'utf8' });
  return parseFloat(out.trim());
}

let timestampsBroken = false; // 时间戳请求失败一次后，后续 chunk 全部降级，避免反复重试

function callTTS(text, outPath, opts) {
  // doubao 的同意门已在本管线入口过（见 main），子进程直接带 --yes
  // edge 不需要 key 也不需要确认，--yes 只是兼容参数
  const args = ['--text', text, '--out', outPath, '--yes'];
  if (opts.voice) args.push('--voice', opts.voice);
  if (opts.speed) args.push('--speed', String(opts.speed));
  const wantTimestamps = opts.timestamps && !timestampsBroken;
  if (wantTimestamps) args.push('--timestamps');
  try {
    const out = execFileSync('node', [ENGINE.script, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    return JSON.parse(out.trim());
  } catch (e) {
    // exit 3 = 缺依赖，exit 4 = 握手被拒（版本太旧）。这两种降级重试只会再失败一次
    // 并掩盖真正原因，直接抛出去，把修复动作说清楚。
    if (e.status === 3 || e.status === 4) {
      throw new Error(e.status === 3
        ? 'TTS 依赖缺失：edge 引擎需要 `pip install -U "edge-tts>=7.3"`。' +
          '若装在其他解释器里，用 HUASHU_PYTHON=/path/to/python3 指定。'
        : 'TTS 握手被拒（403）：edge-tts 版本太旧，升级 `pip install -U "edge-tts>=7.3"`。');
    }
    if (!wantTimestamps) throw e;
    // 字级时间戳可能不被当前音色/引擎支持——降级重试，不带时间戳
    timestampsBroken = true;
    console.error('[narrate] ⚠ 带 --timestamps 的 TTS 失败，降级为无时间戳模式（timeline 不含 words，卡拉OK字幕不可用）');
    const out = execFileSync('node', [ENGINE.script, ...args.filter((a) => a !== '--timestamps')], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    return JSON.parse(out.trim());
  }
}

function ffmpegConcat(inputs, output) {
  // 用 concat demuxer 合并相同编码的 mp3
  const listFile = output + '.list';
  fs.writeFileSync(
    listFile,
    inputs.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'),
  );
  execFileSync(
    'ffmpeg',
    ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', output],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  fs.unlinkSync(listFile);
}

function makeSilence(duration, outPath) {
  execFileSync(
    'ffmpeg',
    ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', String(duration),
     '-q:a', '9', '-acodec', 'libmp3lame', outPath],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.script || !args.outDir) usage();

  const scriptPath = path.resolve(args.script);
  const outDir = path.resolve(args.outDir);
  const audioDir = path.join(outDir, 'audio');
  const tmpDir = path.join(outDir, '.tmp');

  const md = fs.readFileSync(scriptPath, 'utf8');
  const { meta, scenes } = parseScript(md);
  if (scenes.length === 0) {
    console.error('错：解说稿没有 ## scene 段，至少一段。');
    process.exit(1);
  }

  // 引擎：--tts > frontmatter tts: > 默认 edge
  const engineName = (args.tts || meta.tts || DEFAULT_ENGINE).toLowerCase();
  if (!ENGINES[engineName]) {
    console.error(`错：未知引擎 "${engineName}"，可选：${Object.keys(ENGINES).join(' | ')}`);
    process.exit(1);
  }
  ENGINE = ENGINES[engineName];

  // 只有需要 key 的云引擎才拦确认门；edge 免费免 key，只做一句数据流向提示
  if (ENGINE.needsConsent && !args.yes && process.env.HUASHU_CLOUD_OK !== '1') {
    console.error(
      `[云能力确认] --tts=doubao 会把解说稿文本分段发送到${ENGINE.label}（${ENGINE.host}，` +
      '使用你自己的 key 合成配音）。\n' +
      '确认无误请重跑并加 --yes，或设置环境变量 HUASHU_CLOUD_OK=1。' +
      '数据流向声明见 SECURITY.md。',
    );
    process.exit(2);
  }

  fs.mkdirSync(audioDir, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  const voice = meta.voice || ENGINE.defaultVoice || undefined;
  const speed = meta.speed ? parseFloat(meta.speed) : 1.0;
  const gap = meta.gap ? parseFloat(meta.gap) : 0.3;
  const timestamps = !args.noTimestamps && meta.timestamps !== 'false';

  console.error(`[narrate] 引擎=${engineName}（${ENGINE.label} · ${ENGINE.host}）`);
  if (!ENGINE.needsConsent) {
    console.error('[narrate] 提示：仅把待配音文本发到微软朗读服务，免费、无需账号、不上传其他信息。');
  }
  console.error(`[narrate] script=${path.basename(scriptPath)} scenes=${scenes.length} voice=${voice || '(env)'} speed=${speed} gap=${gap}s`);

  // 段间静音文件（共用一个）
  const gapFile = path.join(tmpDir, 'gap.mp3');
  if (gap > 0) makeSilence(gap, gapFile);

  const timeline = {
    title: meta.title || path.basename(scriptPath, '.md'),
    tts: engineName,
    voice: voice || null,
    speed,
    gap,
    totalDuration: 0,
    scenes: [],
  };

  let cursor = 0;
  const sceneAudioFiles = [];

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    console.error(`[narrate] (${i + 1}/${scenes.length}) scene="${scene.id}"`);

    const chunks = splitByCues(scene.raw);
    const chunkFiles = [];
    const cueRecords = [];
    const chunkRecords = []; // 每个 chunk 的实测 start/end 段内时间，用于字幕显示
    let sceneInternalCursor = 0;

    for (let j = 0; j < chunks.length; j++) {
      const chunk = chunks[j];
      if (!chunk.text) {
        // 空文本块（cue 紧贴），跳过 TTS 但仍记录 cue 位置
        if (chunk.cueAfter) {
          cueRecords.push({
            id: chunk.cueAfter,
            offset: sceneInternalCursor,
          });
        }
        continue;
      }
      const chunkPath = path.join(tmpDir, `${scene.id}-${j}.mp3`);
      const result = callTTS(chunk.text, chunkPath, { voice, speed, timestamps });
      const chunkStart = sceneInternalCursor;
      chunkFiles.push(chunkPath);
      sceneInternalCursor += result.duration;
      chunkRecords.push({
        text: chunk.text,
        start: chunkStart,
        end: sceneInternalCursor,
        duration: result.duration,
        // 字级时间戳（TTS 实测，TN 后文本）：换算成段内相对时间
        words: (result.words || []).map((w) => ({
          text: w.text,
          start: chunkStart + w.start,
          end: chunkStart + w.end,
        })),
      });
      console.error(`  chunk ${j}: ${result.duration.toFixed(2)}s · ${chunk.text.length} 字 · ${chunk.text.slice(0, 30)}${chunk.text.length > 30 ? '…' : ''}`);
      if (chunk.cueAfter) {
        cueRecords.push({
          id: chunk.cueAfter,
          offset: sceneInternalCursor,
        });
      }
    }

    // 合并段内子段
    const sceneAudio = path.join(audioDir, `${scene.id}.mp3`);
    if (chunkFiles.length === 1) {
      fs.copyFileSync(chunkFiles[0], sceneAudio);
    } else {
      ffmpegConcat(chunkFiles, sceneAudio);
    }
    const sceneDuration = getDuration(sceneAudio);

    // 拼接到总轨：先加 gap（除了第一段），再加 scene
    if (i > 0 && gap > 0) {
      sceneAudioFiles.push(gapFile);
      cursor += gap;
    }
    sceneAudioFiles.push(sceneAudio);

    timeline.scenes.push({
      id: scene.id,
      start: cursor,
      end: cursor + sceneDuration,
      duration: sceneDuration,
      audio: path.relative(outDir, sceneAudio),
      text: scene.raw.replace(/\[\[cue:[\w-]+\]\]/g, ''),
      // chunks: 用于字幕逐句显示。start/end 是段内相对时间，absoluteStart/absoluteEnd 是整轨绝对时间
      // words: 字级时间戳（卡拉OK字幕用；TN 后文本，可能与 chunk.text 不完全一致）。空数组=不可用
      chunks: chunkRecords.map((c) => ({
        text: c.text,
        start: c.start,
        end: c.end,
        absoluteStart: cursor + c.start,
        absoluteEnd: cursor + c.end,
        words: (c.words || []).map((w) => ({
          text: w.text,
          start: w.start,
          end: w.end,
          absoluteStart: cursor + w.start,
          absoluteEnd: cursor + w.end,
        })),
      })),
      cues: cueRecords.map((c) => ({
        id: c.id,
        offset: c.offset,
        absoluteTime: cursor + c.offset,
      })),
    });

    cursor += sceneDuration;
  }

  // 合并整轨
  const voiceoverPath = path.join(outDir, 'voiceover.mp3');
  ffmpegConcat(sceneAudioFiles, voiceoverPath);
  timeline.totalDuration = getDuration(voiceoverPath);
  timeline.voiceover = 'voiceover.mp3';

  fs.writeFileSync(
    path.join(outDir, 'timeline.json'),
    JSON.stringify(timeline, null, 2),
  );

  // 清理 tmp
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.error(`\n[narrate] 完成。`);
  console.error(`  voiceover: ${voiceoverPath}`);
  console.error(`  timeline:  ${path.join(outDir, 'timeline.json')}`);
  console.error(`  总时长:    ${timeline.totalDuration.toFixed(2)}s (${(timeline.totalDuration / 60).toFixed(2)} min)`);
  console.error(`  段数:      ${timeline.scenes.length}`);
  const totalCues = timeline.scenes.reduce((sum, s) => sum + s.cues.length, 0);
  console.error(`  cue 数:    ${totalCues}`);
  const totalWords = timeline.scenes.reduce(
    (sum, s) => sum + s.chunks.reduce((a, c) => a + (c.words ? c.words.length : 0), 0), 0);
  console.error(`  字级时间戳: ${totalWords > 0 ? `${totalWords} words（<Subtitles karaoke /> 可用）` : '无'}`);
}

main().catch((err) => {
  console.error(`narrate-pipeline 失败：${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
