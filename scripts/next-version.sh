#!/usr/bin/env bash
#
# Predict the version tag that the NEXT merge of the current branch into main will mint.
#
# SOURCE OF TRUTH: .github/workflows/version.yml. That workflow stamps the real tag on every
# push to main; this script mirrors its tag-creation path so `/ship` can name the version
# BEFORE the merge lands. If the workflow's algorithm changes, change this script to match.
#
# Prints a bare SemVer (e.g. 0.3.21) with NO leading "v". No git writes, read-only.
#
#   base = package.json "version"  ->  <major>.<minor>.<build>
#   line = <major>.<minor>          (the release line)
#   next = highest existing v<line>.<N> build tag + 1, or `build` if the line has no tag yet
#          (never lower than `build`, so bumping the line to x.y.0 yields vX.Y.0)
#
set -euo pipefail

# Read the base version with node (always present in this repo; avoids a jq dependency
# that Git Bash on Windows may not have).
base=$(node -p "require('./package.json').version")
if ! echo "$base" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'; then
  echo "Base version '$base' in package.json is not a plain <major>.<minor>.<build> semver." >&2
  exit 1
fi

IFS=. read -r major minor build <<<"$base"
line="${major}.${minor}"

# Highest existing 3-part build tag on this release line. Legacy 4-part tags (v1.2.3.7) are
# ignored, exactly as the workflow's tag counter ignores them.
last=$(git tag --list "v${line}.*" \
  | grep -E "^v${major}\.${minor}\.(0|[1-9][0-9]*)$" \
  | sed -E "s/^v${major}\.${minor}\.//" \
  | sort -n | tail -1 || true)

if [ -z "$last" ]; then
  next="$build"
else
  next=$((last + 1))
  if [ "$next" -lt "$build" ]; then
    next="$build"
  fi
fi

echo "${line}.${next}"
