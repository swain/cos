#!/usr/bin/env bash
# COS installer — symlinks shareable files into ~/.claude/, copies templates
# for personal files, builds the CLI, and installs the launchd agent.
# Idempotent: safe to re-run.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="$HOME/.claude"
COS_DIR="$CLAUDE_DIR/cos"
COMMANDS_DIR="$CLAUDE_DIR/commands"
LAUNCHD_DIR="$HOME/Library/LaunchAgents"
LABEL="${COS_LAUNCHD_LABEL:-com.$(whoami).cos.cron}"

echo "==> COS install from: $REPO_ROOT"
echo "    target:         $CLAUDE_DIR"
echo "    launchd label:  $LABEL"
echo

# ----- Prereqs -----
echo "==> Checking prerequisites…"
for bin in node npm tmux gh launchctl git claude; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    if [[ "$bin" == "claude" ]] && [[ -x "$HOME/.local/bin/claude" ]]; then
      echo "    claude: ok (at ~/.local/bin/claude)"
      continue
    fi
    echo "    MISSING: $bin" >&2
    exit 1
  fi
  echo "    $bin: ok"
done
echo

# ----- Directories -----
mkdir -p "$COS_DIR"/{logs,worklogs,meetings}
mkdir -p "$COMMANDS_DIR"
mkdir -p "$LAUNCHD_DIR"

# ----- Symlink shareable files (idempotent) -----
link_if_missing() {
  local src="$1" dst="$2"
  if [[ -L "$dst" ]] && [[ "$(readlink "$dst")" == "$src" ]]; then
    echo "    $dst → $src (already linked)"
    return
  fi
  if [[ -e "$dst" ]] && [[ ! -L "$dst" ]]; then
    echo "    $dst exists and is not a symlink — leaving alone (back up + remove if you want to switch)"
    return
  fi
  rm -f "$dst"
  ln -s "$src" "$dst"
  echo "    $dst → $src"
}

echo "==> Symlinking shareable COS files into ${COS_DIR}…"
for f in design.md implementation-plan.md USING_COS.md system.md po.md; do
  link_if_missing "$REPO_ROOT/$f" "$COS_DIR/$f"
done
link_if_missing "$REPO_ROOT/prompts" "$COS_DIR/prompts"
link_if_missing "$REPO_ROOT/bin" "$COS_DIR/bin"
link_if_missing "$REPO_ROOT/cli" "$COS_DIR/cli"
link_if_missing "$REPO_ROOT/launchd" "$COS_DIR/launchd"

echo
echo "==> Symlinking slash commands into ${COMMANDS_DIR}…"
for f in fleet.md enqueue.md cos.md groom.md dispatch.md weekly.md; do
  link_if_missing "$REPO_ROOT/commands/$f" "$COMMANDS_DIR/$f"
done

echo
echo "==> Linking ~/.claude/CLAUDE.md → CLAUDE.md.template…"
link_if_missing "$REPO_ROOT/CLAUDE.md.template" "$CLAUDE_DIR/CLAUDE.md"

# ----- Personal templates (copy only if missing) -----
copy_template_if_missing() {
  local src="$1" dst="$2"
  if [[ -e "$dst" ]]; then
    echo "    $dst exists — keeping existing"
    return
  fi
  cp "$src" "$dst"
  echo "    $dst ← $src (starter copy)"
}

echo
echo "==> Copying personal templates (only if target missing)…"
copy_template_if_missing "$REPO_ROOT/templates/team.md.template"           "$COS_DIR/team.md"
copy_template_if_missing "$REPO_ROOT/templates/priorities.md.template"      "$COS_DIR/priorities.md"
copy_template_if_missing "$REPO_ROOT/templates/arch.md.template"            "$COS_DIR/arch.md"
copy_template_if_missing "$REPO_ROOT/templates/ai-native.md.template"       "$COS_DIR/ai-native.md"
copy_template_if_missing "$REPO_ROOT/templates/watched-repos.json.template" "$COS_DIR/watched-repos.json"
copy_template_if_missing "$REPO_ROOT/templates/config.json.template"        "$COS_DIR/config.json"
[[ -e "$COS_DIR/decisions.log" ]] || : > "$COS_DIR/decisions.log"
[[ -e "$COS_DIR/status.md" ]] || echo "# COS Status (pending first tick)" > "$COS_DIR/status.md"

# ----- Build the CLI -----
echo
echo "==> Building cos CLI…"
(
  cd "$REPO_ROOT/cli"
  if [[ ! -d node_modules ]]; then
    npm install --silent
  fi
  npm run build --silent
)

# ----- PATH -----
if ! grep -q 'claude/cos/bin' "$HOME/.zshrc" 2>/dev/null; then
  echo >> "$HOME/.zshrc"
  echo 'export PATH="$HOME/.claude/cos/bin:$PATH"' >> "$HOME/.zshrc"
  echo "==> Added ~/.claude/cos/bin to PATH in ~/.zshrc (reopen your shell)"
fi

# ----- cos init -----
echo
echo "==> Running cos init…"
"$COS_DIR/bin/cos" init

# ----- Render launchd plist -----
echo
echo "==> Rendering launchd plist as ${LABEL}…"
PLIST_OUT="$LAUNCHD_DIR/$LABEL.plist"
sed \
  -e "s|{{LABEL}}|$LABEL|g" \
  -e "s|{{USER_HOME}}|$HOME|g" \
  "$REPO_ROOT/launchd/com.cos.cron.plist.template" > "$PLIST_OUT"
plutil -lint "$PLIST_OUT" >/dev/null && echo "    $PLIST_OUT (valid plist)"

echo
echo "✅ COS installed."
echo
echo "Next steps:"
echo "  1) Fill in $COS_DIR/team.md and $COS_DIR/priorities.md with your real context."
echo "  2) Review $COS_DIR/arch.md and $COS_DIR/ai-native.md — customize to your stack."
echo "  3) Update $COS_DIR/watched-repos.json with repos you want COS to monitor."
echo "  4) Load the launchd agent:"
echo "       launchctl bootstrap gui/\$(id -u) $PLIST_OUT"
echo "       launchctl kickstart gui/\$(id -u)/$LABEL"
echo "  5) To unpause auto-dispatch when you're ready:"
echo "       jq '.dispatch_paused=false' $COS_DIR/config.json > /tmp/c && mv /tmp/c $COS_DIR/config.json"
echo
echo "See $COS_DIR/USING_COS.md for the interaction guide."
