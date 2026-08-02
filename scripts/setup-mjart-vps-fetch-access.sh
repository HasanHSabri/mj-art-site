#!/usr/bin/env bash
#
# setup-mjart-vps-fetch-access.sh
#
# One-time, idempotent, LOCAL-VPS-side setup of a hardened, read-only SFTP
# fetch account ("mjart-fetch") for the MJ-ART GitHub Actions catalogue import.
#
# What this script DOES (only when run with sudo, as root):
#   - Validates the caller-supplied public host/port and the fixed imports path.
#   - Verifies the published master archive + sidecar (project verifier + tar
#     listing guard) before doing anything privileged.
#   - Creates (or, if it matches exactly, preserves) a locked, nologin system
#     user "mjart-fetch" whose only group is itself (never "developers").
#   - Installs ONE authorized_keys entry with a forced
#       command="internal-sftp -d <imports>",restrict
#     so the account can ONLY SFTP into the imports dir, cannot get a shell,
#     cannot forward, and cannot write (filesystem rights are read-only for it).
#   - ALSO enforces ForceCommand internal-sftp (and no forwarding/PTY) at the
#     SSH-DAEMON level via ONE narrow, validated, auto-reverting "Match User"
#     snippet under sshd_config.d/ (defense-in-depth with the authorized key
#     forced command; see the "DOES NOT" note for the fail-closed contract).
#   - Generates a fresh ed25519 keypair; leaves the PRIVATE key in a protected,
#     caller-owned file and the host known_hosts line in another, for the next
#     (manual, GitHub-side) gh step. It NEVER prints key material.
#   - Runs a local SFTP positive test (retrieve archive + sidecar, sha256-match)
#     and negative tests (upload denied, shell command denied).
#
# What this script DOES NOT do:
#   - It never calls gh, never sets GitHub secrets/variables, never mutates
#     GitHub. It only PRINTS the safe next command for the caller to run.
#   - It does NOT edit /etc/ssh/sshd_config directly. It drops ONE narrow,
#     root-owned 0644, marker-delimited "Match User mjart-fetch" snippet into
#     the host's EXISTING sshd_config.d/*.conf include dir, and ONLY if that
#     include is supported (fail-closed otherwise). The snippet sets NO global
#     options. The full config is validated with `sshd -t`, the GLOBAL
#     effective config is proven unchanged (no drift), and the per-user
#     effective config is verified with `sshd -T -C` BEFORE sshd is reloaded.
#     On any validation or reload failure the prior (absent) snippet is
#     restored and the script fails loudly.
#   - It does not discover the public IP (the operator passes --host).
#   - It does not delete or modify anything under imports.
#
# Safety: it is unprivileged until invoked with sudo. Every privileged action is
# gated behind the root + SUDO_USER checks, which run AFTER input validation.
#
# Usage:
#   sudo bash scripts/setup-mjart-vps-fetch-access.sh --host <public-host-or-ip> [--port <1-65535>]
#
# Exit codes: 0 success; 1 any validation/setup failure; 2 usage/help.

set -euo pipefail

# --------------------------------------------------------------------------- #
# Constants (fixed; none come from caller input except host/port)
# --------------------------------------------------------------------------- #

# The only archive root this account may expose. Derived from the script
# location (not from user input) so it cannot be redirected arbitrarily.
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
IMPORTS_PATH="$REPO_ROOT/.local-assets/imports"

FETCH_USER="mjart-fetch"
FETCH_HOME="/home/mjart-fetch"
FETCH_KEY_COMMENT="mj-art-github-actions"

# Host public key (read only; the .pub file is world-readable on most systems).
HOST_PUB_FILE="/etc/ssh/ssh_host_ed25519_key.pub"

# Where the caller's private key + known_hosts land (caller-owned, 0600).
CALLER_KEYDIR_REL=".local/share/mj-art"
CALLER_KEY_NAME="vps-github-actions-ed25519"
CALLER_KH_NAME="vps-github-actions-known-hosts"

# Default SSH port (OpenSSH default).
DEFAULT_PORT=22

# Optional tooling.
SETFACL=$(command -v setfacl 2>/dev/null || true)

# Scratch space; created after the root check and removed on EXIT.
WORK_TMP=""

# --------------------------------------------------------------------------- #
# Logging / failure helpers
# --------------------------------------------------------------------------- #

note() { printf '[setup] %s\n' "$*" >&2; }
fail() { printf '[setup] FAIL: %s\n' "$*" >&2; exit 1; }

fail_user_unexpected() {
    local detail="$1"
    cat >&2 <<EOF
[setup] FAIL (fail closed): account '$FETCH_USER' already exists but does NOT
match the expected hardened configuration ($detail).

This script refuses to alter or recreate an unexpected account. Recovery:
  1. Inspect the existing account:
       getent passwd $FETCH_USER
       passwd -S $FETCH_USER
       id -nG $FETCH_USER
       ls -ld $FETCH_HOME $FETCH_HOME/.ssh 2>/dev/null
  2. If YOU created it and it is safe to remove:
       sudo userdel -r $FETCH_USER
     then re-run this script (it is idempotent and will recreate cleanly).
  3. If you did NOT create it, or are unsure, do NOT delete it. Investigate
     the account manually before proceeding.
EOF
    exit 1
}

cleanup() {
    if [ -n "${WORK_TMP:-}" ] && [ -d "${WORK_TMP:-}" ]; then
        # Best-effort shred of any private-key bytes, then remove the scratch dir.
        if command -v shred >/dev/null 2>&1; then
            find "$WORK_TMP" -type f -name 'vps_ed25519*' -print0 \
                2>/dev/null | xargs -0 -r shred -u 2>/dev/null || true
        fi
        rm -rf -- "$WORK_TMP"
    fi
}
trap cleanup EXIT

