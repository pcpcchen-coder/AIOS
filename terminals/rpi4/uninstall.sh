#!/usr/bin/env bash
set -euo pipefail
KIT_DIR="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib/common.sh
source "$KIT_DIR/lib/common.sh"

usage() {
  t "用法：uninstall.sh [--purge] [--help]

移除 AIOS Pi 終端的服務、自動啟動項目與程式。不移除 apt 套件，也不連到 Mac。

  --purge  另外刪除設定資料夾（含 SSH 金鑰與 known_hosts）及 Chromium 設定檔
  --help   顯示此說明" \
    "Usage: uninstall.sh [--purge] [--help]

Removes the AIOS Pi terminal services, autostart entry and scripts. Leaves apt packages alone and never contacts the Mac.

  --purge  also delete the config directory (SSH key, known_hosts) and the Chromium profile
  --help   show this help"
}

purge=0
for arg in "$@"; do
  case "$arg" in
    --purge) purge=1 ;;
    --help | -h)
      usage
      exit 0
      ;;
    *)
      usage >&2
      die "未知的參數：$arg" "Unknown option: $arg" 2
      ;;
  esac
done

user_name="${USER:-$(id -un)}"
# Match the key body, not the comment: every Pi defaults to the hostname "raspberrypi".
revoke_pattern="/ aios-terminal@$(hostname)\$/d"
if [[ -f "$AIOS_KEY.pub" ]]; then
  revoke_pattern="\\|$(awk 'NR==1 {print $2}' "$AIOS_KEY.pub")|d"
fi

systemctl --user disable --now "${AIOS_UNITS[@]}" >/dev/null 2>&1 || true
systemctl --user stop "${AIOS_UNITS[@]}" >/dev/null 2>&1 || true
for unit in "${AIOS_UNITS[@]}"; do
  rm -f "$AIOS_UNIT_DIR/$unit"
done
rm -f "$AIOS_AUTOSTART_FILE"
for name in "${AIOS_COMMANDS[@]}"; do
  if [[ -L "$AIOS_LOCAL_BIN/$name" ]]; then
    rm -f "$AIOS_LOCAL_BIN/$name"
  fi
done
rm -rf "${AIOS_SHARE_DIR:?}/bin" "${AIOS_SHARE_DIR:?}/lib"
systemctl --user daemon-reload >/dev/null 2>&1 || true

if [[ -e "$AIOS_UDEV_RULE" ]]; then
  sudo rm -f "$AIOS_UDEV_RULE"
fi

if [[ -f "$AIOS_LINGER_MARKER" ]]; then
  sudo loginctl disable-linger "$user_name"
  rm -f "$AIOS_LINGER_MARKER"
fi

if ((purge)); then
  rm -rf "${AIOS_CONFIG_DIR:?}" "${AIOS_PROFILE_DIR:?}"
  rmdir "$AIOS_SHARE_DIR" 2>/dev/null || true
  t "已刪除設定、SSH 金鑰與 Chromium 設定檔。" "Deleted the config, SSH key and Chromium profile."
else
  t "保留設定與金鑰於 $AIOS_CONFIG_DIR、Chromium 設定檔於 $AIOS_PROFILE_DIR（加 --purge 可一併刪除）。" \
    "Kept the config and key in $AIOS_CONFIG_DIR and the Chromium profile in $AIOS_PROFILE_DIR (use --purge to delete them)."
fi

t "已移除 AIOS Pi 終端。
若也要移除套件（可能有其他程式在用）：
  sudo apt-get remove autossh chromium
若要撤銷 Mac 對此 Pi 的授權，在 Mac 執行：
  sed -i '' '$revoke_pattern' ~/.ssh/authorized_keys" \
  "AIOS Pi terminal removed.
To also remove packages (other programs may use them):
  sudo apt-get remove autossh chromium
To revoke this Pi's access on the Mac, run on the Mac:
  sed -i '' '$revoke_pattern' ~/.ssh/authorized_keys"
