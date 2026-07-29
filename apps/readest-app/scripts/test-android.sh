#!/usr/bin/env bash
# Android CDP e2e lane: runs vitest against the Readest app installed on an
# adb-connected device or emulator. Soft-skips (exit 0) when no adb, no
# device, or no installed app is found, so it is safe in any environment.
# Select a device with ANDROID_SERIAL when several are attached.
set -uo pipefail
cd "$(dirname "$0")/.."

STOCK_PKG="com.bilingify.readest"
PKG="${READEST_ANDROID_PACKAGE:-$STOCK_PKG}"
BUFFERED_E2E="${READEST_ANDROID_BUFFERED_E2E:-0}"

if [[ ! "$PKG" =~ ^[A-Za-z][A-Za-z0-9._]*$ ]]; then
  echo "[test:android] invalid READEST_ANDROID_PACKAGE: $PKG" >&2
  exit 2
fi

if [ "$BUFFERED_E2E" = "1" ] && [ "$PKG" = "$STOCK_PKG" ]; then
  echo "[test:android] buffered E2E refuses to mutate the stock package" >&2
  echo "[test:android] set READEST_ANDROID_PACKAGE to an isolated debug package" >&2
  exit 2
fi

if ! command -v adb >/dev/null 2>&1; then
  echo "[test:android] adb not found — skipping Android e2e lane"
  [ "$BUFFERED_E2E" = "1" ] && exit 1
  exit 0
fi

DEVICES=$(adb devices | tail -n +2 | awk '$2 == "device" { print $1 }')
if [ -z "$DEVICES" ]; then
  echo "[test:android] no adb device/emulator connected — skipping Android e2e lane"
  echo "[test:android] hint: start one with: emulator -avd <name> (see 'emulator -list-avds')"
  [ "$BUFFERED_E2E" = "1" ] && exit 1
  exit 0
fi

if ! adb shell pm list packages "$PKG" 2>/dev/null | grep -q "package:$PKG"; then
  echo "[test:android] $PKG is not installed on the device — skipping Android e2e lane"
  echo "[test:android] hint: install a dev build with: pnpm dev-android"
  [ "$BUFFERED_E2E" = "1" ] && exit 1
  exit 0
fi

exec pnpm exec vitest run --config vitest.android.config.mts "$@"
