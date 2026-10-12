#!/bin/bash
# Generates the voice (Kokoro, through Hyperframes) and the word times (Whisper) of each narration line that has no wav yet,
# or of the lines named on the command line. Run from docs/media/source.
cd "$(dirname "$0")/../composition" || exit 1
mkdir -p assets/vo
while IFS='|' read -r n t cap; do
  if [ $# -gt 0 ] && [[ ! " $* " =~ " $n " ]]; then continue; fi
  if [ $# -eq 0 ] && [ -f "assets/vo/$n.wav" ]; then continue; fi
  HYPERFRAMES_NO_TELEMETRY=1 npx hyperframes tts "$t" --voice af_heart --output "assets/vo/$n.wav" </dev/null >/dev/null 2>&1
  HYPERFRAMES_NO_TELEMETRY=1 npx hyperframes transcribe "assets/vo/$n.wav" --json </dev/null >/dev/null 2>&1
  mv assets/vo/transcript.json "assets/vo/$n.words.json"
  echo "$n $(ffprobe -v error -show_entries format=duration -of csv=p=0 assets/vo/$n.wav)"
done < ../narration/script.txt
