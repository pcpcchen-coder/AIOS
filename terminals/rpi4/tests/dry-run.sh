#!/usr/bin/env bash
# Exercises the Pi terminal kit on any Linux box: every external command except ssh-keygen is a fake
# that records its argv, so nothing touches apt, systemd, the network or a real Mac.
# shellcheck disable=SC2016  # fake command bodies are single-quoted on purpose; they expand when the fake runs
set -euo pipefail

KIT="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"

if ! command -v ssh-keygen >/dev/null 2>&1; then
  echo "skip - ssh-keygen not installed (apt-get install openssh-client); dry run not executed"
  exit 0
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
FAKEBIN="$WORK/fakebin"
mkdir -p "$FAKEBIN"
export CALLS="$WORK/calls.log"
export FAKE_HOSTKEY_PUB="$WORK/hostkey.pub"
ssh-keygen -q -t ed25519 -N "" -C fake-mac -f "$WORK/hostkey"
HOSTKEY_FP="$(ssh-keygen -lf "$FAKE_HOSTKEY_PUB" -E sha256 | awk '{print $2}')"

fake() {
  local name="$1" body="${2:-exit 0}"
  {
    printf '#!/usr/bin/env bash\n'
    printf 'printf "%%s\\n" "%s $*" >>"$CALLS"\n' "$name"
    printf '%s\n' "$body"
  } >"$FAKEBIN/$name"
  chmod +x "$FAKEBIN/$name"
}

fake sudo 'exec "$@"'
fake apt-get
fake apt-cache
fake id 'case "${1:-}" in -u) echo 1000 ;; -un) echo pi ;; *) echo "uid=1000(pi) gid=1000(pi)" ;; esac'
fake hostname 'echo raspberrypi'
fake systemctl '
if [[ "${1:-} ${2:-}" == "--user is-active" ]]; then
  case "${3:-}" in
    aios-tunnel.service) if [[ -n "${FAKE_TUNNEL_INACTIVE:-}" ]]; then echo inactive; exit 3; fi ;;
    aios-kiosk.service) if [[ -n "${FAKE_KIOSK_INACTIVE:-}" ]]; then echo inactive; exit 3; fi ;;
  esac
  echo active
fi
exit 0'
fake loginctl 'if [[ "${1:-}" == show-user ]]; then echo Linger=no; fi
exit 0'
fake ssh-keyscan '
port=22 host=""
while (($#)); do
  case "$1" in
    -p) port="$2"; shift 2 ;;
    -T | -t) shift 2 ;;
    *) host="$1"; shift ;;
  esac
done
key="$(awk "{print \$1\" \"\$2}" "$FAKE_HOSTKEY_PUB")"
echo "# $host:$port SSH-2.0-OpenSSH_9.8"
if [[ "$port" == 22 ]]; then echo "$host $key"; else echo "[$host]:$port $key"; fi'
fake ssh-copy-id
fake ssh
fake autossh
fake chromium
fake curl '
out="" wfmt="" url=""
while (($#)); do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -w) wfmt="$2"; shift 2 ;;
    --max-time) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
if [[ -n "${FAKE_CURL_FAIL:-}" ]]; then
  if [[ -n "$wfmt" ]]; then printf 000; fi
  exit 7
fi
case "$url" in
  */api/settings) body="{\"provider\":\"mock\"}" ;;
  *) body="<!doctype html><script></script>" ;;
esac
if [[ -z "$out" || "$out" == - ]]; then printf "%s" "$body"; else printf "%s" "$body" >"$out"; fi
if [[ -n "$wfmt" ]]; then printf 200; fi
exit 0'
fake ss 'if [[ -z "${FAKE_SS_EMPTY:-}" ]]; then echo "LISTEN 0 128 127.0.0.1:8787 0.0.0.0:*"; fi'
fake arecord 'echo "card 2: Device [USB PnP Sound Device], device 0: USB Audio [USB Audio]"'
fake aplay 'echo "card 0: vc4hdmi0 [vc4-hdmi-0], device 0: MAI PCM i2s-hifi-0 [MAI PCM i2s-hifi-0]"
echo "card 2: Device [USB PnP Sound Device], device 0: USB Audio [USB Audio]"'
fake v4l2-ctl 'printf "USB Camera (usb-0000:01:00.0-1.2):\n\t/dev/video0\n\t/dev/video1\n"'
fake vcgencmd 'case "${1:-}" in
  measure_temp) echo "temp=${FAKE_TEMP:-48.3}'"'"'C" ;;
  get_throttled) echo "throttled=${FAKE_THROTTLED:-0x0}" ;;
esac'
fake ip 'echo "default via 192.168.1.1 dev wlan0 proto dhcp src 192.168.1.50 metric 600"'
fake timeout 'exec true'

