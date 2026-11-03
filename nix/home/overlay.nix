# programs.june.overlay: June's Hyprland overlay as a user service in the graphical session, and june-overlay on PATH
# for the compositor bind (`june-overlay toggle`). It reaches the daemon over its WebSocket listener with a device
# token from `june device add`, kept in a file outside the store.
self: {
  config,
  lib,
  pkgs,
  ...
}: let
  cfg = config.programs.june;
  overlay = self.packages.${pkgs.stdenv.hostPlatform.system}.overlay;
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
