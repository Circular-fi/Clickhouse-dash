#!/usr/bin/env python3
"""Adds the mark `scrollStart` to <clips>/system.cut.json: the moment the page starts to scroll after the overview
loaded, found from the pixels of the cut clip (the tiles row of the overview moves). The callouts that name something of
a scrolling page follow the scroll between `scrollStart` and `perf` (build.mjs, `follow`).
usage: detect-scroll.py <clip dir>"""
import json, subprocess, sys
import numpy as np

d = sys.argv[1]
j = json.load(open(f"{d}/system.cut.json"))
raw = subprocess.run(["ffmpeg", "-v", "error", "-i", f"{d}/system.cut.mp4", "-vf", "fps=30,scale=192:108,format=gray", "-f", "rawvideo", "-"], capture_output=True).stdout
fr = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 108, 192).astype(float)
reg = fr[:, 18:26, 2:190]                      # the row of server tiles (clip y 174-262)
i0 = int((j["marks"]["overview"] + 0.15) * 30)
for i in range(i0, len(fr)):
    if np.abs(reg[i] - reg[i0]).mean() > 3:
        j["marks"]["scrollStart"] = round(i / 30 - 0.1, 3)  # the ease-in is slow: the move began a little before the threshold
        break
json.dump(j, open(f"{d}/system.cut.json", "w"), indent=1)
print("scrollStart", j["marks"].get("scrollStart"), "perf", j["marks"]["perf"])