export PATH="$FAKEBIN:$PATH"
export USER=pi AIOS_LANG=en LANG=C.UTF-8
unset DISPLAY WAYLAND_DISPLAY AIOS_CHROMIUM AIOS_MAC_USER AIOS_MAC_HOST AIOS_PORT AIOS_SSH_PORT AIOS_MAC_HOSTKEY_SHA256

export AIOS_MEMINFO="$WORK/meminfo"
printf 'MemTotal:        3884812 kB\nMemFree:          912345 kB\nMemAvailable:    2734567 kB\n' >"$AIOS_MEMINFO"

checks=0
ok() {
  checks=$((checks + 1))
  printf 'ok - %s\n' "$1"
}
fail() {
  printf 'not ok - %s\n' "$1" >&2
  if [[ -f "$WORK/out" ]]; then sed 's/^/    | /' "$WORK/out" >&2; fi
  exit 1
}
check() {
  local desc="$1"
  shift
  if "$@"; then ok "$desc"; else fail "$desc"; fi
}
called() { grep -qxF -- "$1" "$CALLS"; }
called_matching() { grep -qE -- "$1" "$CALLS"; }
lacks() { ! grep -qE -- "$1" "$2"; }
quiet() { "$@" >"$WORK/out" 2>&1; }
lacks_recursive() {
  local pattern="$1"
  shift
  ! grep -rEl --exclude-dir=tests --exclude='*.md' -- "$pattern" "$@"
}
reset_calls() { : >"$CALLS"; }

use_home() {
  export HOME="$WORK/$1"
  mkdir -p "$HOME"
  CONF="$HOME/.config/aios-terminal"
  SHARE="$HOME/.local/share/aios-terminal"
  UNITS="$HOME/.config/systemd/user"
  AUTOSTART="$HOME/.config/autostart/aios-kiosk.desktop"
  LBIN="$HOME/.local/bin"
}

run_install() {
  AIOS_MAC_USER=alice AIOS_MAC_HOST=mac-mini.local AIOS_MAC_HOSTKEY_SHA256="$1" \
    bash "$KIT/install.sh" --non-interactive >"$WORK/out" 2>&1
}

use_home home
reset_calls
check "install --non-interactive succeeds with the correct host key fingerprint" run_install "$HOSTKEY_FP"
check "config file is mode 600" test "$(stat -c %a "$CONF/terminal.conf")" = 600
for line in AIOS_MAC_USER=alice AIOS_MAC_HOST=mac-mini.local AIOS_PORT=8787 AIOS_SSH_PORT=22; do
  check "config holds $line" grep -qx "$line" "$CONF/terminal.conf"
done
check "ed25519 key pair generated" test -f "$CONF/id_ed25519" -a -f "$CONF/id_ed25519.pub"
check "key comment names this Pi" grep -q ' aios-terminal@raspberrypi$' "$CONF/id_ed25519.pub"
check "dedicated known_hosts holds exactly the scanned host key" \
  test "$(cat "$CONF/known_hosts")" = "mac-mini.local $(awk '{print $1" "$2}' "$FAKE_HOSTKEY_PUB")"
for unit in aios-tunnel.service aios-kiosk.service; do
  check "unit $unit installed" test -f "$UNITS/$unit"
done
check "autostart desktop entry installed" test -f "$AUTOSTART"
for name in aios-doctor aios-tunnel aios-kiosk aios-session-start; do
  check "symlink ~/.local/bin/$name points at an executable" test -L "$LBIN/$name" -a -x "$LBIN/$name"
done
check "apt-get installs autossh, v4l-utils and chromium" called "apt-get install -y autossh openssh-client v4l-utils alsa-utils curl chromium"
check "ssh-copy-id uses the dedicated known_hosts with strict checking" \
  called "ssh-copy-id -i $CONF/id_ed25519.pub -p 22 -o UserKnownHostsFile=$CONF/known_hosts -o StrictHostKeyChecking=yes alice@mac-mini.local"
check "key login is verified in batch mode" called_matching '^ssh .*-o BatchMode=yes -o IdentitiesOnly=yes alice@mac-mini.local true$'
check "tunnel unit enabled and started" called "systemctl --user enable --now aios-tunnel.service"
check "kiosk unit is not enabled (started from desktop autostart)" lacks "enable.*aios-kiosk" "$CALLS"
check "linger enabled through sudo" called "sudo loginctl enable-linger pi"
check "linger marker written" test -f "$CONF/linger-enabled-by-installer"

check "re-running install converges" run_install "$HOSTKEY_FP"
check "known_hosts still has a single line" test "$(wc -l <"$CONF/known_hosts")" = 1
check "existing key is kept on re-run" grep -q 'Keeping existing SSH key' "$WORK/out"
check "re-run with the host key already trusted needs no fingerprint" run_install ""

