# programs.june.daemon.enable: June's daemon as a systemd user service. State lives in ~/.local/state/june and her
# own files in ~/.local/share/june; keep both out of file sync, which would copy a live SQLite WAL.
{
  config,
  lib,
  ...
}: let
  cfg = config.programs.june;
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
          ++ lib.optional (cfg.telegram.allowedUsers != []) "TELEGRAM_ALLOWED_USERS=${lib.concatMapStringsSep "," toString cfg.telegram.allowedUsers}";
        Restart = "on-failure";
        RestartSec = 5;
        # SIGTERM closes Telegram and the harness; unfinished work resumes on the next start.
        TimeoutStopSec = 30;
        UMask = "0077";
        NoNewPrivileges = true;
        # No PrivateTmp or ProtectSystem: in a user unit they add a user namespace in which
        # store-owned files look owned by nobody, and ssh then refuses ~/.ssh/config.
      };
      Install.WantedBy = ["default.target"];
    };
  };
}
