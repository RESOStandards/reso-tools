#!/bin/sh
# ---------------------------------------------------------------------------
# seed-helpers.sh — Shared seeding helpers for compliance entrypoints
#
# Usage:
#   . /config/seed-helpers.sh   (or source from local path)
#
# Environment:
#   SEED_COUNTS  Comma-separated Resource=Count overrides (e.g. "Property=150,Media=50")
#   SEED_DEFAULT Default count when no override is specified (default: 10)
#
# Functions:
#   seed_count <Resource>  Returns the count for a resource
# ---------------------------------------------------------------------------

SEED_DEFAULT="${SEED_DEFAULT:-10}"

# seed_count <Resource> — look up count from SEED_COUNTS or fall back to SEED_DEFAULT
# Returns a numeric value; falls back to SEED_DEFAULT on any parse error.
seed_count() {
  _resource="$1"
  _result="$SEED_DEFAULT"
  if [ -n "$SEED_COUNTS" ]; then
    _IFS="$IFS"
    IFS=','
    for _pair in $SEED_COUNTS; do
      _key="${_pair%%=*}"
      _val="${_pair#*=}"
      if [ "$_key" = "$_resource" ] 2>/dev/null; then
        # Validate that _val is a positive integer
        case "$_val" in
          ''|*[!0-9]*) ;;  # not a number — skip, use default
          *) _result="$_val" ;;
        esac
        break
      fi
    done
    IFS="$_IFS"
  fi
  echo "$_result"
}
