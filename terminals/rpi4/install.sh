#!/usr/bin/env bash
set -euo pipefail
KIT_DIR="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib/common.sh
source "$KIT_DIR/lib/common.sh"

usage() {
  t "用法：install.sh [--non-interactive] [--skip-apt] [--skip-copy-id] [--help]

在 Raspberry Pi 上以桌面使用者身分執行（不要用 sudo）。安裝 SSH 通道與 Chromium 全螢幕終端，
連到 Mac 上的 Nous App 核心。

  --non-interactive  從環境變數讀取 AIOS_MAC_USER、AIOS_MAC_HOST、AIOS_PORT、AIOS_SSH_PORT、
                     AIOS_MAC_HOSTKEY_SHA256（Mac 主機金鑰指紋，必填）
  --skip-apt         不安裝 apt 套件
  --skip-copy-id     不把公鑰複製到 Mac（已自行加入 authorized_keys 時使用）
  --help             顯示此說明" \
    "Usage: install.sh [--non-interactive] [--skip-apt] [--skip-copy-id] [--help]

Run on the Raspberry Pi as the desktop user (not with sudo). Installs the SSH tunnel and the
Chromium kiosk terminal that connect to the Nous App core on the Mac.

  --non-interactive  read AIOS_MAC_USER, AIOS_MAC_HOST, AIOS_PORT, AIOS_SSH_PORT and
                     AIOS_MAC_HOSTKEY_SHA256 (Mac host key fingerprint, required) from the environment
  --skip-apt         do not install apt packages
  --skip-copy-id     do not copy the public key to the Mac (use when it is already in authorized_keys)
  --help             show this help"
}

interactive=1
skip_apt=0
skip_copy_id=0
for arg in "$@"; do
  case "$arg" in
    --non-interactive) interactive=0 ;;
    --skip-apt) skip_apt=1 ;;
    --skip-copy-id) skip_copy_id=1 ;;
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

if [[ "$(id -u)" == 0 ]]; then
  die "請以桌面使用者身分執行，不要用 root 或 sudo：systemd 使用者服務必須屬於登入桌面的帳號。" \
    "Run as the desktop user, not root or sudo: the systemd user units must belong to the account that logs into the desktop." 1
fi
user_name="${USER:-$(id -un)}"
scan=""
trap 'rm -f "$scan"' EXIT

step() { printf '\n==> %s\n' "$(t "$1" "$2")"; }

install_packages() {
  local chromium_pkg=chromium-browser
  step "安裝套件（需要 sudo）" "Installing packages (needs sudo)"
  sudo apt-get update
  if apt-cache show chromium >/dev/null 2>&1; then
    chromium_pkg=chromium
  fi
  sudo apt-get install -y autossh openssh-client v4l-utils alsa-utils curl "$chromium_pkg"
}

ask() {
  local var="$1" zh="$2" en="$3" current="$4" answer
  read -r -p "$(t "$zh" "$en") [$current]: " answer
  printf -v "$var" '%s' "${answer:-$current}"
}

configure() {
  local env_user="${AIOS_MAC_USER:-}" env_host="${AIOS_MAC_HOST:-}" env_port="${AIOS_PORT:-}" env_ssh_port="${AIOS_SSH_PORT:-}"
  step "寫入設定 $AIOS_CONFIG_FILE" "Writing config $AIOS_CONFIG_FILE"
  if ! load_config && [[ -f "$AIOS_CONFIG_FILE" ]]; then
    t "既有設定無效，將重新填寫：$CONFIG_ERROR" "Existing config is invalid and will be replaced: $CONFIG_ERROR" >&2
  fi
  AIOS_MAC_USER="${env_user:-$AIOS_MAC_USER}"
  AIOS_MAC_HOST="${env_host:-$AIOS_MAC_HOST}"
  AIOS_PORT="${env_port:-$AIOS_PORT}"
  AIOS_SSH_PORT="${env_ssh_port:-$AIOS_SSH_PORT}"
  if ((interactive)); then
    ask AIOS_MAC_USER "Mac 帳號短名稱" "Mac short user name" "$AIOS_MAC_USER"
    ask AIOS_MAC_HOST "Mac 主機名稱或區網 IP" "Mac hostname or LAN IP" "$AIOS_MAC_HOST"
    ask AIOS_PORT "Nous App 核心連接埠（必須與 Mac 上相同）" "Nous App core port (must match the Mac)" "$AIOS_PORT"
    ask AIOS_SSH_PORT "Mac SSH 連接埠" "Mac SSH port" "$AIOS_SSH_PORT"
  fi
  validate_config || die "$CONFIG_ERROR" "$CONFIG_ERROR" 2
  write_config
}

