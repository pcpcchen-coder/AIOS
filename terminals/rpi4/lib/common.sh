#!/usr/bin/env bash
# Shared helpers for the AIOS Pi terminal kit. Sourced, never executed.
# shellcheck disable=SC2034  # variables are consumed by the scripts that source this file

AIOS_CONFIG_DIR="$HOME/.config/aios-terminal"
AIOS_CONFIG_FILE="$AIOS_CONFIG_DIR/terminal.conf"
AIOS_KEY="$AIOS_CONFIG_DIR/id_ed25519"
AIOS_KNOWN_HOSTS="$AIOS_CONFIG_DIR/known_hosts"
AIOS_LINGER_MARKER="$AIOS_CONFIG_DIR/linger-enabled-by-installer"
AIOS_SHARE_DIR="$HOME/.local/share/aios-terminal"
AIOS_PROFILE_DIR="$AIOS_SHARE_DIR/chromium-profile"
AIOS_LOCAL_BIN="$HOME/.local/bin"
AIOS_UNIT_DIR="$HOME/.config/systemd/user"
AIOS_AUTOSTART_FILE="$HOME/.config/autostart/aios-kiosk.desktop"
AIOS_COMMANDS=(aios-doctor aios-tunnel aios-kiosk aios-session-start aios-display)
AIOS_UNITS=(aios-tunnel.service aios-kiosk.service aios-display.service)
# DN-3: udev rule that lets the video group switch a DSI backlight (overridable for the dry run).
AIOS_UDEV_RULE="${AIOS_UDEV_RULE:-/etc/udev/rules.d/90-aios-backlight.rules}"

t() {
  case "${AIOS_LANG:-${LANG:-}}" in
    zh*) printf '%s\n' "$1" ;;
    *) printf '%s\n' "$2" ;;
  esac
}

die() {
  t "$1" "$2" >&2
  exit "${3:-1}"
}

valid_user() { [[ "$1" =~ ^[A-Za-z_][A-Za-z0-9._-]*$ ]]; }
valid_host() { [[ "$1" =~ ^[A-Za-z0-9.-]+$ ]]; }
valid_port() { [[ "$1" =~ ^[0-9]{1,5}$ ]] && ((10#$1 >= 1 && 10#$1 <= 65535)); }

# Parsed instead of sourced so a tampered or hand-edited file can never run code.
load_config() {
  local file="$AIOS_CONFIG_FILE" line key value
  CONFIG_ERROR=""
  AIOS_MAC_USER=""
  AIOS_MAC_HOST=""
  AIOS_PORT=8787
  AIOS_SSH_PORT=22
  if [[ ! -f "$file" ]]; then
    CONFIG_ERROR="$(t "找不到設定檔 $file，請先執行 install.sh。" "Config file $file not found; run install.sh first.")"
    return 1
  fi
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%%#*}"
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [[ -z "$line" ]] && continue
    if [[ ! "$line" =~ ^([A-Z_]+)=([A-Za-z0-9._:-]*)$ ]]; then
      CONFIG_ERROR="$(t "設定檔有無法接受的行：$line" "Config file has an unacceptable line: $line")"
      return 1
    fi
    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    case "$key" in
      AIOS_MAC_USER) AIOS_MAC_USER="$value" ;;
      AIOS_MAC_HOST) AIOS_MAC_HOST="$value" ;;
      AIOS_PORT) [[ -n "$value" ]] && AIOS_PORT="$value" ;;
      AIOS_SSH_PORT) [[ -n "$value" ]] && AIOS_SSH_PORT="$value" ;;
      *)
        CONFIG_ERROR="$(t "設定檔有未知的鍵：$key" "Config file has an unknown key: $key")"
        return 1
        ;;
    esac
  done <"$file"
  validate_config
}

