#!/usr/bin/env node
/**
 * tts-edge.mjs · Microsoft Edge TTS（免费，无需 API key）
 *
 * 音源是 Edge 浏览器「大声朗读」背后的同一个神经语音服务（Microsoft Azure 的
 * 消费级端点）。不需要注册、不需要 key、不产生费用。
 *
 * ⚠️ 数据流向：待配音文本会发送到微软的 Edge 朗读服务（speech.platform.bing.com）。
 * 不涉及账号、密钥、计费；本脚本不收集任何其他信息。声明见仓库根 SECURITY.md。
 *
 * 用法：
 *   node scripts/edge/tts-edge.mjs --text "你好" --out demo.mp3
 *   node scripts/edge/tts-edge.mjs --text-file script.txt --out out.mp3 --speed 0.92
 *   node scripts/edge/tts-edge.mjs --text "你好" --out demo.mp3 --timestamps
 *
 * 输出：
 *   - mp3 文件写到 --out 路径（统一为 24kHz / 单声道，便于与豆包产物混拼）
 *   - stdout 打印一行 JSON: {"path":"...","duration":12.34,"bytes":54321}
 *   - 带 --timestamps 时额外含 words: [{text,start,end}]（秒，相对本段音频开头）
 *
 * 依赖：python3 + `pip install -U "edge-tts>=7.3"`、ffmpeg/ffprobe
 *   （低于 7.3 会因微软 Sec-MS-GEC 令牌校验变更而 403 握手失败）
 *   python 解释器可用 HUASHU_PYTHON 指定（venv 里的那个也行）
 *
 * env：
 *   EDGE_TTS_VOICE   默认音色，默认 zh-CN-XiaoxiaoNeural
 *   HUASHU_PYTHON    指定 python3 路径
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SYNTH_PY = path.join(__dirname, 'edge_synth.py');

const DEFAULT_VOICE = process.env.EDGE_TTS_VOICE || 'zh-CN-XiaoxiaoNeural';
const SAMPLE_RATE = 24000; // 与 tts-doubao.mjs 产物一致，保证 concat -c copy 不出问题

function parseArgs(argv) {
  const args = { speed: '1.0' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--text') args.text = argv[++i];
    else if (a === '--text-file') args.textFile = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--speed') args.speed = argv[++i];
    else if (a === '--voice') args.voice = argv[++i];
    else if (a === '--pitch') args.pitch = argv[++i];
    else if (a === '--timestamps') args.timestamps = true;
    else if (a === '--no-timestamps') args.timestamps = false;
    else if (a === '--yes') args.yes = true; // 兼容 narrate-pipeline 的统一调用，edge 不需要确认
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function usage() {
  console.error(`
tts-edge.mjs · Microsoft Edge TTS（免费，无需 key）

  --text <str>          要合成的文本
  --text-file <path>    从文件读取文本（与 --text 二选一）
  --out <path>          输出 mp3 路径（必填）
  --speed <float>       语速倍率，默认 1.0（0.5-2.0，0.92 ≈ 慢 8%）
  --voice <voice>       覆盖默认音色，如 zh-CN-YunxiNeural
  --pitch <str>         音高，如 "+0Hz" / "-2Hz"
  --timestamps          输出词级时间戳（结果 JSON 多一个 words 数组）
  --yes                 兼容参数，无实际作用

常用中文音色：
  zh-CN-XiaoxiaoNeural  晓晓 · 女 · 温和（默认）
  zh-CN-YunxiNeural     云希 · 男 · 年轻
  zh-CN-YunjianNeural   云健 · 男 · 浑厚
  zh-CN-XiaoyiNeural    晓伊 · 女 · 活泼
  zh-CN-YunyangNeural   云扬 · 男 · 新闻播音
`.trim());
  process.exit(1);
}

function getDuration(filePath) {
  try {
    const out = execFileSync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ], { encoding: 'utf8' });
    return parseFloat(out.trim());
  } catch {
    return null;
  }
}

/** 找一个能 import edge_tts 的 python */
function findPython() {
  // PATH 上的 python3 不一定是用户 pip install 的那个（macOS 上常见：
  // 前面排着 pyenv/系统自带的，装包的是 homebrew 或 python.org 的那个）。
  // 所以除了 PATH，再补几个常见安装位置。
  const candidates = [
    process.env.HUASHU_PYTHON,
    'python3',
    'python',
    '/opt/homebrew/bin/python3',        // macOS Apple Silicon · homebrew
    '/usr/local/bin/python3',           // macOS Intel · homebrew / python.org
    '/usr/bin/python3',                 // 系统自带（几乎不会有 edge_tts，兜底）
    'py',                               // Windows launcher
  ].filter(Boolean);

  const tried = [];
  for (const bin of candidates) {
    const r = spawnSync(bin, ['-c', 'import edge_tts'], { encoding: 'utf8' });
    if (r.status === 0) return bin;
    tried.push(bin);
  }
  if (process.env.HUASHU_DEBUG) console.error(`[tts-edge] 试过：${tried.join(', ')}`);
  return null;
}