ensure_key() {
  if [[ -f "$AIOS_KEY" ]]; then
    t "沿用既有 SSH 金鑰 $AIOS_KEY" "Keeping existing SSH key $AIOS_KEY"
    return
  fi
  step "產生 SSH 金鑰" "Generating SSH key"
  t "金鑰不設密碼，因為開機後通道必須無人值守自動連線；金鑰只存在 $AIOS_CONFIG_DIR（權限 700）。" \
    "The key has no passphrase because the tunnel must reconnect unattended after boot; it lives only in $AIOS_CONFIG_DIR (mode 700)."
  ssh-keygen -q -t ed25519 -N "" -C "aios-terminal@$(hostname)" -f "$AIOS_KEY"
}

normalize_fingerprint() {
  local value="${1#SHA256:}"
  printf 'SHA256:%s' "$value"
}

verify_host_key() {
  local fingerprint expected answer
  step "驗證 Mac 主機金鑰" "Verifying the Mac host key"
  scan="$(mktemp)"
  ssh-keyscan -T 5 -p "$AIOS_SSH_PORT" -t ed25519 "$AIOS_MAC_HOST" 2>/dev/null | grep -v '^#' >"$scan" || true
  if [[ ! -s "$scan" ]]; then
    die "無法從 $AIOS_MAC_HOST:$AIOS_SSH_PORT 取得 ed25519 主機金鑰。請確認 Mac 已開啟「系統設定 > 一般 > 共享 > 遠端登入」，且 Pi 能連到該主機。" \
      "Could not fetch an ed25519 host key from $AIOS_MAC_HOST:$AIOS_SSH_PORT. Check that Remote Login is on (System Settings > General > Sharing > Remote Login) and that the Pi can reach the host." 1
  fi
  fingerprint="$(ssh-keygen -lf "$scan" -E sha256 | awk 'NR==1 {print $2}')"
  [[ "$fingerprint" == SHA256:* ]] || die "無法計算主機金鑰指紋。" "Could not compute the host key fingerprint." 1

  if [[ -n "${AIOS_MAC_HOSTKEY_SHA256:-}" ]]; then
    expected="$(normalize_fingerprint "$AIOS_MAC_HOSTKEY_SHA256")"
    if [[ "$fingerprint" != "$expected" ]]; then
      die "主機金鑰指紋不符：掃描到 $fingerprint，預期 $expected。未寫入 known_hosts。" \
        "Host key fingerprint mismatch: scanned $fingerprint, expected $expected. known_hosts was not written." 1
    fi
  elif [[ -s "$AIOS_KNOWN_HOSTS" ]] && cmp -s "$scan" "$AIOS_KNOWN_HOSTS"; then
    t "主機金鑰與先前驗證過的相同（$fingerprint）。" "Host key matches the one verified earlier ($fingerprint)."
  elif ((interactive)); then
    t "Mac 回報的主機金鑰指紋：" "Host key fingerprint reported by the Mac:"
    printf '  %s\n' "$fingerprint"
    t "請在 Mac 的終端機執行：" "On the Mac, run in Terminal:"
    printf '  ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub\n'
    read -r -p "$(t "兩邊指紋完全相同時才輸入 yes：" "Type yes only if both fingerprints are identical: ")" answer
    [[ "$answer" == yes ]] || die "未確認主機金鑰，停止安裝。" "Host key not confirmed; stopping." 1
  else
    die "非互動模式需要 AIOS_MAC_HOSTKEY_SHA256（在 Mac 執行 ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub 取得）。" \
      "Non-interactive mode needs AIOS_MAC_HOSTKEY_SHA256 (get it on the Mac with ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub)." 2
  fi
  install -m 600 "$scan" "$AIOS_KNOWN_HOSTS"
  t "已信任主機金鑰 $fingerprint → $AIOS_KNOWN_HOSTS" "Trusted host key $fingerprint -> $AIOS_KNOWN_HOSTS"
}

