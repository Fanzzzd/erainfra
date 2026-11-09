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
export SUDO_USER=packer DEBIAN_FRONTEND=noninteractive
# Keep downloads outside both source and /tmp, which cleanup.sh empties.
mkdir -p /var/tmp/erainfra-install
cd /var/tmp/erainfra-install
systemctl stop apt-daily.timer apt-daily-upgrade.timer
apt-get update
while IFS= read -r script; do
  case "$script" in
    configure-apt-mock.sh)
      # Azure extension workaround. Its wrapper hides apt's nonzero exit code.
      echo "SKIP $script: no Azure extension; keep real apt exit status"
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
