# shellcheck shell=sh
# The four variables the Actions cache clients read, and one rendering of them
# that is safe to print. Sourced by cache-env-probe.yml; not executable on its
# own.
#
# ACTIONS_RUNTIME_TOKEN is the runner's own credential -- the same one the
# artifact service under ACTIONS_RESULTS_URL authenticates with -- so it is
# reported as present-or-not and by length, never by value. Every other name
# here holds a URL or a flag, and the value IS the measurement.

PROBE_NAMES="ACTIONS_CACHE_URL ACTIONS_RESULTS_URL ACTIONS_CACHE_SERVICE_V2 ACTIONS_RUNTIME_TOKEN"

# "unset" and "set-but-empty" are kept apart on purpose. A runner that clears a
# variable it was handed and one that never wrote it are different findings, and
# collapsing them is how the interesting one would be missed.
probe_render() {
  probe_name=$1
  probe_value=$2
  probe_present=$3
  if [ "$probe_present" != "set" ]; then
    printf 'unset'
    return 0
  fi
  case $probe_name in
    ACTIONS_RUNTIME_TOKEN) printf 'present, %s bytes' "${#probe_value}" ;;
    *)
      if [ -z "$probe_value" ]; then
        printf 'set-but-empty'
      else
        printf '%s' "$probe_value"
      fi
      ;;
  esac
}

record_tier() {
  probe_file=$1
  printf '%s\t%s\n' "$2" "$(probe_render "$2" "$3" "$4")" >> "$probe_file"
}

# One tier read out of THIS process's environment. A `run:` step and a
# JavaScript action step are handed the same composed environment by the runner,
# so what this sees is what actions/cache would see.
snapshot_tier() {
  : > "$1"
  for probe_each in $PROBE_NAMES; do
    if probe_seen=$(printenv "$probe_each"); then
      record_tier "$1" "$probe_each" "$probe_seen" set
    else
      record_tier "$1" "$probe_each" "" unset
    fi
  done
}
