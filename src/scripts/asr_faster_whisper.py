import argparse
import sys


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    parser = argparse.ArgumentParser(description="ASR via faster-whisper")
    parser.add_argument("--input", required=True, help="audio file path")
    parser.add_argument("--model", default="tiny", help="whisper model size")
    parser.add_argument("--device", default="cpu", help="cpu/cuda")
    parser.add_argument("--compute-type", default="int8", help="compute type")
    parser.add_argument("--language", default="zh", help="language code")
    args = parser.parse_args()

    try:
      from faster_whisper import WhisperModel
    except Exception as error:
      print(f"faster_whisper_import_failed: {error}", file=sys.stderr)
      sys.exit(2)

    try:
      model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type)
      segments, _info = model.transcribe(args.input, language=args.language, vad_filter=True)
      text = " ".join((segment.text or "").strip() for segment in segments).strip()
      print(text)
    except Exception as error:
      print(f"faster_whisper_transcribe_failed: {error}", file=sys.stderr)
      sys.exit(3)


if __name__ == "__main__":
    main()
