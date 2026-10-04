#!/usr/bin/env python3
"""Select the per-extract job matrix for osm-metro-transit.yml.

Reads the precomputed metro-transit-groups.json and, optionally, narrows it to a
single city slug. Writes the resulting matrix as one JSON array on one line,
which the workflow reads into $GITHUB_OUTPUT.

Kept as a file rather than an inline heredoc: an inline python block inside a
YAML run: scalar cannot be exercised outside the runner, and this one already
failed there under `set -euo pipefail` with no message at all.
"""
import argparse
import json
import sys


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--groups", required=True)
    ap.add_argument("--slug", default="")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    with open(args.groups, encoding="utf-8") as fh:
        doc = json.load(fh)

    groups = doc["groups"]
    if args.slug:
        groups = [
            {
                "extract": g["extract"],
                "cities": [c for c in g["cities"] if c.split(":", 1)[0] == args.slug],
            }
            for g in groups
        ]
        groups = [g for g in groups if g["cities"]]

    if not groups:
        print(f"::error::no city matched slug={args.slug!r}; "
              f"{doc.get('cityCount', '?')} cities are available", file=sys.stderr)
        return 1

    with open(args.out, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(groups, fh, separators=(",", ":"), ensure_ascii=False)

    total = sum(len(g["cities"]) for g in groups)
    print(f"{total} cities across {len(groups)} job(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())