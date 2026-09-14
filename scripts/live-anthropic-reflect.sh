#!/usr/bin/env bash
#
# live-anthropic-reflect.sh — run `kgmem reflect` against the real Anthropic
# Messages API without the API key ever being printed, logged, written to disk,
# or placed anywhere an agent or another user on this box can read it.
#
# This is operator tooling. It contains no production logic and nothing in
# src/ imports it. [RGR EXEMPT: operator tooling, no production logic]
#
# ── Why this is a shell script and not a .ts like its neighbours ─────────────
#
# `spike-s2-embeddings.ts` and `f9-retirement-cost.ts` are measurement harnesses
# that need the store's own types, so TypeScript is the cheaper language for
# them. This script's entire job is the opposite: move one string from a file
# into one child process's *environment* and get out of the way. Three reasons
# the shell wins here.
#
#   1. The mechanism is one auditable line. `export` inside a subshell that then
#      `exec`s is the whole security design (see `run_drain`), and a reader can
#      confirm it by eye. A Node parent would have to build an env object,
#      spawn, and thread stdio — more moving parts around the same secret, none
#      of which the reader can check without trusting the runtime.
#   2. A Node parent holds the key in a garbage-collected heap. That heap lands
#      in core dumps, in `--heap-prof` output, and in an unhandled-rejection
#      trace that prints `process.env`. A bash variable is a single freeable
#      string in a process that does nothing else.
#   3. `--check` must run with zero project setup. The point of `--check` is to
#      let the operator audit the disclosure surface *before* trusting this
#      script with a key, so it cannot require node, tsx, or an install to have
#      happened first. It depends only on bash and sha256sum.
#
# ── Threat model ────────────────────────────────────────────────────────────
#
# The adversary is not a remote attacker; it is routine developer behaviour that
# copies secrets into places that are backed up, shared, or replayed. Each vector
# below has a named defence in this file.
#
#   argv exposure. `/proc/<pid>/cmdline` is world-readable, so anything on a
#     command line is visible to every user on this box and to every `ps` that
#     any tool runs. The key is therefore NEVER an argument — not to `node`, not
#     to `env`, not to `sha256sum`. It travels only in the child's environment,
#     which the kernel exposes at `/proc/<pid>/environ` under mode 0400 owned by
#     this user. Fingerprinting uses bash's *builtin* `printf` piped into
#     `sha256sum`; a builtin forks no process, so no cmdline is ever created.
#
#   shell tracing. `bash -x scripts/live-anthropic-reflect.sh` would print every
#     expansion of the key. `set +x` on the first executable line disables
#     tracing before the key is read, and this script never enables it.
#
#   disk. The key is never written anywhere: no temp file, no cache, no log. In
#     particular this script does not use a here-string (`<<<`), because bash
#     may implement one by spilling its contents to a file under $TMPDIR.
#
#   over-reading the source file. Both candidate .env files hold other secrets
#     besides the Anthropic key. This script never `source`s or `export`s the
#     file — sourcing would execute arbitrary code as the operator and pull
#     every unrelated credential into this process. It parses one line with a
#     bash regex and ignores the rest of the file entirely.
#
#   the parent shell. The key is held in an ordinary (non-exported) shell
#     variable, so it is absent from the environment of every process this
#     script starts except the one drain child, which gets it via an `export`
#     scoped to a subshell that is immediately replaced by `exec`.
#
#   failure-path leakage. The classic leak is echoing the offending value when
#     validation fails. Every refusal here names the *file* to go fix and
#     reports only shape (length, format marker), never content.
#
#   wrong-billing-account. The env file has no default and must be named
#     explicitly: this repo's operator has more than one candidate .env, each
#     with a different key, so a default would silently pick a billing account.
#     For the same reason two ANTHROPIC_API_KEY assignments in one file is a
#     refusal rather than a last-one-wins guess.
#
# ── Modes ───────────────────────────────────────────────────────────────────
#
#   --check                    Prove a usable key is present without revealing
#                              it. Makes no network call. See `mode_check` for
#                              the exact disclosure surface.
#   (default)                  Export the key into one child and run
#                              `kgmem reflect`. THIS SPENDS MONEY.
#   --dry-run                  Print the exact child argv and the names (never
#                              values) of the environment variables it would be
#                              given, and exit without spawning anything.
#   --print-extractor-module   Emit the extractor module source `.kgmem/config.json`
#                              must name. Writes nothing; redirect it yourself.
#
# Usage:
#   scripts/live-anthropic-reflect.sh --check --env-file PATH
#   scripts/live-anthropic-reflect.sh --env-file PATH --workspace DIR [--dry-run]
#   scripts/live-anthropic-reflect.sh --print-extractor-module
#
# The env file may also be named by KGMEM_ANTHROPIC_ENV_FILE. There is no default.

