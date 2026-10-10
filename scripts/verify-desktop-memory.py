#!/usr/bin/env python3
"""Sample a LicketySplit process tree without changing macOS memory pressure."""
import argparse, json, os, platform, subprocess, time
from pathlib import Path

def parse_ps(text):
    rows = []
    for line in text.splitlines():
        parts = line.strip().split(None, 3)
        if len(parts) < 3:
            continue
        try:
            rows.append({'pid': int(parts[0]), 'ppid': int(parts[1]), 'rssBytes': int(parts[2]) * 1024, 'name': parts[3] if len(parts) > 3 else ''})
        except ValueError:
            continue
    return rows

def process_tree(rows, root_pid):
    ids = {root_pid}
    while True:
        expanded = ids | {row['pid'] for row in rows if row['ppid'] in ids}
        if expanded == ids:
            break
        ids = expanded
    return sorted([row for row in rows if row['pid'] in ids], key=lambda row: row['pid'])

def query(command):
    return subprocess.run(command, capture_output=True, text=True, check=False).stdout.strip()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--pid', type=int, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--duration', type=float, default=60)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    physical = int(query(['sysctl', '-n', 'hw.memsize']) or 0) if platform.system() == 'Darwin' else 0
    samples = []
    started = time.monotonic()
    with (args.output / 'process-rss.jsonl').open('w') as file:
        while time.monotonic() - started < args.duration:
            tree = process_tree(parse_ps(query(['ps', '-axo', 'pid=,ppid=,rss=,comm='])), args.pid)
            if not tree:
                break
            sample = {'elapsedMs': round((time.monotonic() - started) * 1000), 'rssBytes': sum(row['rssBytes'] for row in tree), 'processes': tree}
            samples.append(sample)
            file.write(json.dumps(sample) + '\n')
            file.flush()
            time.sleep(max(0, 1 - (time.monotonic() - started) % 1))
    pressure = subprocess.run(['memory_pressure', '-Q'], capture_output=True, text=True, check=False).stdout if platform.system() == 'Darwin' else 'Unavailable'
    receipt = {'schemaVersion': 1, 'arch': platform.machine(), 'physicalBytes': physical, 'actual8GiBHardware': physical == 8 * 1024 ** 3 and platform.machine() == 'arm64', 'sampleIntervalMs': 1000, 'sampleCount': len(samples), 'peakRssBytes': max((s['rssBytes'] for s in samples), default=0), 'memoryPressureQuery': pressure, 'qualification': 'Summed process RSS is conservative and may double-count shared pages; GPU/unified memory ownership is not measured. A larger or capped host is not8GiB acceptance.'}
    (args.output / 'memory-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt))

if __name__ == '__main__':
    main()
