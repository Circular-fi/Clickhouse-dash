#!/usr/bin/env python3
"""Mixes the sound effects of the video into one wav: sfxbed.py events.json sfx-dir out.wav
events.json: {"total": seconds, "events": [[time, file, gain], ...]}"""
import json, subprocess, sys
import numpy as np

SR = 48000
ev = json.load(open(sys.argv[1]))
src = sys.argv[2]
out = np.zeros(int((ev["total"] + 2) * SR), dtype=np.float32)
cache = {}

def load(name):
    if name not in cache:
        raw = subprocess.run(["ffmpeg", "-v", "error", "-i", f"{src}/{name}", "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"], capture_output=True).stdout
        cache[name] = np.frombuffer(raw, dtype=np.float32)
    return cache[name]

for t, name, gain in ev["events"]:
    x = load(name) * gain
    i = max(0, int(t * SR))
    j = min(len(out), i + len(x))
    if j > i:
        out[i:j] += x[: j - i]
peak = float(np.abs(out).max()) or 1.0
if peak > 0.95:
    out *= 0.95 / peak
pcm = (out * 32767).astype("<i2").tobytes()
subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "s16le", "-ar", str(SR), "-ac", "1", "-i", "-", sys.argv[3]], input=pcm, check=True)
print("sfx bed:", len(ev["events"]), "events, peak", round(peak, 2))
