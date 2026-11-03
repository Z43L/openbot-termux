#!/data/data/com.termux/files/usr/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
prefix="$tmp/prefix"
home="$tmp/home"
mkdir -p "$prefix/bin" "$home"

cat >"$prefix/bin/sv" <<'EOF'
#!/data/data/com.termux/files/usr/bin/sh
printf '%s\n' "$*" >>"$OPENBOT_TEST_SV_LOG"
EOF
cp "$prefix/bin/sv" "$prefix/bin/svlogd"
chmod 0700 "$prefix/bin/sv" "$prefix/bin/svlogd"

export PREFIX="$prefix" HOME="$home" OPENBOT_TEST_SV_LOG="$tmp/sv.log"
export PATH="$prefix/bin:$PATH"
sh "$root/scripts/termux/install" --boot >/dev/null
sh "$root/scripts/termux/install" --boot >/dev/null

status=0
sh "$root/scripts/termux/openbot-server" --check >"$tmp/check.out" 2>&1 || status=$?
[ "$status" -eq 0 ] || { cat "$tmp/check.out" >&2; exit 1; }
grep -q 'Termux backend entry is available' "$tmp/check.out"
[ -x "$prefix/var/service/openbot/run" ]
[ -x "$prefix/var/service/openbot/finish" ]
[ -x "$prefix/var/service/openbot/log/run" ]
[ -x "$home/.termux/boot/10-openbot-services" ]
grep -q 'OPENBOT_TERMUX_DATA_DIR=' "$prefix/var/service/openbot/run"

"$prefix/bin/openbot-termux" status
grep -q '^status ' "$OPENBOT_TEST_SV_LOG"

printf '%s\n' 'PASS: installer is repeatable, creates runit and boot files, and checks the real backend entry.'
