#!/bin/sh
# Generate a design's fabrication outputs and verify them with both independent checkers.
set -e
here=$(dirname "$0")
py=${PYTHON:-.venv/bin/python}
npx tsx "$here/make.ts" "$@"
"$py" -W ignore "$here/gerber_check.py" "$1"
"$py" -W ignore "$here/odb_check.py" "$1"
