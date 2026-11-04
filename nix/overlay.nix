# june-overlay: June's Hyprland overlay (overlay/), a Quickshell config run from the store. `june-overlay` runs it;
# `june-overlay cycle` steps the running one through live June, the full strip, and hidden, for a single compositor
# bind; `toggle`, `open`, `close`, and `mini` reach each directly. `light 21.5` previews every panel at that hour, and
# `light now` puts each back at its own. It ships the base avatar set from templates/avatar; JUNE_OVERLAY_ART can put a
# personal set in front of it.
{
  lib,
  runCommand,
  writeShellApplication,
  quickshell,
  qt6,
  google-fonts,
}: let
  fonts = google-fonts.override {fonts = ["ShantellSans" "DelaGothicOne" "ZenKakuGothicNew"];};
  src = lib.fileset.toSource {
    root = ../overlay;
    fileset = lib.fileset.fileFilter (file: file.hasExt "qml" || file.hasExt "mjs") ../overlay;
  };
  config = runCommand "june-overlay-config" {} "cp -r ${src} $out";
  # The base avatar set: labelled placeholder poses, until June's art exists.
  art = lib.fileset.toSource {
    root = ../templates/avatar;
    fileset = ../templates/avatar;
  };
in
  writeShellApplication {
    name = "june-overlay";
    runtimeInputs = [quickshell];
    text = ''
      # Only this Qt's modules and plugins: the desktop's Qt settings may name plugins built against another Qt.
      export QML2_IMPORT_PATH=${qt6.qtwebsockets}/lib/qt-6/qml
      export QT_QUICK_CONTROLS_STYLE=Basic
      unset QT_STYLE_OVERRIDE QT_QPA_PLATFORMTHEME
      export JUNE_OVERLAY_FONTS=${fonts}/share/fonts/truetype
      # A personal avatar set named in JUNE_OVERLAY_ART comes first; the base set fills the rest.
      export JUNE_OVERLAY_ART="''${JUNE_OVERLAY_ART:+$JUNE_OVERLAY_ART:}${art}"
      case "''${1:-}" in
        "") exec qs -p ${config} ;;
        cycle | toggle | open | close | mini) exec qs -p ${config} ipc call june "$1" ;;
        light) exec qs -p ${config} ipc call june light "''${2:-now}" ;;
        *)
          echo "usage: june-overlay [cycle|toggle|open|close|mini|light HOUR]" >&2
          exit 2
          ;;
      esac
    '';
    meta.description = "June's Hyprland overlay";
  }