authorize_key() {
  local target="$AIOS_MAC_USER@$AIOS_MAC_HOST"
  local ssh_opts=(-p "$AIOS_SSH_PORT" -o "UserKnownHostsFile=$AIOS_KNOWN_HOSTS" -o StrictHostKeyChecking=yes)
  step "把公鑰加入 Mac（會詢問一次 Mac 密碼）" "Adding the public key to the Mac (asks for the Mac password once)"
  ssh-copy-id -i "$AIOS_KEY.pub" "${ssh_opts[@]}" "$target" ||
    die "ssh-copy-id 失敗。請確認帳號、密碼與 Mac 的遠端登入允許此帳號。" \
      "ssh-copy-id failed. Check the user name, password and that Remote Login allows this account on the Mac." 1
  ssh -i "$AIOS_KEY" "${ssh_opts[@]}" -o BatchMode=yes -o IdentitiesOnly=yes "$target" true ||
    die "金鑰登入驗證失敗：Mac 未接受此金鑰。請檢查 Mac 的 ~/.ssh/authorized_keys 與權限。" \
      "Key login check failed: the Mac did not accept this key. Check ~/.ssh/authorized_keys and its permissions on the Mac." 1
  t "金鑰登入正常。" "Key login works."
}

install_files() {
  local name
  step "安裝程式與服務" "Installing scripts and services"
  mkdir -p "$AIOS_SHARE_DIR" "$AIOS_LOCAL_BIN" "$AIOS_UNIT_DIR" "$(dirname "$AIOS_AUTOSTART_FILE")"
  rm -rf "${AIOS_SHARE_DIR:?}/bin" "${AIOS_SHARE_DIR:?}/lib"
  cp -R "$KIT_DIR/bin" "$KIT_DIR/lib" "$AIOS_SHARE_DIR/"
  chmod 755 "$AIOS_SHARE_DIR"/bin/*
  chmod 644 "$AIOS_SHARE_DIR"/lib/*
  for name in "${AIOS_COMMANDS[@]}"; do
    ln -sfn "$AIOS_SHARE_DIR/bin/$name" "$AIOS_LOCAL_BIN/$name"
  done
  for name in "${AIOS_UNITS[@]}"; do
    install -m 644 "$KIT_DIR/systemd/$name" "$AIOS_UNIT_DIR/$name"
  done
  install -m 644 "$KIT_DIR/autostart/aios-kiosk.desktop" "$AIOS_AUTOSTART_FILE"
}

enable_linger() {
  if [[ "$(loginctl show-user "$user_name" -p Linger 2>/dev/null || true)" == "Linger=yes" ]]; then
    return
  fi
  step "允許使用者服務在登入前啟動（loginctl enable-linger）" "Letting user services start before login (loginctl enable-linger)"
  sudo loginctl enable-linger "$user_name"
  touch "$AIOS_LINGER_MARKER"
}

start_services() {
  step "啟動服務" "Starting services"
  systemctl --user daemon-reload
  systemctl --user enable --now aios-tunnel.service
  if [[ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]]; then
    "$AIOS_SHARE_DIR/bin/aios-session-start"
  else
    t "未偵測到桌面工作階段；全螢幕畫面會在下次桌面登入時由自動啟動項目開啟。" \
      "No desktop session detected; the kiosk starts from the autostart entry at the next desktop login."
  fi
}

next_steps() {
  step "完成" "Done"
  t "下一步：
  1. 設定開機自動登入桌面：sudo raspi-config → System Options → Boot / Auto Login → Desktop Autologin
  2. 確認 Mac 上的 Nous App 正在執行，連接埠為 $AIOS_PORT
  3. 執行 aios-doctor 檢查（若找不到指令，請重新登入讓 ~/.local/bin 加入 PATH）
  4. 重新開機：sudo reboot" \
    "Next steps:
  1. Enable desktop autologin: sudo raspi-config -> System Options -> Boot / Auto Login -> Desktop Autologin
  2. Make sure the Nous App is running on the Mac on port $AIOS_PORT
  3. Run aios-doctor (if the command is not found, log in again so ~/.local/bin is on PATH)
  4. Reboot: sudo reboot"
}

((skip_apt)) || install_packages
configure
ensure_key
verify_host_key
((skip_copy_id)) || authorize_key
install_files
enable_linger
start_services
next_steps
