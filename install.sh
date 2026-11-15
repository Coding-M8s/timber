#!/bin/sh
# Timber standalone installer.
#
# Downloads a published Timber release for this machine, verifies its checksums,
# and installs the executable. Supported: Linux x86_64 (glibc) and macOS beta
# (Apple Silicon and Intel). Windows uses the steps in docs/windows.md.
#
# Environment:
#   TIMBER_VERSION       Release tag to install, such as v0.1.0. Default: latest.
#   TIMBER_INSTALL_DIR   Absolute install directory. Default: $HOME/.local/bin.
#   TIMBER_RELEASES_URL  Releases base URL (https only). Default: GitHub.
#
# The whole script is one function called on the last line, so a truncated
# download cannot run a partial installer.

set -eu

timber_install() {
  releases_url="${TIMBER_RELEASES_URL:-https://github.com/Coding-M8s/timber/releases}"
  manual_steps="https://github.com/Coding-M8s/timber/blob/main/docs/guide.md#install-the-standalone-cli"
  work_dir=""
  staged=""

  say() { printf '%s\n' "$*"; }
  fail() {
    printf 'timber install: %s\n' "$*" >&2
    exit 1
  }
  cleanup() {
    if [ -n "$staged" ]; then rm -f "$staged"; fi
    if [ -n "$work_dir" ]; then rm -rf "$work_dir"; fi
  }
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  # Matches the stable and numbered release candidate tags the release build accepts.
  is_release_tag() {
    case "$1" in
      "" | *[!A-Za-z0-9.-]*) return 1 ;;
    esac
    printf '%s\n' "$1" | grep -Eq \
      '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-rc\.(0|[1-9][0-9]*))?$'
  }

  fetch() {
    curl --proto '=https' --proto-redir '=https' --tlsv1.2 \
      --fail --silent --show-error --location "$@"
  }

  # Refuse unsupported machines before any download.
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os" in
    Linux)
      case "$arch" in
        x86_64 | amd64) target="linux-x64" ;;
        *) fail "Linux $arch is not supported. Timber publishes Linux x86_64 only. Manual steps: $manual_steps" ;;
      esac
      if ! getconf GNU_LIBC_VERSION >/dev/null 2>&1; then
        fail "this Linux system does not use glibc (musl and Alpine are not supported). Manual steps: $manual_steps"
      fi
      metadata="build-info.json"
      checksums="SHA256SUMS"
      ;;
    Darwin)
      case "$arch" in
        arm64) target="darwin-arm64" ;;
        x86_64) target="darwin-x64" ;;
        *) fail "macOS $arch is not supported. Manual steps: $manual_steps" ;;
      esac
      metadata="build-info-$target.json"
      checksums="SHA256SUMS-$target"
      ;;
    MINGW* | MSYS* | CYGWIN*)
      fail "Windows is not supported by this installer. See https://github.com/Coding-M8s/timber/blob/main/docs/windows.md"
      ;;
    *) fail "$os is not supported. Manual steps: $manual_steps" ;;
  esac

  case "$releases_url" in
    https://*) ;;
    *) fail "TIMBER_RELEASES_URL must start with https://" ;;
  esac
  releases_url="${releases_url%/}"

  if [ -n "${TIMBER_INSTALL_DIR:-}" ]; then
    install_dir="$TIMBER_INSTALL_DIR"
  elif [ -n "${HOME:-}" ]; then
    install_dir="$HOME/.local/bin"
  else
    fail "HOME is not set. Set TIMBER_INSTALL_DIR to an absolute directory."
  fi
  case "$install_dir" in
    /*) ;;
    *) fail "TIMBER_INSTALL_DIR must be an absolute path." ;;
  esac
  install_dir="${install_dir%/}"
  if [ -z "$install_dir" ]; then fail "TIMBER_INSTALL_DIR must not be the root directory."; fi

  command -v curl >/dev/null 2>&1 || fail "curl is required."
  if command -v sha256sum >/dev/null 2>&1; then
    verify_checksums() { sha256sum -c "$1" >/dev/null; }
  elif command -v shasum >/dev/null 2>&1; then
    verify_checksums() { shasum -a 256 -c "$1" >/dev/null; }
  else
    fail "sha256sum or shasum is required to verify the download. Nothing was installed."
  fi

  if [ -n "${TIMBER_VERSION:-}" ]; then
    tag="$TIMBER_VERSION"
    is_release_tag "$tag" || fail "TIMBER_VERSION must be a release tag such as v0.1.0."
  else
    # The latest release page redirects to its tag; this avoids the rate-limited API.
    latest="$(fetch --head --output /dev/null --write-out '%{url_effective}' "$releases_url/latest")" ||
      fail "could not find the latest release at $releases_url/latest"
    tag="${latest##*/}"
    is_release_tag "$tag" ||
      fail "could not read a release tag from $releases_url/latest. Set TIMBER_VERSION to choose one."
  fi

  executable="timber-$tag-$target"
  download_url="$releases_url/download/$tag"
  work_dir="$(mktemp -d "${TMPDIR:-/tmp}/timber-install.XXXXXX")"

  say "Downloading Timber $tag for $target"
  for asset in "$executable" "$metadata" "$checksums" LICENSE THIRD_PARTY_NOTICES.txt; do
    fetch --output "$work_dir/$asset" "$download_url/$asset" ||
      fail "could not download $asset from $download_url. Nothing was installed."
  done

  # The checksum file must name the executable, or a passing check proves nothing about it.
  awk -v name="$executable" '
    { file = $2; sub(/^\*/, "", file); if (file == name) found = 1 }
    END { exit found ? 0 : 1 }
  ' "$work_dir/$checksums" ||
    fail "$checksums does not list $executable. Nothing was installed."
  (cd "$work_dir" && verify_checksums "$checksums") ||
    fail "checksum verification failed. Nothing was installed."

  mkdir -p "$install_dir"
  staged="$install_dir/.timber-install.$$"
  cp "$work_dir/$executable" "$staged"
  chmod 755 "$staged"

  # Run the new executable before it replaces anything, so a build that cannot
  # start on this machine leaves an existing install in place.
  expected_version="${tag#v}"
  actual_version="$("$staged" --version 2>/dev/null)" ||
    fail "the downloaded executable did not run on this machine. Nothing was installed."
  [ "$actual_version" = "$expected_version" ] ||
    fail "the downloaded executable reports version $actual_version, expected $expected_version. Nothing was installed."

  mv -f "$staged" "$install_dir/timber"
  staged=""

  say "Installed Timber $actual_version to $install_dir/timber"
  if [ "$os" = Darwin ]; then
    say "macOS support is beta. These executables are unsigned and not notarized."
  fi

  resolved="$(command -v timber 2>/dev/null || true)"
  if [ -z "$resolved" ]; then
    say "$install_dir is not on your PATH. Add this line to your shell startup file:"
    say "  export PATH=\"$install_dir:\$PATH\""
  elif [ "$resolved" != "$install_dir/timber" ]; then
    say "Warning: another timber at $resolved comes first on your PATH and hides this install."
    say "Remove it, or put $install_dir earlier on your PATH."
  fi
}

timber_install
