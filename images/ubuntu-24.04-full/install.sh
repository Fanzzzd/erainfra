#!/usr/bin/env bash
# Runs only inside the disposable systemd build container.
set -euo pipefail
export HELPER_SCRIPTS=/imagegeneration/helpers
export HELPER_SCRIPT_FOLDER=$HELPER_SCRIPTS
export INSTALLER_SCRIPT_FOLDER=/imagegeneration/installers
export IMAGE_FOLDER=/imagegeneration
export IMAGEDATA_FILE=/imagegeneration/imagedata.json
export IMAGE_OS=ubuntu24
export IMAGE_VERSION
IMAGE_VERSION=$(python3 -I -c 'import json; print(json.load(open("/erainfra-build/upstream.json"))["image_version"])')
export HOME=/root USER=root LOGNAME=root
export SUDO_USER=packer DEBIAN_FRONTEND=noninteractive
# Keep downloads outside both source and /tmp, which cleanup.sh empties.
mkdir -p /var/tmp/erainfra-install
apt_failures=/erainfra-build/apt-failures.tsv
cd /var/tmp/erainfra-install
# Hosted /tmp is on the root disk. Large downloads fail on a small tmpfs.
[ "$(findmnt --noheadings --output FSTYPE --target /tmp)" = ext4 ]
systemctl stop apt-daily.timer apt-daily-upgrade.timer
# Packer starts from Canonical's Azure image, not the generic root archive.
# Match its apt sources, which configure-apt-sources.sh rewrites to a mirror
# list, and its extra userspace packages. chrony replaces systemd-timesyncd.
sed -i -e 's|http://archive\.ubuntu\.com/ubuntu/|http://azure.archive.ubuntu.com/ubuntu/|' \
  -e 's|http://security\.ubuntu\.com/ubuntu/|http://azure.archive.ubuntu.com/ubuntu/|' \
  /etc/apt/sources.list.d/ubuntu.sources
! grep -qE 'URIs: http://(archive|security)\.ubuntu\.com/' /etc/apt/sources.list.d/ubuntu.sources
apt-get update
grep -v '^#' /erainfra-build/azure-base-packages.txt | xargs apt-get install -y --no-install-recommends
if dpkg-query -W -f '${db:Status-Abbrev} ${Package}\n' 'linux-image-*' 'grub-*' 2>/dev/null | grep -q '^ii'; then
  echo 'Azure base equivalence must not install a kernel or bootloader' >&2
  exit 1
fi
# Hosted builds ignore failed apt commands. Fail on any failure that has not
# been reviewed as equivalent to the hosted result in apt-failures.allow. The
# check runs after every script, so an unreviewed failure stops the build
# there and not after the remaining installers.
check_apt_failures() {
  local unexpected=0 status command
  [ -e "$apt_failures" ] || return 0
  while IFS=$'\t' read -r status command; do
    if grep -qxF "$command" <(grep -v '^#' /erainfra-build/apt-failures.allow); then
      [ "${1:-}" != report ] || echo "ALLOWED apt failure (exit $status): $command"
    else
      echo "UNEXPECTED apt failure (exit $status): $command" >&2
      unexpected=1
    fi
  done < "$apt_failures"
  [ "$unexpected" = 0 ]
}
while IFS= read -r script; do
  case "$script" in
    configure-apt-mock.sh)
      # Upstream's wrapper retries Azure extension lock races and always exits 0,
      # so hosted builds continue past failed apt commands. Keep that exit
      # behavior, which later scripts depend on, but record every failure.
      # cleanup.sh removes these wrappers at the same point it removes upstream's.
      : > "$apt_failures"
      chmod 0666 "$apt_failures"
      # A mirror can list a package a moment before it serves it, which fails
      # a fetch with 404. Refresh the index and retry before recording, except
      # for a failure already reviewed as permanent.
      for tool in apt apt-get apt-key; do
        attempts=3
        [ "$tool" = apt-key ] && attempts=1
        cat > "/usr/local/bin/$tool" <<WRAPPER
#!/bin/sh
attempt=1
while :; do
  /usr/bin/$tool "\$@"
  status=\$?
  [ "\$status" -eq 0 ] && exit 0
  [ "\$attempt" -ge $attempts ] && break
  grep -qxF "$tool \$*" /erainfra-build/apt-failures.allow && break
  echo "RETRY $tool \$* (exit \$status, attempt \$attempt of $attempts)" >&2
  sleep \$((attempt * 30))
  /usr/bin/apt-get update || true
  attempt=\$((attempt + 1))
done
printf '%s\\t%s\\n' "\$status" "$tool \$*" >> $apt_failures
exit 0
WRAPPER
        chmod 0755 "/usr/local/bin/$tool"
      done
      echo "RECORD $script: apt failures go to $apt_failures"
      continue ;;
    configure-system.sh)
      # Packer runs the report and RunAll-Tests.ps1 here, as its unprivileged
      # SSH user. Homebrew refuses to run as root, so root would fail its test.
      # sudo applies secure_path, so load /etc/environment in the user's shell,
      # as the login session Packer opens would.
      as_packer() {
        sudo -H -u packer env IMAGE_VERSION="$IMAGE_VERSION" INSTALLER_SCRIPT_FOLDER="$INSTALLER_SCRIPT_FOLDER" \
          bash -c 'set -a; . /etc/environment; set +a; cd "$HOME" && exec pwsh "$@"' as_packer "$@"
      }
      as_packer -File /imagegeneration/SoftwareReport/Generate-SoftwareReport.ps1 -OutputDirectory /imagegeneration
      # Every test file runs unchanged except System.Tests.ps1. Its read-ahead
      # and root mount option blocks inspect the builder's block devices, GRUB
      # and kernel command line, which the Firecracker guest does not use.
      for test in /imagegeneration/tests/*.Tests.ps1; do
        name=$(basename "$test" .Tests.ps1)
        [ "$name" = System ] && continue
        as_packer -Command "Import-Module '/imagegeneration/tests/Helpers.psm1' -DisableNameChecking; Invoke-PesterTests '$name'"
      done
      for block in 'Disk free space' 'Azure resource disk mount timeout' 'fwupd removed' '/tmp emptied at boot' 'Dpkg options'; do
        as_packer -Command "Import-Module '/imagegeneration/tests/Helpers.psm1' -DisableNameChecking; Invoke-PesterTests 'System' '$block*'"
      done ;;
  esac
  start=$(date +%s)
  echo "BEGIN $script $(date -u +%FT%TZ)"
  (
    set -a
    source /etc/environment
    set +a
    case "$script" in
      install-homebrew.sh)
        # Upstream explicitly runs this one as the Packer user, not root.
        sudo -H -u packer env HELPER_SCRIPTS="$HELPER_SCRIPTS" INSTALLER_SCRIPT_FOLDER="$INSTALLER_SCRIPT_FOLDER" NONINTERACTIVE=1 bash -e "$INSTALLER_SCRIPT_FOLDER/$script" ;;
      *.ps1) pwsh -File "$INSTALLER_SCRIPT_FOLDER/$script" ;;
      *) bash -e "$INSTALLER_SCRIPT_FOLDER/$script" ;;
    esac
  )
  printf '%s\t%s\n' "$script" "$(( $(date +%s) - start ))" >> /erainfra-build/timings.tsv
  echo "END $script $(date -u +%FT%TZ)"
  check_apt_failures
done < /erainfra-build/scripts.txt
check_apt_failures report
