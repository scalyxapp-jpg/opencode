#!/usr/bin/env python3
"""
Statische Analyse des opencode-Binaries (Bun-Standalone-Executable).

Liest ausschliesslich - veraendert nichts am Original.
Erzeugt Reproduzierbare Artefakte unter fork/analysis/.
"""

import json
import re
import subprocess
import sys
from collections import Counter
from pathlib import Path

BIN = Path(sys.argv[1] if len(sys.argv) > 1 else "fork/baseline/opencode.bin")
OUT = Path("fork/analysis")

BUN_OFF = 0x4D7F000
BUN_SIZE = 0x74CA9F3


def section(raw, off, size):
    return raw[off : off + size]


def strings(buf, minlen=8):
    return [
        m.decode("utf8", "replace") for m in re.findall(rb"[ -~]{%d,}" % minlen, buf)
    ]


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    raw = BIN.read_bytes()

    # --- 1. ELF-Sektionen -------------------------------------------------
    sects = []
    for line in subprocess.run(
        ["readelf", "-S", "-W", str(BIN)], capture_output=True, text=True
    ).stdout.splitlines():
        m = re.match(
            r"\s*\[\s*(\d+)\]\s+(\S+)\s+(\S+)\s+([0-9a-f]+)\s+([0-9a-f]+)\s+([0-9a-f]+)",
            line,
        )
        if m:
            sects.append(
                {
                    "idx": int(m.group(1)),
                    "name": m.group(2),
                    "type": m.group(3),
                    "addr": int(m.group(4), 16),
                    "off": int(m.group(5), 16),
                    "size": int(m.group(6), 16),
                }
            )
    (OUT / "sections.json").write_text(json.dumps(sects, indent=2))

    # --- 2. Eingebettetes Datei-Manifest (/$bunfs/root/) -------------------
    bun = section(raw, BUN_OFF, BUN_SIZE)
    paths = sorted(set(re.findall(rb"/\$bunfs/root/[A-Za-z0-9._\-/]+", bun)))
    paths = [p.decode() for p in paths]
    manifest = {"count": len(paths), "paths": paths}
    (OUT / "bunfs-manifest.json").write_text(json.dumps(manifest, indent=2))

    buckets = Counter()
    for p in paths:
        base = p.rsplit("/", 1)[-1]
        if base.endswith(".js"):
            buckets["chunk-*.js (Bundler-Chunks)"] += 1
        elif base.endswith(".wasm"):
            buckets["*.wasm (Nativ-Module)"] += 1
        elif base.endswith(".scm"):
            buckets["*.scm (Syntax-Highlighting)"] += 1
        elif base.endswith(".so"):
            buckets["*.so (Native Libraries)"] += 1
        elif base.endswith(".node"):
            buckets["*.node (Natives Addons)"] += 1
        elif base.endswith(".mp3"):
            buckets["*.mp3 (Audio)"] += 1
        elif base.endswith((".txt", ".md")):
            buckets["*.txt|md (Prompt-Preset)"] += 1
        else:
            buckets["sonstige"] += 1
    (OUT / "bunfs-buckets.json").write_text(
        json.dumps(buckets, indent=2, ensure_ascii=False)
    )

    # --- 3. Runtime-Flags aus dem Trailer --------------------------------
    trailer = bun[-512:]
    flags = sorted(set(re.findall(rb"--[a-z0-9\-]+(?:=[^\s\-]+)?", trailer)))
    (OUT / "runtime-flags.txt").write_bytes(b"\n".join(flags) + b"\n")

    # --- 4. CLI-Surface ---------------------------------------------------
    help_out = subprocess.run(
        [str(BIN), "--help"], capture_output=True, text=True, timeout=180
    ).stdout
    (OUT / "cli-help.txt").write_text(help_out)

    # --- 5. Env-Vars & Feature-Flags --------------------------------------
    allstr = strings(raw, 10)
    env = sorted({s for s in allstr if re.fullmatch(r"OPENCODE_[A-Z0-9_]{2,}", s)})
    (OUT / "env-vars.txt").write_text("\n".join(env) + "\n")

    # --- 6. Zusammenfassung ------------------------------------------------
    summary = {
        "binary": str(BIN),
        "size_bytes": len(raw),
        "sha256": subprocess.run(
            ["sha256sum", str(BIN)], capture_output=True, text=True
        ).stdout.split()[0],
        "sections": len(sects),
        "bun_section_bytes": BUN_SIZE,
        "embedded_files": len(paths),
        "buckets": buckets,
        "runtime_flags": [f.decode() for f in flags],
        "opencode_env_vars": len(env),
        "total_strings": len(allstr),
    }
    (OUT / "summary.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False))
    print(json.dumps(summary, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
