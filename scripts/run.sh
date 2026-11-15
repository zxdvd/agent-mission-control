#!/bin/sh
set -eu
RELEASE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
BASE=$(CDPATH= cd -- "$RELEASE/../.." && pwd)
mkdir -p "$BASE/data"
exec "$RELEASE/agent-workbench" -db "$BASE/data/workbench.db" "$@"
