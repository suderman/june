# programs.june.daemon.enable: June's daemon as a systemd user service, and with telegram.enable the Telegram bridge
# beside it. State lives in ~/.local/state/june and her own files in ~/.local/share/june; keep both out of file sync,
# which would copy a live SQLite WAL.
{
  config,
  lib,
  ...
}: let
  cfg = config.programs.june;
  allowedUsers = lib.optional (cfg.telegram.allowedUsers != []) "TELEGRAM_ALLOWED_USERS=${lib.concatMapStringsSep "," toString cfg.telegram.allowedUsers}";
in {
  config = lib.mkIf (cfg.enable && cfg.daemon.enable) {
    systemd.user.services.june = {
      Unit = {
        Description = "June personal assistant";
        Wants = ["network-online.target"];
        After = ["network-online.target"];
        StartLimitIntervalSec = 300;
        StartLimitBurst = 5;
      };
      Service = {
        Type = "simple";
        ExecStart = "${lib.getExe cfg.package} serve";
        EnvironmentFile = cfg.environmentFiles;
        # Herdr, org-dispatch, Emacs, and ssh come from the profile and system.
        Environment =
          ["PATH=${config.home.profileDirectory}/bin:/run/current-system/sw/bin"]
          ++ allowedUsers;
        Restart = "on-failure";
        RestartSec = 5;
        # SIGTERM closes the harness; unfinished work resumes on the next start.
        TimeoutStopSec = 30;
        UMask = "0077";
        NoNewPrivileges = true;
        # No PrivateTmp or ProtectSystem: in a user unit they add a user namespace in which
        # store-owned files look owned by nobody, and ssh then refuses ~/.ssh/config.
      };
      Install.WantedBy = ["default.target"];
    };

    # A client on the socket: it outlives a daemon restart and reconnects, and its own restart never touches the daemon.
    systemd.user.services.june-telegram = lib.mkIf cfg.telegram.enable {
      Unit = {
        Description = "June's Telegram bridge";
        Wants = ["network-online.target"];
        After = ["network-online.target" "june.service"];
        StartLimitIntervalSec = 300;
        StartLimitBurst = 5;
      };
      Service = {
        Type = "simple";
        ExecStart = "${lib.getExe cfg.package} telegram";
        EnvironmentFile = cfg.environmentFiles;
        Environment = allowedUsers;
        Restart = "on-failure";
        RestartSec = 10;
        # Exit 2 is missing configuration, which a restart cannot fix.
        RestartPreventExitStatus = 2;
        TimeoutStopSec = 20;
        UMask = "0077";
        NoNewPrivileges = true;
      };
      Install.WantedBy = ["default.target"];
    };
  };
}
