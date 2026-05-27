#!/usr/bin/env bash
# Serve the converter on http://localhost:8000
# Some browsers block fetch() from file:// origins, so use a local server.
cd "$(dirname "$0")"
python3 -m http.server 8000