# --------------------------------------------------------------------------- #
# Usage
# --------------------------------------------------------------------------- #

usage() {
    cat <<EOF
setup-mjart-vps-fetch-access.sh - hardened LOCAL VPS fetch account for MJ-ART.

Sets up the read-only SFTP account "mjart-fetch" used by the GitHub Actions
catalogue import. Local-VPS side only; makes NO GitHub changes.

Usage:
  sudo bash scripts/setup-mjart-vps-fetch-access.sh --host <public-host-or-ip> [--port <1-65535>]

Options:
  --host <h>   Public host or IPv4 of THIS VPS, as reachable by GitHub Actions.
               Required. Accepts a DNS hostname or an IPv4 (no scheme, port,
               path, whitespace, or shell metacharacters).
  --port <n>   TCP port sshd listens on (1-65535). Default: 22.
  -h, --help   Show this help and exit.

Notes:
  - Must be run with sudo from a NON-root account (the caller becomes the owner
    of the generated private key).
  - --host is NOT auto-discovered; it must be the externally reachable address.
  - The script never prints secret material and never calls gh.
EOF
}

# --------------------------------------------------------------------------- #
# Input validation (pure; runs before any privileged action)
# --------------------------------------------------------------------------- #

# IPv4 or DNS hostname. Mirrors VPS_HOST_RE in scripts/lib/catalog-import-core.mjs.
# Rejects whitespace, colons (IPv6), and shell metacharacters.
validate_host() {
    local h="$1"
    [ -n "$h" ] || return 1
    # Quick rejection of whitespace/control chars before invoking grep.
    case "$h" in
        *[[:space:]]*) return 1 ;;
        *) ;;
    esac
    printf '%s' "$h" | grep -Eq '^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$'
}

# Integer 1-65535. Mirrors VPS_PORT_RE.
validate_port() {
    printf '%s' "$1" | grep -Eq \
        '^([1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])$'
}

HOST=""
PORT="$DEFAULT_PORT"

while [ $# -gt 0 ]; do
    case "$1" in
        --host)
            [ $# -ge 2 ] || { usage >&2; exit 2; }
            HOST="$2"; shift 2
            ;;
        --port)
            [ $# -ge 2 ] || { usage >&2; exit 2; }
            PORT="$2"; shift 2
            ;;
        -h|--help)
            usage; exit 0
            ;;
        *)
            printf '[setup] FAIL: unknown argument: %s\n' "$1" >&2
            usage >&2
            exit 2
            ;;
    esac
done

if ! validate_host "$HOST"; then
    printf '[setup] FAIL: --host is missing or not a valid IPv4/DNS hostname\n' >&2
    printf '      (no scheme, port, path, whitespace, or metacharacters).\n' >&2
    exit 2
fi
if ! validate_port "$PORT"; then
    printf '[setup] FAIL: --port must be an integer 1-65535\n' >&2
    exit 2
fi

# --------------------------------------------------------------------------- #
# Root + sudo-user checks (first privileged gate)
# --------------------------------------------------------------------------- #

if [ "$(id -u)" -ne 0 ]; then
    cat >&2 <<EOF
[setup] FAIL: must be run as root. Re-run with sudo from your own account:
  sudo bash scripts/setup-mjart-vps-fetch-access.sh --host <public-host-or-ip>
EOF
    exit 1
fi

CALLER_USER="${SUDO_USER:-}"
if [ -z "$CALLER_USER" ]; then
    fail "could not detect the invoking sudo user (SUDO_USER is empty). Run via 'sudo' from a non-root account, not from a root shell."
fi
if [ "$CALLER_USER" = "root" ]; then
    fail "refusing: SUDO_USER is 'root'. Run this from a normal (non-root) account via sudo, so the generated key can be owned by that account."
fi
# Resolve and confirm the caller account exists.
id "$CALLER_USER" >/dev/null 2>&1 || fail "caller account '$CALLER_USER' does not exist"
CALLER_UID=$(id -u "$CALLER_USER")
CALLER_GID=$(id -g "$CALLER_USER")
[ "$CALLER_UID" -ne 0 ] || fail "refusing: caller '$CALLER_USER' has uid 0; run from a non-root account."

# Scratch dir for key generation and tests (root-only, 0700).
WORK_TMP=$(mktemp -d 2>/dev/null) || fail "could not create a temp directory"
chmod 700 "$WORK_TMP"

# Required so a misbehaving remote session (e.g. internal-sftp holding a raw
# ssh exec channel open) can never hang this script.
command -v timeout >/dev/null 2>&1 || fail "coreutils 'timeout' is required for safe remote tests"

# --------------------------------------------------------------------------- #
# Imports path + archive/sidecar validation (no untrusted target data accepted)
# --------------------------------------------------------------------------- #

note "imports path: $IMPORTS_PATH"
[ -d "$IMPORTS_PATH" ] || fail "imports directory not found: $IMPORTS_PATH"

# Detect EXACTLY one expected archive + matching sidecar. The version token is
# read from the filesystem (not from input) and must match the strict version RE.
shopt -s nullglob
archives=("$IMPORTS_PATH"/mj-art-master-*.tar.gz)
[ "${#archives[@]}" -eq 1 ] \
    || fail "expected exactly one mj-art-master-*.tar.gz under imports, found ${#archives[@]}"