/** 倍率 → Edge 的百分比语速 */
function speedToRate(speed) {
  const ratio = parseFloat(speed);
  if (!Number.isFinite(ratio) || ratio <= 0) return '+0%';
  const pct = Math.max(-50, Math.min(100, Math.round((ratio - 1) * 100)));
  return `${pct >= 0 ? '+' : ''}${pct}%`;
}

/** Edge 音色形如 zh-CN-XiaoxiaoNeural；不像的话（比如豆包的 S_xxx）退回默认 */
function resolveVoice(voice) {
  if (!voice) return DEFAULT_VOICE;
  if (/^[a-z]{2,3}-[A-Z]{2,4}-[A-Za-z]+(Multilingual)?Neural$/.test(voice)) return voice;
  console.error(
    `[tts-edge] 音色 "${voice}" 不是 Edge 音色格式，改用默认 ${DEFAULT_VOICE}` +
    `（Edge 音色形如 zh-CN-XiaoxiaoNeural，见 --help）`,
  );
  return DEFAULT_VOICE;
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help || (!args.text && !args.textFile) || !args.out) usage();

  const python = findPython();
  if (!python) {
    console.error(
      '[tts-edge] 没找到能 import edge_tts 的 python3。\n' +
      '  装一下：pip install -U "edge-tts>=7.3"\n' +
      '  用 venv 的话把解释器路径给 HUASHU_PYTHON，例如：\n' +
      '    HUASHU_PYTHON=~/venv/bin/python node scripts/edge/tts-edge.mjs ...',
    );
    process.exit(3);
  }

  const outPath = path.resolve(args.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  // 文本走临时文件：避免超长参数和引号转义问题
  const tmpText = path.join(os.tmpdir(), `tts-edge-${process.pid}-${Date.now()}.txt`);
  const tmpRaw = path.join(os.tmpdir(), `tts-edge-${process.pid}-${Date.now()}-raw.mp3`);
  const text = args.textFile ? fs.readFileSync(path.resolve(args.textFile), 'utf8') : args.text;
  fs.writeFileSync(tmpText, text, 'utf8');

  // 用 --opt=value 形式传参：语速/音高可能是 "-5%" / "-2Hz"，
  // 空格分隔的话 argparse 会把它当成另一个选项，报 "expected one argument"。
  const pyArgs = [
    SYNTH_PY,
    `--text-file=${tmpText}`,
    `--out=${tmpRaw}`,
    `--voice=${resolveVoice(args.voice)}`,
    `--rate=${speedToRate(args.speed)}`,
    `--pitch=${args.pitch || '+0Hz'}`,
    `--boundary=${args.timestamps ? 'WordBoundary' : 'None'}`,
  ];

  let parsed;
  try {
    const stdout = execFileSync(python, pyArgs, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
    });
    parsed = JSON.parse(stdout.trim().split('\n').pop());
  } catch (e) {
    const msg = (e.stderr || e.message || '').toString().trim();
    console.error(`[tts-edge] 合成失败：${msg}`);
    fs.rmSync(tmpText, { force: true });
    // 3=缺依赖 4=握手被拒，原样往上抛，让 narrate-pipeline 能区分「降级」和「真挂了」
    process.exit(e.status === 3 || e.status === 4 ? e.status : 1);
  }

  // 统一采样率/声道，保证和豆包产物拼在同一条轨上不炸
  try {
    execFileSync('ffmpeg', [
      '-y', '-v', 'error', '-i', tmpRaw,
      '-ac', '1', '-ar', String(SAMPLE_RATE), '-c:a', 'libmp3lame', '-b:a', '64k',
      outPath,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    console.error(`[tts-edge] ffmpeg 转码失败：${(e.stderr || '').toString().trim()}`);
    fs.rmSync(tmpText, { force: true });
    fs.rmSync(tmpRaw, { force: true });
    process.exit(1);
  }

  fs.rmSync(tmpText, { force: true });
  fs.rmSync(tmpRaw, { force: true });

  const duration = getDuration(outPath);
  const result = {
    path: outPath,
    duration,
    bytes: fs.statSync(outPath).size,
  };
  if (args.timestamps) result.words = parsed.words || [];

  process.stdout.write(JSON.stringify(result) + '\n');
}

main();
