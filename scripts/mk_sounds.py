#!/usr/bin/env python3
"""Our own synthesised sounds, written to assets/sound/ (committed).

build_sounds.py looks here before LibreQuake, so a precached path that exists
here is ours. Everything is generated from noise and sines: no sample from any
game is involved.

  qwtf/rifle.wav   the Sniper rifle: a sharp crack, a low thump, a short echo
"""
import math, os, random, struct, wave

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "assets", "sound")
RATE = 22050


def write(rel, samples):
    path = os.path.join(OUT, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    peak = max(abs(s) for s in samples) or 1.0
    with wave.open(path, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(RATE)
        w.writeframes(b"".join(struct.pack("<h", int(32000 * s / peak)) for s in samples))
    print(f"wrote {os.path.relpath(path, ROOT)} ({len(samples) / RATE:.2f} s)")


def rifle():
    rnd = random.Random(1009)          # fixed seed: the file is byte-stable
    n = int(RATE * 0.7)
    out, lp, echo_lp = [], 0.0, 0.0
    for i in range(n):
        t = i / RATE
        noise = rnd.uniform(-1, 1)
        crack = noise * math.exp(-t / 0.012)                       # the supersonic crack
        thump = math.sin(2 * math.pi * 95 * t) * math.exp(-t / 0.07) * 0.9
        lp += (noise - lp) * 0.08                                  # low-passed noise
        tail = lp * math.exp(-t / 0.22) * 1.6                      # the rolling report
        d = t - 0.11                                               # one echo off a wall
        echo = 0.0
        if d > 0:
            echo_lp += (rnd.uniform(-1, 1) - echo_lp) * 0.05
            echo = echo_lp * math.exp(-d / 0.15) * 1.2
        out.append(crack + thump + tail + echo)
    return out


if __name__ == "__main__":
    write("qwtf/rifle.wav", rifle())
