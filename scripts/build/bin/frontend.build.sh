#!/usr/bin/env bash

set -euo pipefail

if [ -z "$1" ]; then
  echo "Required npm prefix!"
  exit 1
fi

source "$(cd "$(dirname "$0")" && pwd)/common.sh"

for cmd in aws jq; do
  check_command "$cmd"
done

check_variable REACT_APP_VERSION_FRONTEND

echo "PROCESS: Building react application."

npm install --prefix "$1"
npm run lint --prefix "$1"
npm run test --prefix "$1" -- --watchAll=false
npm run build --prefix "$1"

echo "SUCCESS: React application building completed successfully."
exit 0