# Tracing off before anything sensitive is in scope, in case the operator (or a
# wrapper) invoked us with `bash -x`. Only this header has been traced by now.
set +x
set +v
set -euo pipefail
IFS=$'\n\t'

# Sourcing would leave the key in an interactive shell's memory and put this
# file's `exit` calls in charge of the operator's session. Refuse.
if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
  echo "ERROR: run this script, do not source it (sourcing keeps the key in your shell)." >&2
  return 1 2>/dev/null || exit 1
fi

readonly SCRIPT_NAME="${0##*/}"
readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(dirname "$SCRIPT_DIR")"

# The public format marker Anthropic keys carry. Not a secret; it appears in
# Anthropic's own documentation and is what makes "this is a key, not a typo"
# checkable without disclosing anything.
readonly KEY_PREFIX='sk-ant-'

# A floor, not a spec. Real keys are ~100 characters; this only has to be long
# enough to reject placeholders like `sk-ant-xxxxx` that would otherwise reach
# the API and burn a request to learn they were never keys.
readonly MIN_KEY_LENGTH=40

# How much of the SHA-256 to disclose. 12 hex characters is 48 bits: ample to
# tell two candidate files apart or to confirm a rotation happened, and useless
# for recovering a ~100-character key.
readonly FINGERPRINT_CHARS=12

# The key, once read. Deliberately a plain shell variable and never `export`ed:
# an exported variable is inherited by *every* child, including the `sha256sum`
# and `node -e` helpers below, which have no business seeing it.
KEY_VALUE=''

# Best-effort scrub. The process is about to die anyway, so this is mostly a
# statement of intent — but it also covers the `--dry-run` and validation paths
# that fall through to a normal exit with the key still in scope.
cleanup() { KEY_VALUE=''; }
trap cleanup EXIT

info() { printf '%s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }

# Every refusal routes through here. It takes a message, never a value: there is
# no code path in this file that can print key material on failure.
die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  # Held in the header rather than duplicated: print the comment block's usage.
  cat <<'USAGE'
live-anthropic-reflect.sh — run `kgmem reflect` against the live Anthropic API
without the key being printed, logged, or written to disk.

  --check                     Prove a usable key exists; discloses only length,
                              the sk-ant- format marker, and a 12-hex-character
                              SHA-256 prefix. No network call.
  --env-file PATH             The .env holding ANTHROPIC_API_KEY. REQUIRED, no
                              default (a default would pick a billing account).
                              May also be given as KGMEM_ANTHROPIC_ENV_FILE.
  --workspace DIR             The kgmem workspace to drain. REQUIRED for a run.
                              Must contain .kgmem/config.json directly.
  --dry-run                   Print the child argv and the injected variable
                              NAMES, then exit without spawning.
  --print-extractor-module    Emit the extractor module source to stdout.
  -h, --help                  This text.

Examples:
  scripts/live-anthropic-reflect.sh --check --env-file ~/dev/some-project/.env
  scripts/live-anthropic-reflect.sh --env-file ~/dev/some-project/.env \
      --workspace ~/kgmem-live --dry-run
USAGE
}

# ── Reading the key ─────────────────────────────────────────────────────────

