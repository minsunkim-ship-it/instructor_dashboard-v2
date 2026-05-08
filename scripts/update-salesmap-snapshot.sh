#!/usr/bin/env sh
set -eu

release_api_url="${SALESMAP_RELEASE_API_URL:-https://api.github.com/repos/sabinanfranz/data_analysis_ai/releases/tags/salesmap-db-latest}"
asset_name="${SALESMAP_RELEASE_ASSET_NAME:-salesmap_latest.db}"
release_download_url="${SALESMAP_RELEASE_DOWNLOAD_URL:-https://github.com/sabinanfranz/data_analysis_ai/releases/download/salesmap-db-latest/salesmap_latest.db}"
target_path="${SALESMAP_SNAPSHOT_PATH:-/app/runtime/salesmap_latest.db}"
target_dir="$(dirname "$target_path")"
tmp_path="${target_path}.tmp"
meta_path="${target_path}.metadata.json"
release_json_path="${target_path}.release.json"
github_token="${GITHUB_TOKEN:-${GH_TOKEN:-}}"

mkdir -p "$target_dir"

github_api_curl() {
  if [ -n "$github_token" ]; then
    curl -fsSL \
      -H "Authorization: Bearer $github_token" \
      -H "Accept: application/vnd.github+json" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      -H "User-Agent: instructor-db-salesmap-updater" \
      "$@"
  else
    curl -fsSL \
      -H "Accept: application/vnd.github+json" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      -H "User-Agent: instructor-db-salesmap-updater" \
      "$@"
  fi
}

download_curl() {
  download_url="$1"
  asset_api_url="$2"

  if [ -n "$github_token" ] && [ -n "$asset_api_url" ]; then
    curl -fL \
      -H "Authorization: Bearer $github_token" \
      -H "Accept: application/octet-stream" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      -H "User-Agent: instructor-db-salesmap-updater" \
      "$asset_api_url" \
      -o "$tmp_path"
  else
    curl -fL \
      -H "User-Agent: instructor-db-salesmap-updater" \
      "$download_url" \
      -o "$tmp_path"
  fi
}

if github_api_curl "$release_api_url" -o "$release_json_path"; then
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
        asset_api_url: asset.url || null,
      }));
    ' "$release_json_path" "$asset_name"
  )"
else
  echo "GitHub release API failed; falling back to direct asset URL." >&2
  asset_json="$(
    node -e '
      const assetName = process.argv[1];
      const downloadUrl = process.argv[2];
      process.stdout.write(JSON.stringify({
        tag_name: null,
        published_at: null,
        asset_name: assetName,
        asset_size: null,
        asset_updated_at: null,
        asset_digest: null,
        download_url: downloadUrl,
        asset_api_url: null,
        metadata_warning: "release_api_unavailable",
      }));
    ' "$asset_name" "$release_download_url"
  )"
fi

download_url="$(printf '%s' "$asset_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).download_url));')"
expected_digest="$(printf '%s' "$asset_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).asset_digest || ""));')"
asset_api_url="$(printf '%s' "$asset_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).asset_api_url || ""));')"

rm -f "$tmp_path"
download_curl "$download_url" "$asset_api_url"

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