validate_config() {
  CONFIG_ERROR=""
  if ! valid_user "$AIOS_MAC_USER"; then
    CONFIG_ERROR="$(t "AIOS_MAC_USER 無效或空白：'$AIOS_MAC_USER'" "AIOS_MAC_USER is invalid or empty: '$AIOS_MAC_USER'")"
  elif ! valid_host "$AIOS_MAC_HOST"; then
    CONFIG_ERROR="$(t "AIOS_MAC_HOST 無效或空白：'$AIOS_MAC_HOST'" "AIOS_MAC_HOST is invalid or empty: '$AIOS_MAC_HOST'")"
  elif ! valid_port "$AIOS_PORT"; then
    CONFIG_ERROR="$(t "AIOS_PORT 必須是 1–65535 的整數：'$AIOS_PORT'" "AIOS_PORT must be an integer 1-65535: '$AIOS_PORT'")"
  elif ! valid_port "$AIOS_SSH_PORT"; then
    CONFIG_ERROR="$(t "AIOS_SSH_PORT 必須是 1–65535 的整數：'$AIOS_SSH_PORT'" "AIOS_SSH_PORT must be an integer 1-65535: '$AIOS_SSH_PORT'")"
  fi
  [[ -z "$CONFIG_ERROR" ]]
}

write_config() {
  local file="$AIOS_CONFIG_FILE" tmp
  mkdir -p "$(dirname "$file")"
  chmod 700 "$(dirname "$file")"
  tmp="$(mktemp "$file.XXXXXX")"
  chmod 600 "$tmp"
  {
    printf '# AIOS Pi terminal: written by install.sh\n'
    printf 'AIOS_MAC_USER=%s\n' "$AIOS_MAC_USER"
    printf 'AIOS_MAC_HOST=%s\n' "$AIOS_MAC_HOST"
    printf 'AIOS_PORT=%s\n' "$AIOS_PORT"
    printf 'AIOS_SSH_PORT=%s\n' "$AIOS_SSH_PORT"
  } >"$tmp"
  mv -f "$tmp" "$file"
}

find_chromium() {
  local candidate
  for candidate in "${AIOS_CHROMIUM:-}" chromium chromium-browser; do
    [[ -n "$candidate" ]] || continue
    if command -v "$candidate" >/dev/null 2>&1; then
      command -v "$candidate"
      return 0
    fi
  done
  return 1
}

core_url() { printf 'http://localhost:%s%s' "$AIOS_PORT" "${1:-}"; }

# DN-3: how to turn the screen off and on. AIOS_DISPLAY_METHOD forces one of backlight, wlr-randr, xset or none;
# otherwise the first that works wins: a writable DSI backlight, then wlr-randr (Wayland), then xset (X11).
backlight_device() {
  local dir
  for dir in "${AIOS_BACKLIGHT_DIR:-/sys/class/backlight}"/*; do
    if [[ -w "$dir/bl_power" ]]; then
      printf '%s' "$dir"
      return 0
    fi
  done
  return 1
}

detect_display_method() {
  case "${AIOS_DISPLAY_METHOD:-auto}" in
    backlight | wlr-randr | xset | none)
      printf '%s' "$AIOS_DISPLAY_METHOD"
      return 0
      ;;
    auto) ;;
    *) return 1 ;;
  esac
  if backlight_device >/dev/null; then
    printf backlight
  elif [[ -n "${WAYLAND_DISPLAY:-}" ]] && command -v wlr-randr >/dev/null 2>&1; then
    printf wlr-randr
  elif [[ -n "${DISPLAY:-}" ]] && command -v xset >/dev/null 2>&1; then
    printf xset
  else
    printf none
  fi
}

# set_screen METHOD on|off
set_screen() {
  local method="$1" state="$2" device output
  case "$method" in
    backlight)
      device="$(backlight_device)" || return 1
      if [[ "$state" == off ]]; then printf 1 >"$device/bl_power"; else printf 0 >"$device/bl_power"; fi
      ;;
    wlr-randr)
      while read -r output; do
        [[ -n "$output" ]] || continue
        wlr-randr --output "$output" "--$state" || return 1
      done < <(wlr-randr | awk '/^[^ \t]/ {print $1}')
      ;;
    xset)
      xset dpms force "$state"
      ;;
    none) return 0 ;;
    *) return 1 ;;
  esac
}
