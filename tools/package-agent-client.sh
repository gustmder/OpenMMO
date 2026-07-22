#!/usr/bin/env bash
# Build a tarball someone can unpack on their own machine and run.
#
# The agent-client needs its data/ directory next to the binary (prompts,
# templates, animation timings) but none of the 3 GB terrain tree — that comes
# over HTTP. Output: dist/agent-client-<commit>-<arch>.tar.gz
set -euo pipefail

REPO=${REPO:-$(cd "$(dirname "$0")/.." && pwd)}
OUT_DIR=${OUT_DIR:-$REPO/dist}
SERVER=${SERVER:-wss://openmmo.to.nexus}

# Google's device flow requires the installed-app secret in the token
# exchange. It is not confidential (RFC 8252 section 8.5) and every shipped
# copy needs it, but it stays out of the repo: committing it trips secret
# scanners, so it is injected here from the packaging environment instead.
CLIENT_SECRET=${GOOGLE_CLI_CLIENT_SECRET:-}
if [[ -z $CLIENT_SECRET ]]; then
    echo "error: set GOOGLE_CLI_CLIENT_SECRET (Google Cloud → the CLI OAuth client)." >&2
    echo "       Without it the packaged client cannot complete Google sign-in." >&2
    exit 1
fi

cd "$REPO"
commit=$(git rev-parse --short HEAD)
arch=$(uname -m)
name="agent-client-$commit-$arch"
stage="$OUT_DIR/$name"

cargo build --release -p agent-client

rm -rf "$stage"
mkdir -p "$stage/data"
cp target/release/agent-client "$stage/"
# No data/templates: those are operator NPC roles (merchant, guard). A user
# agent has no template_prompt and falls back to data/system_prompt.txt.
cp agent-client/data/system_prompt.txt agent-client/data/animation_durations.json "$stage/data/"

# Registry NPC personas are operator-side; a user agent plays its own character.
cat > "$stage/data/config.toml" <<EOF
# agent-client configuration. Run the binary from this directory.
server = "$SERVER"
terrain = "${SERVER/wss:/https:}"

[auth]
mode = "google"
client_secret = "$CLIENT_SECRET"

[[npcs]]
character_name = "Change Me"
character_class = "ranger"
llm = "codex"

[codex]
model = "gpt-5.4-mini"
EOF

cp "$REPO/doc/AGENT_CLIENT_QUICKSTART.md" "$stage/README.md"

tar -czf "$OUT_DIR/$name.tar.gz" -C "$OUT_DIR" "$name"
rm -rf "$stage"
echo "==> $OUT_DIR/$name.tar.gz"
