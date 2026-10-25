# Home Manager module. Every host gets the `june` client; the host that runs June also enables the daemon.
self: {
  config,
  lib,
  options,
  pkgs,
  ...
}: let
  cfg = config.services.june;
  json = pkgs.formats.json {};
in {
  options.services.june = {
    enable = lib.mkEnableOption "the june command";
    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
    };
    settings = lib.mkOption {
      type = json.type;
      default = {};
      description = "Written to $XDG_CONFIG_HOME/june/config.json. See the README for keys.";
    };
    daemon = {
      enable = lib.mkEnableOption "the June daemon as a user service on this host";
      environmentFiles = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [];
        example = ["%h/.pi/agent/.env" "/run/agenix/june-telegram"];
        description = "systemd EnvironmentFile entries holding provider keys and the Telegram token.";
      };
    };
  };

  config = lib.mkIf cfg.enable (lib.mkMerge [
    {
      home.packages = [cfg.package];
      xdg.configFile."june/config.json" = lib.mkIf (cfg.settings != {}) {
        source = json.generate "june-config.json" cfg.settings;
      };
    }
    (lib.mkIf cfg.daemon.enable {
      systemd.user.services.june = {
        Unit = {
          Description = "June personal assistant";
          After = ["network-online.target"];
          Wants = ["network-online.target"];
          StartLimitIntervalSec = 300;
          StartLimitBurst = 5;
        };
        Service = {
          Type = "simple";
          ExecStart = "${lib.getExe cfg.package} serve";
          EnvironmentFile = map (file: "-${file}") cfg.daemon.environmentFiles;
          # Herdr, org-dispatch, and Emacs come from the user's profile.
          Environment = [
            "PATH=${config.home.profileDirectory}/bin:/run/current-system/sw/bin"
            "SSH_AUTH_SOCK=%t/ssh-agent"
          ];
          Restart = "on-failure";
          RestartSec = 5;
          # SIGTERM closes the channel and the harness; unfinished work resumes on the next start.
          TimeoutStopSec = 30;
          UMask = "0077";
          NoNewPrivileges = true;
          # No PrivateTmp or ProtectSystem: in a user unit they add a user namespace in which root-owned store files
          # look owned by nobody, and ssh then refuses ~/.ssh/config (a store symlink), so remote Herdr breaks.
        };
        Install.WantedBy = ["default.target"];
      };
    })
    (lib.optionalAttrs (options ? persist) (lib.mkIf cfg.daemon.enable {
      persist.storage.directories = [
        {
          directory = ".local/state/june";
          mode = "0700";
        }
      ];
    }))
  ]);
}
