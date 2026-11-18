#!/bin/zsh
# A hop page opens another hop page in a new window (a view's ↗, "Open in
# new tab"), through the app's own window code, with nothing on screen:
# the app must not quit, and both windows' pages must still reach it.
#   ./tests/new-window.sh
set -euo pipefail
cd "$(dirname "$0")/.."
work="$(mktemp -d)"
trap 'kill $server 2>/dev/null; rm -rf "$work"' EXIT
port="$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')"
python3 -m http.server --bind 127.0.0.1 "$port" --directory tests/new-window/www >/dev/null 2>&1 &
server=$!
swiftc -o "$work/new-window" Sources/Hop/App.swift Sources/Hop/Server.swift Sources/Hop/WebWindow.swift tests/new-window/main.swift 2>&1 | grep -v 'warning:' | grep . >&2 || true
for i in {1..50}; do curl -fs -o /dev/null "http://127.0.0.1:$port/opener.html" && break; sleep 0.1; done
perl -e 'alarm 30; exec @ARGV' "$work/new-window" "$port" 2>&1 | grep -v '^\[hop\]'
