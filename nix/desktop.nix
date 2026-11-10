# june-desktop: June's desktop client (desktop/), run from a checkout when configured, else the store. `june-desktop` runs it;
# `june-desktop cycle` steps the running one through live June, the full strip, and hidden, for a single compositor
# bind; `toggle`, `open`, `close`, and `mini` reach each directly; `window` opens the strip in an ordinary window;
# `live off` keeps live June away until `live on`; `look console` drops the comic for a terminal style, `look comic`
# brings it back; `quiet on` is do not disturb (mako's mode); `scheme dark` or `light` holds the colour scheme, and
# `scheme system` follows the desktop again. `light 21.5` previews every panel at that hour, and `light now` puts
# each back at its own. It ships the base avatar set from templates/avatar; a personal set goes in front of it: one
# named in JUNE_DESKTOP_ART, June's data directory's avatar/ when this machine has one, or else the daemon's.
{
  lib,
  runCommand,
  writeShellApplication,
  quickshell,
  qt6,
  systemd,
  google-fonts,
  source ? null,
}: let
  fonts = google-fonts.override {fonts = ["ShantellSans" "DelaGothicOne" "ZenKakuGothicNew"];};
  src = lib.fileset.toSource {
    root = ../desktop;
    fileset = lib.fileset.fileFilter (file: file.hasExt "qml" || file.hasExt "mjs") ../desktop;
  };
  config = runCommand "june-desktop-config" {} "cp -r ${src} $out";
  # The base avatar set: labelled placeholder poses, until June's art exists.
  art = lib.fileset.toSource {
    root = ../templates/avatar;
    fileset = ../templates/avatar;
  };
in
  writeShellApplication {
    name = "june-desktop";
    # busctl reads the desktop's do-not-disturb and colour scheme.
    runtimeInputs = [quickshell systemd];
    text = ''
      # Only this Qt's modules and plugins: the desktop's Qt settings may name plugins built against another Qt.
      export QML2_IMPORT_PATH=${qt6.qtwebsockets}/lib/qt-6/qml
      # WebP, which finished avatar art is; Qt's own image formats stop at GIF, JPEG, and SVG.
      export QT_PLUGIN_PATH="${qt6.qtimageformats}/lib/qt-6/plugins''${QT_PLUGIN_PATH:+:$QT_PLUGIN_PATH}"
      export QT_QUICK_CONTROLS_STYLE=Basic
      unset QT_STYLE_OVERRIDE QT_QPA_PLATFORMTHEME
      export JUNE_DESKTOP_FONTS=${fonts}/share/fonts/truetype
      # A personal avatar set comes first: one named in JUNE_DESKTOP_ART, else June's data directory's when this machine
      # has it (synced, or the daemon's own host). Without either, the desktop client loads the daemon's set over HTTP. The base
      # set fills the rest.
      personal="''${XDG_DATA_HOME:-$HOME/.local/share}/june/avatar"
      if [ -z "''${JUNE_DESKTOP_ART:-}" ] && [ -f "$personal/manifest.json" ]; then JUNE_DESKTOP_ART=$personal; fi
      export JUNE_DESKTOP_ART="''${JUNE_DESKTOP_ART:+$JUNE_DESKTOP_ART:}${art}"
      # Service, launcher and IPC must select the same config. JUNE_SOURCE=none forces the packaged copy.
      source="''${JUNE_SOURCE:-${lib.optionalString (source != null) source}}"
      config=${config}
      if [[ -n $source && -f $source/desktop/shell.qml ]]; then config="$source/desktop"; fi
      case "''${1:-}" in
        "") exec qs -p "$config" ;;
        cycle | toggle | open | close | mini | window | refresh) exec qs -p "$config" ipc call june "$1" ;;
        light) exec qs -p "$config" ipc call june light "''${2:-now}" ;;
        live) exec qs -p "$config" ipc call june live "''${2:-flip}" ;;
        look) exec qs -p "$config" ipc call june look "''${2:-flip}" ;;
        quiet) exec qs -p "$config" ipc call june quiet "''${2:-flip}" ;;
        scheme) exec qs -p "$config" ipc call june scheme "''${2:-system}" ;;
        *)
          echo "usage: june-desktop [cycle|toggle|open|close|mini|window|refresh|light HOUR|live on/off|look comic/console|quiet on/off|scheme system/dark/light]" >&2
          exit 2
          ;;
      esac
    '';
    meta.description = "June's desktop client";
  }