use_home wrongfp
reset_calls
if run_install "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"; then fail "wrong fingerprint was accepted"; fi
ok "wrong host key fingerprint makes install exit non-zero"
check "wrong fingerprint leaves known_hosts unwritten" test ! -e "$CONF/known_hosts"
check "wrong fingerprint never calls ssh-copy-id" lacks "^ssh-copy-id" "$CALLS"
check "fingerprint without SHA256: prefix is accepted" run_install "${HOSTKEY_FP#SHA256:}"

use_home home
forbidden='StrictHostKeyChecking=no|accept-new|use-fake-ui-for-media-stream|use-fake-device-for-media-stream|disable-web-security|unsafely-treat-insecure-origin-as-secure'
check "kit and installed files never weaken host key checking or fake media permissions" \
  lacks_recursive "$forbidden" "$KIT" "$SHARE" "$UNITS" "$AUTOSTART"

reset_calls
check "aios-tunnel runs" "$LBIN/aios-tunnel"
tunnel_call="$(grep '^autossh ' "$CALLS" || true)"
for expected in "-M 0" "-N" "-o ExitOnForwardFailure=yes" "-o ServerAliveInterval=15" "-o ServerAliveCountMax=3" \
  "-o BatchMode=yes" "-o StrictHostKeyChecking=yes" "-o UserKnownHostsFile=$CONF/known_hosts" "-o IdentitiesOnly=yes" \
  "-i $CONF/id_ed25519" "-p 22" "-L 127.0.0.1:8787:127.0.0.1:8787" "alice@mac-mini.local"; do
  check "autossh gets $expected" grep -qF -- " $expected" <<<"$tunnel_call"
done
sed -i 's/^AIOS_PORT=.*/AIOS_PORT=8790/' "$CONF/terminal.conf"
reset_calls
"$LBIN/aios-tunnel"
check "AIOS_PORT=8790 forwards the same port on both ends" called_matching '^autossh .* -L 127\.0\.0\.1:8790:127\.0\.0\.1:8790 '
sed -i 's/^AIOS_PORT=.*/AIOS_PORT=8787/' "$CONF/terminal.conf"
mv "$CONF/known_hosts" "$CONF/known_hosts.bak"
set +e
"$LBIN/aios-tunnel" >"$WORK/out" 2>&1
status=$?
set -e
mv "$CONF/known_hosts.bak" "$CONF/known_hosts"
check "aios-tunnel exits 2 without a verified host key" test "$status" = 2

reset_calls
check "aios-kiosk launches once the core answers" "$LBIN/aios-kiosk"
kiosk_call="$(grep '^chromium ' "$CALLS" || true)"
for expected in "--kiosk" "--app=http://localhost:8787" "--autoplay-policy=no-user-gesture-required" \
  "--user-data-dir=$SHARE/chromium-profile" "--no-first-run" "--password-store=basic"; do
  check "chromium gets $expected" grep -qF -- " $expected" <<<"$kiosk_call"
done
check "kiosk probes /api/settings" called_matching '^curl .*http://localhost:8787/api/settings$'
reset_calls
if FAKE_CURL_FAIL=1 AIOS_KIOSK_WAIT_SECONDS=1 "$LBIN/aios-kiosk" >"$WORK/out" 2>&1; then fail "kiosk should give up when the core is down"; fi
ok "aios-kiosk exits non-zero when the core never answers"
check "aios-kiosk never launches chromium while the core is down" lacks "^chromium" "$CALLS"

doctor() {
  set +e
  "$LBIN/aios-doctor" >"$WORK/out" 2>&1
  status=$?
  set -e
}
doctor
check "doctor all-healthy exits 0" test "$status" = 0
check "doctor all-healthy prints no FAIL" lacks "^FAIL" "$WORK/out"
check "doctor reports English labels" grep -q '^PASS  SSH tunnel service: ' "$WORK/out"
check "doctor reports camera count" grep -q '^PASS  cameras: 2 video node' "$WORK/out"
check "doctor reports memory total" grep -q '^PASS  memory: 3793 MiB total, 70% available' "$WORK/out"
check "doctor never prints the settings body" lacks provider "$WORK/out"
AIOS_LANG=zh-TW doctor
check "doctor in zh-TW exits 0" test "$status" = 0
check "doctor in zh-TW prints Chinese labels" grep -q '^PASS  SSH 通道服務: ' "$WORK/out"
check "doctor in zh-TW prints a Chinese summary" grep -q '^結果：' "$WORK/out"

