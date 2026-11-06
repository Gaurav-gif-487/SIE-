#!/usr/bin/env bash
# Fetch the third-party repositories used by the real-repo experiments into corpus/.
# Pinned to the release tags the published results were produced from.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p corpus

fetch() {
  local name="$1" url="$2" tag="$3"
  if [ -d "corpus/$name" ]; then
    echo "corpus/$name already present, skipping"
    return
  fi
  git clone --quiet --depth 1 --branch "$tag" "$url" "corpus/$name"
  echo "fetched $name@$tag"
}

fetch ky  https://github.com/sindresorhus/ky.git v2.0.2
fetch zod https://github.com/colinhacks/zod.git  v4.4.3
