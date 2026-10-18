#!/usr/bin/env python3
"""
edge_synth.py · Microsoft Edge TTS 单段合成（tts-edge.mjs 的子进程）

Edge TTS 是 Edge 浏览器「大声朗读」背后的神经语音服务，免费、无需 API key。
本脚本只做一件事：把一段文本合成为 mp3，并把词级时间戳打回 stdout。

用法（由 tts-edge.mjs 调用，一般不用手跑）：
  python3 edge_synth.py --text-file /tmp/a.txt --out /tmp/a.mp3 \
      --voice zh-CN-XiaoxiaoNeural --rate "-8%" --boundary WordBoundary

stdout: {"path": "...", "words": [{"text": "...", "start": 0.1, "end": 0.43}]}
        start/end 单位秒，相对本段音频开头。

依赖：pip install -U "edge-tts>=7.3"
      （低于 7.3 的版本会因微软的 Sec-MS-GEC 令牌校验变更而握手失败 403）
"""
import argparse
import asyncio
import json
import os
import sys

EXIT_NO_DEP = 3
EXIT_BAD_HANDSHAKE = 4


class HandshakeError(RuntimeError):
    """握手被拒（403）。几乎总是 edge-tts 版本太旧，重试无意义。"""


def parse_args():
    ap = argparse.ArgumentParser()
    ap.add_argument("--text", default=None)
    ap.add_argument("--text-file", default=None)
    ap.add_argument("--out", required=True)
    ap.add_argument("--voice", default="zh-CN-XiaoxiaoNeural")
    ap.add_argument("--rate", default="+0%")
    ap.add_argument("--pitch", default="+0Hz")
    ap.add_argument("--volume", default="+0%")
    ap.add_argument("--boundary", default="WordBoundary",
                    choices=["WordBoundary", "SentenceBoundary", "None"])
    ap.add_argument("--tries", type=int, default=4)
    return ap.parse_args()


async def synth(text, voice, rate, pitch, volume, boundary, out_path, tries):
    import edge_tts  # 延迟导入，好给未安装的情况一个干净的错误

    kwargs = dict(rate=rate, pitch=pitch, volume=volume)
    if boundary != "None":
        kwargs["boundary"] = boundary

    last = None
    for attempt in range(tries):
        try:
            com = edge_tts.Communicate(text, voice, **kwargs)
            words = []
            with open(out_path, "wb") as f:
                async for chunk in com.stream():
                    if chunk["type"] == "audio":
                        f.write(chunk["data"])
                    elif chunk["type"] in ("WordBoundary", "SentenceBoundary"):
                        words.append({
                            "text": chunk["text"],
                            # Edge 的时间单位是 100ns
                            "start": round(chunk["offset"] / 1e7, 3),
                            "end": round((chunk["offset"] + chunk["duration"]) / 1e7, 3),
                        })
            if os.path.getsize(out_path) > 2000:
                return words
            last = "返回的音频为空"
        except Exception as e:                      # noqa: BLE001
            last = f"{type(e).__name__}: {e}"
            # 403 是微软的 Sec-MS-GEC 令牌校验没过，重试多少次都一样，
            # 几乎总是因为 edge-tts 版本太旧（微软改过握手）。直接给出可执行的修复动作。
            if "403" in str(e) or "Handshake" in type(e).__name__:
                raise HandshakeError(last) from e
        # Edge 的 websocket 偶发连不上/超时，退避重试即可
        await asyncio.sleep(1.2 * (attempt + 1))
    raise RuntimeError(f"合成失败（已重试 {tries} 次）：{last}")


def main():
    args = parse_args()

    if args.text_file:
        with open(args.text_file, encoding="utf-8") as f:
            text = f.read().strip()
    else:
        text = (args.text or "").strip()
    if not text:
        print("edge_synth: 文本为空", file=sys.stderr)
        return 1

    try:
        words = asyncio.run(synth(
            text, args.voice, args.rate, args.pitch, args.volume,
            args.boundary, args.out, args.tries,
        ))
    except ImportError:
        print(
            "edge_synth: 缺 edge-tts。装一下：pip install -U \"edge-tts>=7.3\"\n"
            "（或 pipx install edge-tts；本脚本需要一个能 import edge_tts 的 python3）",
            file=sys.stderr,
        )
        return EXIT_NO_DEP
    except HandshakeError as e:
        print(
            "edge_synth: 握手被微软拒绝（403）。这几乎总是 edge-tts 版本太旧——\n"
            "  升级一下：pip install -U \"edge-tts>=7.3\"\n"
            f"  原始错误：{e}",
            file=sys.stderr,
        )
        return EXIT_BAD_HANDSHAKE
    except Exception as e:                          # noqa: BLE001
        print(f"edge_synth: {e}", file=sys.stderr)
        return 1

    print(json.dumps({"path": args.out, "words": words}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