FAKE_THROTTLED=0x50005 doctor
check "throttled=0x50005 fails the doctor" test "$status" = 1
check "throttling FAIL names under-voltage now" grep -q '^FAIL  power and throttling: 0x50005 under-voltage now, throttled now, under-voltage occurred, throttling occurred' "$WORK/out"
FAKE_THROTTLED=0x50000 doctor
check "past-only throttling is a WARN" grep -q '^WARN  power and throttling: 0x50000 under-voltage occurred, throttling occurred$' "$WORK/out"
check "past-only throttling keeps exit 0" test "$status" = 0
FAKE_TUNNEL_INACTIVE=1 doctor
check "inactive tunnel fails the doctor" test "$status" = 1
check "inactive tunnel is a FAIL line" grep -q '^FAIL  SSH tunnel service: aios-tunnel.service inactive' "$WORK/out"
FAKE_TEMP=82.0 doctor
check "82.0C is a FAIL" grep -q '^FAIL  temperature: 82.0' "$WORK/out"
FAKE_TEMP=72.5 doctor
check "72.5C is a WARN" grep -q '^WARN  temperature: 72.5' "$WORK/out"
FAKE_CURL_FAIL=1 doctor
check "core down fails health and page checks" grep -q '^FAIL  Nous core health: GET /api/settings → 000' "$WORK/out"
FAKE_KIOSK_INACTIVE=1 doctor
check "inactive kiosk is only a WARN" grep -q '^WARN  kiosk service: ' "$WORK/out"
check "inactive kiosk keeps exit 0" test "$status" = 0
mv "$FAKEBIN/vcgencmd" "$WORK/vcgencmd.off"
if command -v vcgencmd >/dev/null 2>&1; then
  echo "skip - a real vcgencmd is on PATH; missing-vcgencmd case not exercised"
else
  doctor
  check "missing vcgencmd gives SKIP lines" grep -q '^SKIP  temperature: vcgencmd command not found' "$WORK/out"
  check "missing vcgencmd does not crash the doctor" test "$status" = 0
fi
mv "$WORK/vcgencmd.off" "$FAKEBIN/vcgencmd"
mv "$CONF/terminal.conf" "$CONF/terminal.conf.bak"
doctor
mv "$CONF/terminal.conf.bak" "$CONF/terminal.conf"
check "missing config fails the doctor" test "$status" = 1
check "missing config skips dependent checks" grep -q '^SKIP  Nous core health: config invalid' "$WORK/out"
printf 'AIOS_MAC_USER=alice\nAIOS_MAC_HOST=%s\n' "\$(touch $WORK/pwned)" >"$WORK/evil.conf"
cp "$CONF/terminal.conf" "$WORK/good.conf"
cp "$WORK/evil.conf" "$CONF/terminal.conf"
doctor
cp "$WORK/good.conf" "$CONF/terminal.conf"
check "config with shell syntax is rejected, not executed" test "$status" = 1 -a ! -e "$WORK/pwned"

reset_calls
check "uninstall succeeds" quiet bash "$KIT/uninstall.sh"
check "uninstall removes units" test ! -e "$UNITS/aios-tunnel.service" -a ! -e "$UNITS/aios-kiosk.service"
check "uninstall removes the autostart entry" test ! -e "$AUTOSTART"
check "uninstall removes the command symlinks" test ! -e "$LBIN/aios-doctor" -a ! -L "$LBIN/aios-tunnel"
check "uninstall removes installed scripts" test ! -e "$SHARE/bin" -a ! -e "$SHARE/lib"
check "uninstall disables linger it enabled" called "sudo loginctl disable-linger pi"
check "uninstall removes the linger marker" test ! -e "$CONF/linger-enabled-by-installer"
check "uninstall keeps config and key without --purge" test -f "$CONF/terminal.conf" -a -f "$CONF/id_ed25519"
check "uninstall prints the Mac authorized_keys cleanup" grep -qF "/ aios-terminal@raspberrypi\$/d" "$WORK/out"
check "uninstall never runs apt" lacks "^apt-get" "$CALLS"
reset_calls
check "re-running uninstall succeeds" quiet bash "$KIT/uninstall.sh"
check "re-run does not touch linger again" lacks "disable-linger" "$CALLS"
check "uninstall --purge succeeds" quiet bash "$KIT/uninstall.sh" --purge
check "--purge removes the config directory" test ! -e "$CONF"
check "re-running uninstall --purge succeeds" quiet bash "$KIT/uninstall.sh" --purge

if command -v shellcheck >/dev/null 2>&1; then
  check "shellcheck -x is clean" shellcheck -x "$KIT"/bin/* "$KIT"/lib/*.sh "$KIT/install.sh" "$KIT/uninstall.sh" "$KIT/tests/dry-run.sh"
else
  echo "skip - shellcheck not installed"
fi

echo "PASS: $checks checks"