##
# Parse ANTHROPIC_API_KEY out of an env file into the global KEY_VALUE.
#
# Pure bash, deliberately. `grep` would work, but then the value crosses a
# process boundary through a pipe and lives briefly in a second process's
# memory; a `while read` loop keeps it inside this one. The rest of the file is
# never interpreted, so the other secrets these files hold are never touched.
#
# Handles: `export` prefixes, single/double quoting, surrounding whitespace, and
# CRLF line endings. It does NOT strip trailing `#` comments — a key is opaque
# and stripping on a character that could legally appear in one risks silently
# truncating a valid key into an authentication failure nobody can explain.
#
# Two assignments is a refusal, not a last-one-wins guess: dotenv
# implementations disagree about which wins (node's `dotenv` takes the first,
# python-dotenv the last), and guessing means guessing a billing account.
##
read_key_from_env_file() {
  local file="$1"
  local line matches=0

  [[ -e "$file" ]] || die "no such file: ${file}"
  [[ -f "$file" ]] || die "not a regular file: ${file}"
  [[ -r "$file" ]] || die "not readable by this user: ${file}"

  # `|| [[ -n $line ]]` so a final line with no trailing newline is still seen;
  # `IFS=` and `-r` so whitespace and backslashes in the value survive verbatim.
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    if [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?ANTHROPIC_API_KEY[[:space:]]*=(.*)$ ]]; then
      matches=$((matches + 1))
      KEY_VALUE="${BASH_REMATCH[2]}"
    fi
  done <"$file"

  if ((matches == 0)); then
    die "no ANTHROPIC_API_KEY assignment in ${file} (commented-out lines do not count). Add one there, or point --env-file at the file that has it."
  fi
  if ((matches > 1)); then
    die "${matches} ANTHROPIC_API_KEY assignments in ${file}. Refusing to guess which one is live: dotenv implementations disagree about precedence, and the wrong guess bills the wrong account. Leave exactly one."
  fi

  # Trim surrounding whitespace, then one matched layer of quotes.
  KEY_VALUE="${KEY_VALUE#"${KEY_VALUE%%[![:space:]]*}"}"
  KEY_VALUE="${KEY_VALUE%"${KEY_VALUE##*[![:space:]]}"}"
  if ((${#KEY_VALUE} >= 2)); then
    case "$KEY_VALUE" in
      '"'*'"') KEY_VALUE="${KEY_VALUE:1:${#KEY_VALUE}-2}" ;;
      "'"*"'") KEY_VALUE="${KEY_VALUE:1:${#KEY_VALUE}-2}" ;;
    esac
  fi
}

##
# Reject anything that is not shaped like a key, naming the file and never the
# value. Catches the empty assignment, the `changeme` placeholder, and the
# shell-expansion-that-did-not-expand — each of which would otherwise cost a
# real API round trip to diagnose.
##
require_key_shape() {
  local file="$1"

  [[ -n "$KEY_VALUE" ]] ||
    die "ANTHROPIC_API_KEY is present but empty in ${file}. Set it to a real key."

  [[ "$KEY_VALUE" == "${KEY_PREFIX}"* ]] ||
    die "ANTHROPIC_API_KEY in ${file} does not begin with '${KEY_PREFIX}', so it is not an Anthropic API key. Value not shown by design; open the file to inspect it."

  ((${#KEY_VALUE} >= MIN_KEY_LENGTH)) ||
    die "ANTHROPIC_API_KEY in ${file} is ${#KEY_VALUE} characters, shorter than the ${MIN_KEY_LENGTH}-character floor for a real key — it looks like a placeholder. Value not shown by design."
}

##
# A short SHA-256 prefix of the key.
#
# `printf` here is bash's builtin, so the key is written straight to a pipe from
# this process. Using /usr/bin/printf, or `echo "$KEY_VALUE" | ...` in a shell
# where echo is external, would publish the key in `/proc/<pid>/cmdline` for
# every user on the box for as long as that process lived.
#
# No trailing newline, so the digest is of the exact key and is reproducible by
# anyone auditing this (`printf '%s' <key> | sha256sum`).
##
key_fingerprint() {
  printf '%s' "$KEY_VALUE" | sha256sum | cut -c "1-${FINGERPRINT_CHARS}"
}

# ── Mode: --check ───────────────────────────────────────────────────────────

##
# Prove a usable key is there, disclosing only what cannot be used to make a
# request. This is the mode that makes the whole arrangement auditable: the
# operator runs it themselves and sees exactly how little comes out.
#
# The complete disclosure surface is the six lines printed below:
#   the file path (which the operator supplied), its permission bits, the fact
#   that exactly one assignment was found, the key's character count, the
#   literal 'sk-ant-' format marker, and 12 hex characters of SHA-256.
# Nothing else about the file — and no other line in it — is read or reported.
##
mode_check() {
  local file="$1"
  local mode

  read_key_from_env_file "$file"
  require_key_shape "$file"

  mode="$(stat -c '%a' "$file" 2>/dev/null || echo '?')"

  info "env file:       ${file}"
  info "permissions:    ${mode}"
  info "assignment:     ANTHROPIC_API_KEY found (exactly one)"
  info "value length:   ${#KEY_VALUE} characters"
  info "format marker:  ${KEY_PREFIX} (present)"
  info "sha256 prefix:  $(key_fingerprint)"

  # Advisory, about the file's mode rather than its contents. A 664 .env is
  # readable by every user on this machine, which no amount of care in this
  # script can compensate for.
  if [[ "$mode" != '?' && "${mode:1}" != '00' ]]; then
    warn "${file} is mode ${mode}: readable beyond its owner. Consider 'chmod 600 ${file}'."
  fi

  info ""
  info "OK — a usable key is present. Nothing above can be used to make a request."
}

# ── Mode: --print-extractor-module ──────────────────────────────────────────

##
# The module `.kgmem/config.json` must name under `models.extractor`.
#
# Printed rather than written, so this script never creates files in a tree the
# operator did not ask it to touch. Redirect it where you want it.
#
# `config.ts` requires each configured port to be a module specifier whose
# default export is a *factory*; the factory is called with no arguments, and
# `AnthropicExtractor`'s constructor is what reads ANTHROPIC_API_KEY from the
# environment. That is the reason the key never appears in the config file: the
# config names code, and the code reads the environment this script sets.
#
# The specifier ends in `.js` because that is this repo's ESM-on-TypeScript
# convention; tsx resolves it to the `.ts` source at load time.
##
mode_print_extractor_module() {
  cat <<MODULE
/**
 * The §5.10 extractor port, bound to the real Anthropic adapter.
 *
 * Named by .kgmem/config.json as models.extractor. Holds no credentials:
 * AnthropicExtractor reads ANTHROPIC_API_KEY from the environment when it is
 * constructed, and scripts/live-anthropic-reflect.sh is what puts it there.
 * Each model call's billed usage is written to stderr as one anthropic-usage <json> line.
 */
import { AnthropicExtractor } from '${REPO_ROOT}/src/extract/adapters/anthropic-extractor.js';

export default () =>
  new AnthropicExtractor({
    onUsage: (usage) => {
      process.stderr.write('anthropic-usage ' + JSON.stringify(usage) + '\n');
    },
  });
MODULE
}

# ── Mode: run the drain ─────────────────────────────────────────────────────

##
# Resolve the tsx loader to an absolute file: URL.
#
# Mirrors src/adapters/cli/__tests__/cli-fixtures.ts. A bare `--import tsx` is
# resolved against the *child's* working directory, and the child's working
# directory here is a workspace that will usually have no node_modules above it
# — so the bare form dies with ERR_MODULE_NOT_FOUND before the CLI runs at all.
# Resolving from this repository instead pins the loader we actually installed.
#
# The .ts loader is not a convenience: .kgmem/config.json has to name a
# TypeScript module (there is no built extractor entry point), and the bundled
# dist/kgmem.js cannot load one.
##
resolve_tsx_loader() {
  local loader
  loader="$(
    cd "$REPO_ROOT" &&
      node -e 'const {createRequire}=require("node:module");const {pathToFileURL}=require("node:url");process.stdout.write(pathToFileURL(createRequire(process.cwd()+"/").resolve("tsx")).href)'
  )" || die "could not resolve the tsx loader from ${REPO_ROOT}. Run your package install there first."
  [[ -n "$loader" ]] || die "tsx resolved to an empty path from ${REPO_ROOT}."
  printf '%s' "$loader"
}

##
# Refuse a workspace that is not, itself, a workspace.
#
# `requireWorkspace` walks *up* from the child's cwd looking for .kgmem, so a
# mistyped --workspace does not fail: it silently finds some ancestor's
# workspace and drains that one instead, spending money mutating a store the
# operator did not name. Checking for .kgmem directly under the given directory
# is what makes the argument mean what it says.
##
require_workspace() {
  local workspace="$1"
  local resolved

  [[ -d "$workspace" ]] || die "no such workspace directory: ${workspace}"
  resolved="$(cd "$workspace" && pwd)"

  [[ -d "${resolved}/.kgmem" ]] ||
    die "${resolved} has no .kgmem directory, so it is not a workspace. Create one with: pnpm --dir '${REPO_ROOT}' exec tsx src/adapters/cli/index.ts init '${resolved}'. (Refusing to let kgmem walk up and drain some ancestor's workspace instead.)"

  [[ -f "${resolved}/.kgmem/config.json" ]] ||
    die "${resolved}/.kgmem/config.json is missing. reflect needs it to name an extractor module; see --print-extractor-module."

  printf '%s' "$resolved"
}

##
# Hand the key to exactly one process and become it.
#
# The whole security design is these three lines. `export` inside `( … )` scopes
# the variable to a subshell the parent never reads back; `exec` then *replaces*
# that subshell with node, so no intermediate process ever holds the key in its
# environment and there is nothing left to leak it after node starts. The key is
# not in the argv below and therefore not in `ps`, not in `/proc/<pid>/cmdline`,
# and not in any process listing a monitoring agent collects.
#
# stdout and stderr are the child's own and inherited unchanged: kgmem writes
# only its own report there, and none of its diagnostics carry the key — the
# adapter keeps it in a private field and sends it as an `x-api-key` header.
##
run_drain() {
  local workspace="$1" loader="$2" cli="$3"

  (
    export ANTHROPIC_API_KEY="$KEY_VALUE"
    cd "$workspace"
    exec node --import "$loader" "$cli" reflect
  )
}

# ── Argument parsing ────────────────────────────────────────────────────────

main() {
  local env_file="${KGMEM_ANTHROPIC_ENV_FILE:-}"
  local workspace=''
  local do_check='false'
  local dry_run='false'
  local loader cli resolved_workspace

  while (($# > 0)); do
    case "$1" in
      --check) do_check='true'; shift ;;
      --dry-run) dry_run='true'; shift ;;
      --print-extractor-module) mode_print_extractor_module; return 0 ;;
      -h | --help) usage; return 0 ;;
      --env-file)
        [[ $# -ge 2 ]] || die "--env-file needs a path."
        env_file="$2"; shift 2 ;;
      --env-file=*) env_file="${1#*=}"; shift ;;
      --workspace)
        [[ $# -ge 2 ]] || die "--workspace needs a path."
        workspace="$2"; shift 2 ;;
      --workspace=*) workspace="${1#*=}"; shift ;;
      *) die "unknown argument: $1 (try --help)" ;;
    esac
  done

  # No default, by design. This machine has more than one .env with a different
  # ANTHROPIC_API_KEY in each, so a default would silently choose whose account
  # gets billed.
  [[ -n "$env_file" ]] ||
    die "no env file given. Pass --env-file PATH or set KGMEM_ANTHROPIC_ENV_FILE. There is deliberately no default: the wrong file bills the wrong account."

  if [[ "$do_check" == 'true' ]]; then
    mode_check "$env_file"
    return 0
  fi

  [[ -n "$workspace" ]] ||
    die "no workspace given. Pass --workspace DIR (a directory containing .kgmem/config.json). This script does not create one — see the note in its header."

  resolved_workspace="$(require_workspace "$workspace")"

  # Read and validate before resolving the loader, so a bad key costs no setup —
  # and, more importantly, so the refusal happens before anything is spawned.
  read_key_from_env_file "$env_file"
  require_key_shape "$env_file"

  loader="$(resolve_tsx_loader)"
  cli="${REPO_ROOT}/src/adapters/cli/index.ts"
  [[ -f "$cli" ]] || die "CLI entry point not found at ${cli}."

  if [[ "$dry_run" == 'true' ]]; then
    info "would run, with cwd ${resolved_workspace}:"
    info "  node --import ${loader} ${cli} reflect"
    info ""
    info "environment variables injected into that child (names only): ANTHROPIC_API_KEY"
    info "key source: ${env_file} (length ${#KEY_VALUE}, sha256 $(key_fingerprint))"
    info ""
    info "no API call made."
    return 0
  fi

  info "draining ${resolved_workspace} against the live Anthropic API — this spends money."
  run_drain "$resolved_workspace" "$loader" "$cli"
}

main "$@"