ARCHIVE_PATH="${archives[0]}"
ARCHIVE_BASE=$(basename "$ARCHIVE_PATH")
MASTER_VERSION=${ARCHIVE_BASE#mj-art-master-}
MASTER_VERSION=${MASTER_VERSION%.tar.gz}

printf '%s' "$MASTER_VERSION" | grep -Eq '^[A-Za-z0-9._-]{1,64}$' \
    || fail "detected archive version token is invalid: $MASTER_VERSION"

SIDECAR_PATH="$IMPORTS_PATH/mj-art-master-${MASTER_VERSION}.sha256"
SIDECAR_BASE=$(basename "$SIDECAR_PATH")
[ -f "$SIDECAR_PATH" ] || fail "sidecar not found for version '$MASTER_VERSION'"

# Require the archive + sidecar to be read-only for everyone (0444 expected).
# This guards against accepting mutable/owner-writable target data.
check_readonly_file() {
    local f="$1" m
    m=$(stat -c '%a' "$f")
    # Reject if owner-write (bit 0200) OR group-write (0020) OR other-write (0002).
    [ $(( 8#$m & 0222 )) -eq 0 ] \
        || fail "$f is writable (mode $m); expected read-only (0444). Refusing mutable target data."
}
check_readonly_file "$ARCHIVE_PATH"
check_readonly_file "$SIDECAR_PATH"

# Run the PROJECT verifier: re-hashes the archive and compares to the strict
# sidecar. Must be run from REPO_ROOT because the script uses relative imports.
note "verifying master archive '$MASTER_VERSION' against its sidecar..."
( cd "$REPO_ROOT" && node scripts/verify-master-archive.mjs \
    --version "$MASTER_VERSION" \
    --archive "$ARCHIVE_PATH" \
    --sidecar "$SIDECAR_PATH" ) \
    || fail "master archive verification failed (sha256 mismatch or bad sidecar)"

# Safe tar-listing validation (rejects symlinks/hardlinks/unsafe paths).
LISTING_FILE="$WORK_TMP/tar_listing.txt"
tar -tvzf "$ARCHIVE_PATH" > "$LISTING_FILE" 2>/dev/null \
    || fail "could not produce a tar verbose listing of the archive"
( cd "$REPO_ROOT" && node scripts/validate-archive-listing.mjs \
    --verbose-listing "$LISTING_FILE" ) \
    || fail "archive listing validation failed (unsafe paths/links refused)"

# Content-expected check: the archive root must contain the three canonical
# top-level entries used by the catalogue import.
mapfile -t TOP_ENTRIES < <(tar -tzf "$ARCHIVE_PATH" | sed -E 's@^\./@@' | awk -F/ '{print $1}' | sort -u)
for expected in originals misc-originals SHA256SUMS; do
    local_found=0
    for e in "${TOP_ENTRIES[@]}"; do
        if [ "$e" = "$expected" ]; then local_found=1; break; fi
    done
    [ "$local_found" -eq 1 ] \
        || fail "archive is missing expected top-level entry: $expected"
done
note "archive verified: sha256 matches sidecar; listing is link-free; content matches expectations."

# --------------------------------------------------------------------------- #
# System user: create or validate (fail closed on unexpected existing account)
# --------------------------------------------------------------------------- #

# Find the nologin shell.
NOLOGIN_SHELL=""
for s in /usr/sbin/nologin /sbin/nologin; do
    if [ -x "$s" ]; then NOLOGIN_SHELL="$s"; break; fi
done
[ -n "$NOLOGIN_SHELL" ] || fail "nologin shell not found (/usr/sbin/nologin or /sbin/nologin)"

if id "$FETCH_USER" >/dev/null 2>&1; then
    note "account '$FETCH_USER' already exists; validating exact expected config..."
    cur_shell=$(getent passwd "$FETCH_USER" | cut -d: -f7)
    cur_home=$(getent passwd "$FETCH_USER" | cut -d: -f6)
    cur_pgroup=$(id -ng "$FETCH_USER")

    [ "$cur_shell" = "$NOLOGIN_SHELL" ] \
        || fail_user_unexpected "login shell is '$cur_shell', expected '$NOLOGIN_SHELL'"
    [ "$cur_home" = "$FETCH_HOME" ] \
        || fail_user_unexpected "home is '$cur_home', expected '$FETCH_HOME'"
    [ "$cur_pgroup" = "$FETCH_USER" ] \
        || fail_user_unexpected "primary group is '$cur_pgroup', expected '$FETCH_USER'"

    # Must not be in the developers group (that would grant repository write).
    if id -nG "$FETCH_USER" | tr ' ' '\n' | grep -qx developers; then
        fail_user_unexpected "account is a member of the 'developers' group (would grant write)"
    fi

    # Password must be locked.
    pw_status=$(passwd -S "$FETCH_USER" 2>/dev/null | awk '{print $2}')
    [ "$pw_status" = "L" ] \
        || fail_user_unexpected "password status is '$pw_status', expected 'L' (locked)"

    note "existing '$FETCH_USER' matches expected config; preserving."
else
    note "creating system account '$FETCH_USER' (nologin, locked, own group)..."
    useradd \
        --system \
        --shell "$NOLOGIN_SHELL" \
        --home-dir "$FETCH_HOME" \
        --create-home \
        --user-group \
        "$FETCH_USER"

    # Lock the password (no password login possible). Key auth still works for
    # the forced internal-sftp command; the nologin shell blocks any shell.
    passwd -l "$FETCH_USER" >/dev/null

    # Sanity: confirm what we just created.
    cur_pgroup=$(id -ng "$FETCH_USER")
    [ "$cur_pgroup" = "$FETCH_USER" ] \
        || fail "unexpected primary group '$cur_pgroup' after useradd"
    note "account '$FETCH_USER' created and password-locked."
fi

# Ensure home is owned by the account, not group/other writable (StrictModes).
chown "$FETCH_USER:$FETCH_USER" "$FETCH_HOME"
chmod 755 "$FETCH_HOME"

# --------------------------------------------------------------------------- #
# Filesystem access for mjart-fetch (traverse ancestors; read+list imports)
# --------------------------------------------------------------------------- #
#
# The account must reach imports. We prefer the LEAST privilege: if a directory
# is already traversable (or readable) via "other" perms (the common case here,
# because the chain is 0755), we touch nothing. Only when an ancestor is NOT
# traversable do we add a minimal named ACL (execute only) for mjart-fetch; and
# only when imports is NOT readable do we add read+list. We NEVER grant write,
# and we NEVER add mjart-fetch to the developers group.

has_other_x() {
    # True if the "other" execute bit is set on $1 (world-traversable).
    local m
    m=$(stat -c '%a' "$1" 2>/dev/null) || return 1
    case "$m" in *[1357]) return 0 ;; esac
    return 1
}
has_other_rx() {
    # True if "other" has read+execute on $1 (world-readable+listable).
    local m
    m=$(stat -c '%a' "$1" 2>/dev/null) || return 1
    case "$m" in *[57]) return 0 ;; esac
    return 1
}

grant_traverse_if_needed() {
    local d="$1"
    if has_other_x "$d"; then return 0; fi
    if [ -n "$SETFACL" ]; then
        setfacl -m "u:$FETCH_USER:x" "$d" \
            || fail "setfacl failed to grant traverse on $d"
        note "ACL: granted traverse (x) only for $FETCH_USER on $d"
    else
        fail "$d is not traversable by others and setfacl is unavailable; cannot safely grant $FETCH_USER access without widening perms."
    fi
}

grant_read_if_needed() {
    local d="$1"
    if has_other_rx "$d"; then return 0; fi
    if [ -n "$SETFACL" ]; then
        setfacl -m "u:$FETCH_USER:rx" "$d" \
            || fail "setfacl failed to grant read+list on $d"
        note "ACL: granted read+list (rx) only for $FETCH_USER on $d (no write)"
    else
        fail "$d is not readable by others and setfacl is unavailable; cannot safely grant $FETCH_USER read access."
    fi
}

# Build the directory chain from "/" down to imports (inclusive).
dir_chain=()
_cur="$IMPORTS_PATH"
while [ -n "$_cur" ] && [ "$_cur" != "/" ]; do
    dir_chain=("$_cur" "${dir_chain[@]}")
    _cur=$(dirname "$_cur")
done
dir_chain=("/" "${dir_chain[@]}")

for _d in "${dir_chain[@]}"; do
    if [ "$_d" = "$IMPORTS_PATH" ]; then
        grant_read_if_needed "$_d"     # imports: read + list only
    else
        grant_traverse_if_needed "$_d" # ancestors: traverse only
    fi
done

# --------------------------------------------------------------------------- #
# Host public key (for the known_hosts file the runner will pin)
# --------------------------------------------------------------------------- #

[ -r "$HOST_PUB_FILE" ] || fail "cannot read host ed25519 public key at $HOST_PUB_FILE"
HOST_PUB=$(cat "$HOST_PUB_FILE")
printf '%s' "$HOST_PUB" | grep -Eq '^ssh-ed25519 [A-Za-z0-9+/=]+( .*)?$' \
    || fail "host public key at $HOST_PUB_FILE is malformed"

# --------------------------------------------------------------------------- #
# Generate a fresh ed25519 keypair in root-only scratch space
# --------------------------------------------------------------------------- #

KEYFILE="$WORK_TMP/vps_ed25519"
# Empty passphrase (-N ''); the key is protected by file permissions, not a
# passphrase, because GitHub Actions must use it unattended.
ssh-keygen -q -t ed25519 -N '' -C "$FETCH_KEY_COMMENT" -f "$KEYFILE" \
    || fail "ssh-keygen failed"
chmod 600 "$KEYFILE"

PUB_LINE=$(cat "${KEYFILE}.pub")
printf '%s' "$PUB_LINE" | grep -Eq '^ssh-ed25519 [A-Za-z0-9+/=]+( .*)?$' \
    || fail "generated public key is malformed"

# The single forced authorized_keys entry. The command locks every connection
# to internal-sftp starting at imports; "restrict" disables PTY, X11, agent,
# and all port forwarding. No other keys are installed.
AK_ENTRY="command=\"internal-sftp -d ${IMPORTS_PATH}\",restrict ${PUB_LINE}"

# --------------------------------------------------------------------------- #
# sshd drop-in: narrow Match snippet forcing internal-sftp (defense-in-depth)
# --------------------------------------------------------------------------- #
#
# The authorized_keys forced command (below) is the PRIMARY confinement, but it
# can fail to start on some host/ssh-shell combinations (e.g. when the account
# shell is nologin, the authorized_keys command= may never execute). To make
# forced SFTP robust, this section ALSO enforces it at the sshd level with a
# narrowly-scoped "Match User mjart-fetch" drop-in snippet. It:
#   - Verifies /etc/ssh/sshd_config already Includes a sshd_config.d/*.conf
#     drop-in dir (fail-closed; never edits the main config).
#   - Writes ONE root-owned 0644 marker-delimited snippet containing ONLY the
#     Match block (no global options, so it weakens no other setting).
#   - Validates the FULL config with `sshd -t` before reloading.
#   - Proves the GLOBAL effective config is byte-identical before/after (no
#     drift/leakage) and the per-user effective config (sshd -T -C) matches.
#   - Reloads sshd only after validation; on reload failure restores the prior
#     (absent) snippet, reloads, verifies, and fails loudly.

SSH_BIN=$(command -v sshd 2>/dev/null || true)
[ -n "$SSH_BIN" ] || fail "sshd binary not found; cannot enforce ForceCommand daemon-side"

detect_sshd_snippet_dir() {
    # Echo the sshd_config.d dir if the main config Includes one; else fail closed.
    local main=/etc/ssh/sshd_config targets t dir found=""
    [ -f "$main" ] || fail "$main not found; cannot verify Include support for a drop-in snippet"
    targets=$(grep -iE '^[[:space:]]*Include[[:space:]]+' "$main" \
        | sed -E 's/^[[:space:]]*[Ii]nclude[[:space:]]+//; s/[[:space:]]+$//; s/^['"'"'\"]+//; s/['"'"'\"]+$//')
    if [ -z "$targets" ]; then
        cat >&2 <<EOF
[setup] FAIL (fail closed): $main has no Include directive that reads a drop-in
directory. This script refuses to edit the main sshd_config; it can only drop a
narrowly-scoped Match snippet into an existing sshd_config.d/*.conf include dir.
Have an operator add (manually, once), near the top of $main:
    Include /etc/ssh/sshd_config.d/*.conf
then reload sshd, then re-run this script.
EOF
        exit 1
    fi
    while IFS= read -r t; do
        [ -n "$t" ] || continue
        case "$t" in /*) ;; *) t="/etc/ssh/$t" ;; esac
        case "$t" in
            */sshd_config.d/*|*/sshd_config.d)
                dir=$(printf '%s' "$t" | sed -E 's@(.*sshd_config\.d).*@\1@')
                if [ -d "$dir" ]; then found="$dir"; break; fi
                ;;
        esac
    done <<EOF
$targets
EOF
    [ -n "$found" ] \
        || fail "Include present in $main but no readable sshd_config.d directory target found (refusing to edit main config). Include pattern(s): $(printf '%s' "$targets" | tr '\n' ' ')"
    printf '%s' "$found"
}

SNIPPET_DIR=$(detect_sshd_snippet_dir)
SNIPPET_BASENAME="90-mjart-fetch.conf"
SNIPPET_PATH="$SNIPPET_DIR/$SNIPPET_BASENAME"

build_snippet_content() {
    # Marker-delimited, ONLY a Match block. Heredoc is UNQUOTED so the account
    # and imports path expand at runtime.
    cat <<SNIPPET
# $SNIPPET_BASENAME - MANAGED by scripts/setup-mjart-vps-fetch-access.sh
# Narrowly-scoped forced-SFTP confinement for the read-only MJ-ART catalogue
# import account "$FETCH_USER". DO NOT EDIT BY HAND: re-run the setup script to
# change, or remove this file and reload sshd to revert. This file sets NO
# global options; it contains ONLY a Match User block, so it weakens no other
# sshd setting. Defense-in-depth with the account authorized_keys forced
# command (sshd ForceCommand takes precedence; both pin the same internal-sftp).
# BEGIN MJ-ART FETCH MANAGED SNIPPET
Match User $FETCH_USER
    ForceCommand internal-sftp -d $IMPORTS_PATH
    DisableForwarding yes
    AllowTcpForwarding no
    X11Forwarding no
    PermitTTY no
# END MJ-ART FETCH MANAGED SNIPPET
SNIPPET
}

# --- Effective-state helpers (read config only; print no secrets/keys) -------

dump_effective_global() {
    # Global (unconditional) effective config to $1.
    "$SSH_BIN" -T >"$1" 2>"$WORK_TMP/ssht.err" \
        || { cat "$WORK_TMP/ssht.err" >&2 || true; return 1; }
}

dump_effective_user() {
    # Per-user effective config for FETCH_USER to $1.
    "$SSH_BIN" -T -C "user=$FETCH_USER,addr=127.0.0.1,host=localhost" \
        >"$1" 2>"$WORK_TMP/sshtc.err" \
        || { cat "$WORK_TMP/sshtc.err" >&2 || true; return 1; }
}

expect_key() {
    # Assert effective file $1 has a line "^$2 <val>"; $4 is a human label.
    local file="$1" key="$2" val="$3" label="$4" line got
    line=$(grep -iE "^${key}[[:space:]]+" "$file" | head -n1)
    got=$(printf '%s' "$line" | sed -E 's/^[^[:space:]]+[[:space:]]+//; s/[[:space:]]+$//')
    if [ "$got" != "$val" ]; then
        note "effective '$key' for $FETCH_USER was '$got', expected '$val' ($label)"
        return 1
    fi
    return 0
}

print_effective_diagnostics() {
    note "relevant effective sshd settings for $FETCH_USER (non-secret; no key material):"
    if dump_effective_user "$WORK_TMP/diag.txt"; then
        grep -iE '^(forcecommand|permittty|allowtcpforwarding|x11forwarding|disableforwarding|permittunnel|allowagentforwarding|subsystem|permitrootlogin|passwordauthentication)\b' \
            "$WORK_TMP/diag.txt" >&2 || true
    fi
    note "to inspect server-side sshd logs WITHOUT exposing any secret or key:"
    note "    sudo journalctl -u ssh -u sshd --since '10 min ago'   # systemd"
    note "    sudo tail -n 300 /var/log/auth.log                    # Debian/Ubuntu"
}

verify_user_effective() {
    dump_effective_user "$WORK_TMP/sshd_user.eff" || return 1
    expect_key "$WORK_TMP/sshd_user.eff" "forcecommand" "internal-sftp -d $IMPORTS_PATH" "forced SFTP root" || return 1
    expect_key "$WORK_TMP/sshd_user.eff" "disableforwarding" "yes" "all forwarding disabled" || return 1
    expect_key "$WORK_TMP/sshd_user.eff" "allowtcpforwarding" "no" "no TCP forwarding" || return 1
    expect_key "$WORK_TMP/sshd_user.eff" "x11forwarding" "no" "no X11 forwarding" || return 1
    expect_key "$WORK_TMP/sshd_user.eff" "permittty" "no" "no PTY" || return 1
    return 0
}

rollback_snippet() {
    # Restore the prior (absent) state: we only ever CREATE this snippet, so
    # rollback is removal. Best-effort; caller fails loudly regardless.
    if [ "${SNIPPET_NEEDS_WRITE:-0}" -eq 1 ] && [ -e "$SNIPPET_PATH" ]; then
        rm -f "$SNIPPET_PATH"
        note "rolled back: removed $SNIPPET_PATH (restored prior absent state)"
    fi
}

reload_sshd_safe() {
    # Returns 0 on success, 1 if no reload mechanism worked. Safe (SIGHUP/reload
    # only; no restart, no config mutation).
    if command -v systemctl >/dev/null 2>&1; then
        systemctl reload ssh.service 2>/dev/null && { note "sshd reloaded (systemctl reload ssh.service)"; return 0; }
        systemctl reload sshd.service 2>/dev/null && { note "sshd reloaded (systemctl reload sshd.service)"; return 0; }
    fi
    if command -v service >/dev/null 2>&1; then
        service ssh reload 2>/dev/null && { note "sshd reloaded (service ssh reload)"; return 0; }
        service sshd reload 2>/dev/null && { note "sshd reloaded (service sshd reload)"; return 0; }
    fi
    if command -v pgrep >/dev/null 2>&1; then
        local master
        master=$(pgrep -ox sshd 2>/dev/null || true)
        if [ -n "$master" ] && kill -HUP "$master" 2>/dev/null; then
            note "sshd reloaded (SIGHUP to sshd pid $master)"; return 0
        fi
    fi
    return 1
}

# --- Idempotency: exact-match or fail closed (never overwrite unexpected) -----
SNIPPET_EXPECTED=$(build_snippet_content)
SNIPPET_PRIOR_EXISTS=0
if [ -e "$SNIPPET_PATH" ]; then
    SNIPPET_PRIOR_EXISTS=1
    if [ "$(cat "$SNIPPET_PATH")" = "$SNIPPET_EXPECTED" ]; then
        note "sshd snippet already managed and exact: $SNIPPET_PATH"
        SNIPPET_NEEDS_WRITE=0
    else
        cat >&2 <<EOF
[setup] FAIL (fail closed): $SNIPPET_PATH already exists but does NOT match the
expected managed content. Refusing to overwrite an unexpected snippet. Inspect
it; if YOU created it and it is safe to remove:
    sudo cat $SNIPPET_PATH
    sudo rm $SNIPPET_PATH && (sudo systemctl reload ssh || sudo service ssh reload)
then re-run this script.
EOF
        exit 1
    fi
else
    SNIPPET_NEEDS_WRITE=1
fi

# Capture the GLOBAL baseline BEFORE any write, to prove zero drift afterwards.
dump_effective_global "$WORK_TMP/sshd_global.before" \
    || fail "sshd -T baseline failed (cannot prove no global weakening)"

# --- Write the snippet (only when absent; root-owned 0644, marker-delimited) --
if [ "$SNIPPET_NEEDS_WRITE" -eq 1 ]; then
    note "writing sshd snippet: $SNIPPET_PATH"
    printf '%s\n' "$SNIPPET_EXPECTED" > "$WORK_TMP/snippet.new"
    chown root:root "$WORK_TMP/snippet.new"
    chmod 0644 "$WORK_TMP/snippet.new"
    install -m 0644 -o root -g root "$WORK_TMP/snippet.new" "$SNIPPET_PATH"
    # Enforce ownership/mode invariant; rollback + fail if not exact.
    [ "$(stat -c '%U:%G' "$SNIPPET_PATH")" = "root:root" ] \
        || { rollback_snippet; fail "$SNIPPET_PATH not root:root after install"; }
    [ "$(stat -c '%a' "$SNIPPET_PATH")" = "644" ] \
        || { rollback_snippet; fail "$SNIPPET_PATH mode not 0644 after install"; }
fi

# --- Validate the FULL config syntax before reload ---------------------------
if ! "$SSH_BIN" -t >"$WORK_TMP/sshd_t.out" 2>"$WORK_TMP/sshd_t.err"; then
    cat "$WORK_TMP/sshd_t.err" >&2 || true
    rollback_snippet
    fail "sshd -t FAILED after writing snippet; snippet removed, sshd config unchanged"
fi

# --- Prove the snippet did NOT change any GLOBAL effective setting ------------
if ! dump_effective_global "$WORK_TMP/sshd_global.after"; then
    rollback_snippet
    fail "sshd -T post-write dump failed; rolled back"
fi
if ! diff -u "$WORK_TMP/sshd_global.before" "$WORK_TMP/sshd_global.after" >"$WORK_TMP/global.diff" 2>&1; then
    cat "$WORK_TMP/global.diff" >&2 || true
    rollback_snippet
    fail "GLOBAL sshd effective config CHANGED after adding snippet (leakage/weakening); snippet removed"
fi
note "global sshd effective config unchanged (zero drift)."

# --- Verify the per-user EFFECTIVE settings match exactly --------------------
if ! verify_user_effective; then
    print_effective_diagnostics
    rollback_snippet
    fail "effective sshd settings for $FETCH_USER do not match the expected confinement (possible shadowing by an earlier Match block)"
fi
note "sshd -T -C effective confinement verified for $FETCH_USER."

# --- Reload sshd safely (only after validation); rollback + fail on failure ---
if [ "$SNIPPET_NEEDS_WRITE" -eq 1 ]; then
    note "reloading sshd (validated; safe)..."
    if ! reload_sshd_safe; then
        rollback_snippet
        reload_sshd_safe || note "WARN: could not reload sshd after rollback either (apply reload manually)"
        if "$SSH_BIN" -t >/dev/null 2>&1; then
            note "sshd -t OK after rollback"
        else
            fail "sshd -t FAILED after rollback; investigate $SNIPPET_PATH / main config manually"
        fi
        fail "sshd reload failed; snippet removed and config reverted. Resolve the reload mechanism, then re-run."
    fi
    # Post-reload re-verification (config files still correct + effective).
    "$SSH_BIN" -t >/dev/null 2>&1 || { rollback_snippet; fail "sshd -t FAILED after reload; snippet removed"; }
    if ! verify_user_effective; then
        print_effective_diagnostics
        rollback_snippet
        fail "post-reload effective settings drifted from expected; snippet removed"
    fi
    note "sshd reloaded and confinement re-verified."
fi

# --------------------------------------------------------------------------- #
# Install authorized_keys (root-owned) for the account
# --------------------------------------------------------------------------- #

install -d -m 0700 -o root -g root "$FETCH_HOME/.ssh"
# Write atomically through a temp file in the same dir, then install.
printf '%s\n' "$AK_ENTRY" > "$FETCH_HOME/.ssh/authorized_keys.new"
chown root:root "$FETCH_HOME/.ssh/authorized_keys.new"
chmod 0600 "$FETCH_HOME/.ssh/authorized_keys.new"
mv -f "$FETCH_HOME/.ssh/authorized_keys.new" "$FETCH_HOME/.ssh/authorized_keys"

# Verify there is exactly ONE key line (no stray keys).
_ak_lines=$(grep -cvE '^[[:space:]]*(#.*)?$' "$FETCH_HOME/.ssh/authorized_keys" || true)
[ "$_ak_lines" -eq 1 ] \
    || fail "authorized_keys must contain exactly one key line, found $_ak_lines"

note "installed forced-command authorized_keys for '$FETCH_USER' (root-owned, one key)."

# --------------------------------------------------------------------------- #
# Place the private key + known_hosts in protected, caller-owned files
# --------------------------------------------------------------------------- #

CALLER_HOME=$(getent passwd "$CALLER_USER" | cut -d: -f6)
[ -n "$CALLER_HOME" ] && [ -d "$CALLER_HOME" ] \
    || fail "caller home directory not found for '$CALLER_USER'"

CALLER_KEYDIR="$CALLER_HOME/$CALLER_KEYDIR_REL"
CALLER_KEYFILE="$CALLER_KEYDIR/$CALLER_KEY_NAME"
CALLER_KH_FILE="$CALLER_KEYDIR/$CALLER_KH_NAME"

install -d -m 0700 -o "$CALLER_UID" -g "$CALLER_GID" "$CALLER_KEYDIR"

# Private key: copy with 0600 and caller ownership (never printed).
install -m 0600 -o "$CALLER_UID" -g "$CALLER_GID" "$KEYFILE" "$CALLER_KEYFILE"

# Known hosts: plain (non-hashed) OpenSSH line. For port 22 the host token is
# the bare host (matching how ssh looks up default-port hosts); for any other
# port it is [host]:port. Built from the LOCAL host public key only (no network
# scan).
if [ "$PORT" -eq 22 ]; then
    KH_TOKEN="$HOST"
else
    KH_TOKEN="[${HOST}]:${PORT}"
fi
printf '%s %s\n' "$KH_TOKEN" "$HOST_PUB" > "$WORK_TMP/known_hosts"
install -m 0600 -o "$CALLER_UID" -g "$CALLER_GID" "$WORK_TMP/known_hosts" "$CALLER_KH_FILE"

note "private key -> $CALLER_KEYFILE"
note "known_hosts -> $CALLER_KH_FILE"

# --------------------------------------------------------------------------- #
# Local functional tests via loopback (127.0.0.1). No network scan.
# --------------------------------------------------------------------------- #
#
# These prove the running sshd honours the forced command and the filesystem
# rights, WITHOUT relying on external reachability of --host.

TEST_DIR="$WORK_TMP/sftp_test"
install -d -m 0700 "$TEST_DIR"

# Hard ceiling for any single remote test, so a stalled session cannot hang.
REMOTE_TEST_TIMEOUT=30

COMMON_SSH_OPTS=(
    -o BatchMode=yes
    -o StrictHostKeyChecking=no
    -o UserKnownHostsFile=/dev/null
    -o GlobalKnownHostsFile=/dev/null
    -o PasswordAuthentication=no
    -o KbdInteractiveAuthentication=no
    -o PreferredAuthentications=publickey
    -o PubkeyAuthentication=yes
    -o IdentitiesOnly=yes
    -o ConnectTimeout=10
    -o ServerAliveInterval=5
    -o ServerAliveCountMax=3
    -o LogLevel=ERROR
    -i "$CALLER_KEYFILE"
)
SFTP_OPTS=(-b - -q -P "$PORT" "${COMMON_SSH_OPTS[@]}")
SSH_OPTS=(-p "$PORT" "${COMMON_SSH_OPTS[@]}")
TARGET="${FETCH_USER}@127.0.0.1"

# --- Positive: retrieve archive + sidecar; require exact sha256 match -------
note "positive test: SFTP get archive + sidecar via loopback..."
if ! timeout "$REMOTE_TEST_TIMEOUT" sftp "${SFTP_OPTS[@]}" "$TARGET" > /dev/null 2>"$WORK_TMP/sftp_pos.err" <<EOF
get ${IMPORTS_PATH}/${ARCHIVE_BASE} ${TEST_DIR}/${ARCHIVE_BASE}
get ${IMPORTS_PATH}/${SIDECAR_BASE} ${TEST_DIR}/${SIDECAR_BASE}
bye
EOF
then
    cat "$WORK_TMP/sftp_pos.err" >&2 || true
    fail "positive test: sftp get failed (check sshd, forced command, and filesystem perms)"
fi

[ -s "$TEST_DIR/$ARCHIVE_BASE" ] || fail "positive test: archive was not retrieved"
[ -s "$TEST_DIR/$SIDECAR_BASE" ] || fail "positive test: sidecar was not retrieved"

orig_arc=$(sha256sum "$IMPORTS_PATH/$ARCHIVE_BASE" | awk '{print $1}')
got_arc=$(sha256sum "$TEST_DIR/$ARCHIVE_BASE" | awk '{print $1}')
[ "$orig_arc" = "$got_arc" ] || fail "positive test: retrieved archive sha256 differs from source"

orig_sid=$(sha256sum "$IMPORTS_PATH/$SIDECAR_BASE" | awk '{print $1}')
got_sid=$(sha256sum "$TEST_DIR/$SIDECAR_BASE" | awk '{print $1}')
[ "$orig_sid" = "$got_sid" ] || fail "positive test: retrieved sidecar sha256 differs from source"
note "positive test OK: archive + sidecar retrieved with matching sha256."

# --- Negative 1: upload to imports must be denied --------------------------
note "negative test: upload to imports must be denied..."
PROBE_LOCAL="$TEST_DIR/probe.txt"
printf 'denied\n' > "$PROBE_LOCAL"
PROBE_REMOTE="${IMPORTS_PATH}/.mjart-fetch-probe-$$"

timeout "$REMOTE_TEST_TIMEOUT" sftp "${SFTP_OPTS[@]}" "$TARGET" > /dev/null 2>"$WORK_TMP/sftp_neg1.err" <<EOF || true
put ${PROBE_LOCAL} ${PROBE_REMOTE}
EOF

# The probe file must NOT exist in imports, whatever sftp returned. We never
# delete from imports; if a file appeared, that is a hard failure.
if [ -e "$PROBE_REMOTE" ]; then
    fail "negative test FAILED: upload to imports SUCCEEDED (probe created at $PROBE_REMOTE). The account must not be able to write imports."
fi
note "negative test OK: upload to imports was denied (no file created)."

# --- Negative 2: remote shell/exec command must be denied -------------------
note "negative test: remote shell command must be denied..."
# Forced internal-sftp may hold a raw exec channel open (it waits for SFTP
# packets that never arrive), so this is wrapped in timeout().
shell_out=$(timeout "$REMOTE_TEST_TIMEOUT" ssh "${SSH_OPTS[@]}" "$TARGET" 'printf SHOULD_NOT_SUCCEED' 2>/dev/null || true)
if printf '%s' "$shell_out" | grep -q 'SHOULD_NOT_SUCCEED'; then
    fail "negative test FAILED: a remote shell command executed and produced output. The forced command did not lock the session to SFTP."
fi
note "negative test OK: remote shell command was denied."

note "all tests passed."

# --------------------------------------------------------------------------- #
# Success: print ONLY the next safe (manual, GitHub-side) command.
# VPS_ASSETS_CONFIRMED is deliberately EXCLUDED from this block.
# --------------------------------------------------------------------------- #

cat <<EOF

================================================================
 MJ-ART VPS fetch access: LOCAL setup complete.
================================================================
 Account          : $FETCH_USER (locked, nologin, forced internal-sftp, restrict)
 Exposed root     : $IMPORTS_PATH  (read+list only; no write)
 Master version   : $MASTER_VERSION
 Private key file : $CALLER_KEYFILE   (owner: $CALLER_USER, mode 0600)
 Known hosts file : $CALLER_KH_FILE   (owner: $CALLER_USER, mode 0600)
 Pinned host      : $HOST:$PORT
 sshd snippet     : $SNIPPET_PATH  (root:root 0644; managed Match block;
                   fail-closed/validated/reverts on reload failure)

 IMPORTANT - two things to know before the first end-to-end fetch:

 1. --host must be the address GitHub Actions can reach. '$HOST' was not
    verified for external reachability by this script; confirm it resolves to
    THIS VPS from outside before relying on it.

  2. WORKFLOW TRANSPORT: the catalogue-import workflow fetches via the SFTP
     protocol (the scp default; NO legacy -O switch) to match this forced
     internal-sftp account. The legacy scp -O protocol requires a remote shell,
     which the forced-command account denies; it must never be re-added. This
     script makes NO GitHub-side change; it only documents the required transport.
     Forced SFTP is enforced BOTH at the sshd level (the managed Match snippet
     above) AND at the authorized_keys level (command=...,restrict) for
     defense-in-depth.

 NEXT (run these yourself - this script makes NO GitHub changes).
 Set the secrets/variables from the protected files. Do NOT set
 VPS_ASSETS_CONFIRMED yet:

  # secrets (values read from the protected files; never pasted in chat)
  gh secret set VPS_SSH_PRIVATE_KEY < "$CALLER_KEYFILE"
  gh secret set VPS_KNOWN_HOSTS     < "$CALLER_KH_FILE"

  # variables
  gh variable set VPS_HOST        --body "$HOST"
  gh variable set VPS_PORT        --body "$PORT"
  gh variable set VPS_USER        --body "$FETCH_USER"
  gh variable set VPS_MASTER_ROOT --body "$IMPORTS_PATH"

 Then: dry-run the catalogue-import workflow (confirm_preview_only on,
 execute_upload off). Only after a successful end-to-end fetch, set the
 one-time attestation LAST and separately:

  gh variable set VPS_ASSETS_CONFIRMED --body "true"

 (deliberately not included above - it is the final manual gate.)

================================================================
EOF

exit 0
