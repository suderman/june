# programs.june.overlay: June's Hyprland overlay as a user service in the graphical session, and june-overlay on PATH
# for the compositor bind (`june-overlay toggle`). It reaches the daemon over its WebSocket listener with a device
# token from `june device add`, kept in a file outside the store. A "June" launcher entry opens the strip in an
# ordinary window, starting the service first if it is not running.
self: {
  config,
  lib,
  pkgs,
  ...
}: let
  cfg = config.programs.june;
  overlay = self.packages.${pkgs.stdenv.hostPlatform.system}.overlay.override {source = cfg.source;};
  # The service may still be starting, so try the window for a few seconds.
  openWindow = pkgs.writeShellScript "june-window" ''
    ${pkgs.systemd}/bin/systemctl --user start june-overlay.service
    for _ in {1..40}; do
      ${lib.getExe overlay} window 2>/dev/null && exit 0
      ${pkgs.coreutils}/bin/sleep 0.25
    done
    echo "june-overlay did not start; see journalctl --user -u june-overlay" >&2
    exit 1
  '';
in {
  options.programs.june.overlay = {
    enable = lib.mkEnableOption "June's Hyprland overlay";
    url = lib.mkOption {
      type = lib.types.str;
      example = "wss://june.kit/";
      description = "The daemon's WebSocket listener, as served by the reverse proxy in front of it.";
    };
    tokenFile = lib.mkOption {
      type = lib.types.str;
      example = "/run/user/1000/agenix/june-overlay-token";
      description = "A file holding this device's token from `june device add`, readable only by the user. Not a store path: the token must stay out of the store.";
    };
  };

  config = lib.mkIf (cfg.enable && cfg.overlay.enable) {
    assertions = [
      {
        assertion = !lib.hasPrefix builtins.storeDir cfg.overlay.tokenFile;
        message = "programs.june.overlay.tokenFile must not be in the Nix store";
      }
    ];

    home.packages = [overlay];

    xdg.desktopEntries.june = {
      name = "June";
      genericName = "Assistant";
      comment = "June's conversation as a comic strip";
      exec = "${openWindow}";
      categories = ["Utility"];
      terminal = false;
    };

    systemd.user.services.june-overlay = {
      Unit = {
        Description = "June's Hyprland overlay";
        PartOf = ["graphical-session.target"];
        After = ["graphical-session.target"];
      };
      Service = {
        Type = "simple";
        ExecStart = lib.getExe overlay;
        Environment = [
          "JUNE_OVERLAY_URL=${cfg.overlay.url}"
          "JUNE_OVERLAY_TOKEN_FILE=${cfg.overlay.tokenFile}"
        ];
        Restart = "on-failure";
        RestartSec = 5;
      };
      Install.WantedBy = ["graphical-session.target"];
    };
  };
}
