#!/usr/bin/env python3
"""Scan tracked content without printing potentially sensitive matches."""
import argparse
import ipaddress
from pathlib import Path
import re
import subprocess
import sys


def git(*args):
    return subprocess.check_output(["git", *args])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--staged", action="store_true")
    args = parser.parse_args()
    root = Path(git("rev-parse", "--show-toplevel").decode().strip())
    private_terms = Path(git("rev-parse", "--git-path", "sanitization-denylist").decode().strip())
    terms = private_terms.read_text(encoding="utf-8").splitlines() if private_terms.exists() else []
    terms = [t.strip().lower() for t in terms if t.strip() and not t.startswith("#")]
    patterns = {
        "JWT": r"eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}",
        "private key": r"-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----",
        "credential URL": r"://[^\s/:]+:[^\s@/]{6,}@",
        "provider token": r"(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{30,})",
        "private path token": r"/private_[A-Za-z0-9_-]{10,}",
        "personal filesystem path": r"(?:[A-Z]:[\\/](?:Users|Documents and Settings)[\\/]|/Users/|/home/)[^\s/\\]+",
    }
    paths = (git("diff", "--cached", "--name-only", "--diff-filter=ACM", "-z") if args.staged else git("ls-files", "-z")).decode().split("\0")
    failures = []
    for name in filter(None, paths):
        if name in {"scripts/check-sanitization.py", "scripts/check-sanitization.sh"}:
            continue
        data = git("show", f":{name}") if args.staged else (root / name).read_bytes()
        if b"\0" in data:
            continue
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            continue
        for n, line in enumerate(text.splitlines(), 1):
            reasons = [kind for kind, pattern in patterns.items() if re.search(pattern, line, re.I)]
            if any(term in line.lower() for term in terms):
                reasons.append("local identity denylist")
            for address in re.findall(r"(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])", line):
                try:
                    ip = ipaddress.ip_address(address)
                except ValueError:
                    continue
                if ip.is_private and not (ip.is_loopback or ip.is_unspecified or any(ip in net for net in EXAMPLE_NETS)):
                    reasons.append("private network address")
            if reasons:
                failures.append(f"{name}:{n}: {', '.join(sorted(set(reasons)))}")
    print("\n".join(failures) if failures else "Sanitization scan passed.")
    return bool(failures)


EXAMPLE_NETS = [ipaddress.ip_network(n) for n in ("192.0.2.0/24", "198.51.100.0/24", "203.0.113.0/24")]
if __name__ == "__main__":
    sys.exit(main())
