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
while IFS= read -r script; do
  case "$script" in
    configure-apt-mock.sh)
      # Upstream's wrapper retries Azure extension lock races and always exits 0,
      # so hosted builds continue past failed apt commands. Keep that exit
      # behavior, which later scripts depend on, but record every failure.
      # cleanup.sh removes these wrappers at the same point it removes upstream's.
      : > "$apt_failures"
      chmod 0666 "$apt_failures"
      for tool in apt apt-get apt-key; do
        cat > "/usr/local/bin/$tool" <<WRAPPER
#!/bin/sh
/usr/bin/$tool "\$@"
status=\$?
[ "\$status" -eq 0 ] || printf '%s\\t%s\\n' "\$status" "$tool \$*" >> $apt_failures
exit 0
WRAPPER
        chmod 0755 "/usr/local/bin/$tool"
      done
      echo "RECORD $script: apt failures go to $apt_failures"
      continue ;;
    configure-system.sh)
      # Packer runs reports between cleanup.sh and configure-system.sh.
      set -a
      source /etc/environment
      set +a
      pwsh -File /imagegeneration/SoftwareReport/Generate-SoftwareReport.ps1 -OutputDirectory /imagegeneration
      # The software tests run unchanged. System.Tests.ps1 asserts Azure disks,
      # GRUB and the host kernel command line, not installed software.
      for test in /imagegeneration/tests/*.Tests.ps1; do
        [ "$(basename "$test")" = System.Tests.ps1 ] && continue
        name=$(basename "$test" .Tests.ps1)
        pwsh -Command "Import-Module '/imagegeneration/tests/Helpers.psm1'; Invoke-PesterTests '$name'"
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
done < /erainfra-build/scripts.txt
# Hosted builds ignore failed apt commands. Fail on any failure that has not
# been reviewed as equivalent to the hosted result in apt-failures.allow.
unexpected=0
while IFS=$'\t' read -r status command; do
  if grep -qxF "$command" <(grep -v '^#' /erainfra-build/apt-failures.allow); then
    echo "ALLOWED apt failure (exit $status): $command"
  else
    echo "UNEXPECTED apt failure (exit $status): $command" >&2
    unexpected=1
  fi
done < "$apt_failures"
[ "$unexpected" = 0 ]
