#!/usr/bin/env sh
set -eu

release_api_url="${SALESMAP_RELEASE_API_URL:-https://api.github.com/repos/sabinanfranz/data_analysis_ai/releases/tags/salesmap-db-latest}"
asset_name="${SALESMAP_RELEASE_ASSET_NAME:-salesmap_latest.db}"
target_path="${SALESMAP_SNAPSHOT_PATH:-/app/runtime/salesmap_latest.db}"
target_dir="$(dirname "$target_path")"
tmp_path="${target_path}.tmp"
meta_path="${target_path}.metadata.json"
release_json_path="${target_path}.release.json"

mkdir -p "$target_dir"

curl -fsSL "$release_api_url" -o "$release_json_path"

asset_json="$(
  node -e '
    const fs = require("node:fs");
    const releasePath = process.argv[1];
    const assetName = process.argv[2];
    const release = JSON.parse(fs.readFileSync(releasePath, "utf8"));
    const asset = (release.assets || []).find((item) => item.name === assetName);
    if (!asset) {
      console.error(`Release asset not found: ${assetName}`);
      process.exit(1);
    }
    process.stdout.write(JSON.stringify({
      tag_name: release.tag_name,
      published_at: release.published_at,
      asset_name: asset.name,
      asset_size: asset.size,
      asset_updated_at: asset.updated_at,
      asset_digest: asset.digest || null,
      download_url: asset.browser_download_url,
    }));
  ' "$release_json_path" "$asset_name"
)"

download_url="$(printf '%s' "$asset_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).download_url));')"
expected_digest="$(printf '%s' "$asset_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).asset_digest || ""));')"

rm -f "$tmp_path"
curl -fL "$download_url" -o "$tmp_path"

if [ -n "$expected_digest" ]; then
  expected_sha="${expected_digest#sha256:}"
  actual_sha="$(sha256sum "$tmp_path" | awk '{print $1}')"
  if [ "$actual_sha" != "$expected_sha" ]; then
    rm -f "$tmp_path"
    echo "sha256 mismatch: expected=$expected_sha actual=$actual_sha" >&2
    exit 1
  fi
fi

sqlite3 "$tmp_path" "PRAGMA integrity_check;" | grep -qx "ok"

mv "$tmp_path" "$target_path"
printf '%s\n' "$asset_json" > "$meta_path"

echo "salesmap snapshot updated: $target_path"
