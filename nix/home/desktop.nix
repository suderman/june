# programs.june.desktop: June's desktop client as a user service in the graphical session, and june-desktop on PATH
# for the compositor bind (`june-desktop toggle`). It reaches the daemon over its WebSocket listener with a device
# token from `june device add`, kept in a file outside the store. A "June" launcher entry opens the strip in an
# ordinary window, starting the service first if it is not running.
self: {
  config,
  lib,
  pkgs,
  ...
}: let
  cfg = config.programs.june;
  desktop = self.packages.${pkgs.stdenv.hostPlatform.system}.desktop.override {source = cfg.source;};
  # The service may still be starting, so try the window for a few seconds.
  openWindow = pkgs.writeShellScript "june-window" ''
    ${pkgs.systemd}/bin/systemctl --user start june-desktop.service
    for _ in {1..40}; do
      ${lib.getExe desktop} window 2>/dev/null && exit 0
      ${pkgs.coreutils}/bin/sleep 0.25
    done
    echo "june-desktop did not start; see journalctl --user -u june-desktop" >&2
    exit 1
  '';
in {
  options.programs.june.desktop = {
    enable = lib.mkEnableOption "June's desktop client";
    url = lib.mkOption {
      type = lib.types.str;
      example = "wss://june.kit/";
      description = "The daemon's WebSocket listener, as served by the reverse proxy in front of it.";
    };
    tokenFile = lib.mkOption {
      type = lib.types.str;
      example = "/run/user/1000/agenix/june-desktop-token";
      description = "A file holding this device's token from `june device add`, readable only by the user. Not a store path: the token must stay out of the store.";
    };
  };

  config = lib.mkIf (cfg.enable && cfg.desktop.enable) {
    assertions = [
      {
        assertion = !lib.hasPrefix builtins.storeDir cfg.desktop.tokenFile;
        message = "programs.june.desktop.tokenFile must not be in the Nix store";
      }
    ];

    home.packages = [desktop];

    xdg.desktopEntries.june = {
      name = "June";
      genericName = "Assistant";
      comment = "June's conversation as a comic strip";
      exec = "${openWindow}";
      categories = ["Utility"];
      terminal = false;
    };

    systemd.user.services.june-desktop = {
      Unit = {
        Description = "June's desktop client";
        PartOf = ["graphical-session.target"];
        After = ["graphical-session.target"];
      };
      Service = {
        Type = "simple";
        ExecStart = lib.getExe desktop;
        Environment = [
          "JUNE_DESKTOP_URL=${cfg.desktop.url}"
          "JUNE_DESKTOP_TOKEN_FILE=${cfg.desktop.tokenFile}"
        ];
        Restart = "on-failure";
        RestartSec = 5;
      };
      Install.WantedBy = ["graphical-session.target"];
    };
  };
}
