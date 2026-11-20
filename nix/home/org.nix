# The Org agent system: org-edit, herdr-link and herdr-notify wherever June is enabled, with programs.june.dispatch.enable
# the dispatcher every minute, and with programs.june.notify.watch the one hc event watcher. All of it, prompts and
# skills too, comes from the same June commit as the package.
self: {
  config,
  lib,
  pkgs,
  ...
}: let
  cfg = config.programs.june;
  org = "${self}/org";
  tzdir = "${pkgs.tzdata}/share/zoneinfo";
  hc = lib.optional (cfg.hcPackage != null) cfg.hcPackage;

  # Agent notices through ntfy; without a URL it is left out, and the dispatcher sends none.
  herdrNotify = pkgs.writeShellApplication {
    name = "herdr-notify";
    runtimeInputs = with pkgs; [coreutils curl jq] ++ hc;
    runtimeEnv =
      {HERDR_NOTIFY_URL = cfg.notify.url;}
      // lib.optionalAttrs (cfg.notify.tokenFile != null) {HERDR_NOTIFY_TOKEN_FILE = cfg.notify.tokenFile;};
    text = builtins.readFile "${org}/bin/herdr-notify";
  };
  notify = lib.optional (cfg.notify.url != null) herdrNotify;

  orgDispatch = pkgs.writeShellApplication {
    name = "org-dispatch";
    runtimeInputs = [pkgs.coreutils cfg.emacsPackage pkgs.git pkgs.util-linux] ++ hc ++ notify;
    runtimeEnv = {
      TZDIR = tzdir;
      ORG_DISPATCH_EL = "${org}/dispatch/org-dispatch.el";
      ORG_DISPATCH_PROMPTS = "${org}/prompts";
    };
    text = builtins.readFile "${org}/dispatch/org-dispatch";
  };

  # Agents set TODO states and dates through Org rather than editing text.
  orgEdit = pkgs.writeShellApplication {
    name = "org-edit";
    runtimeInputs = [pkgs.coreutils cfg.emacsPackage pkgs.git pkgs.util-linux] ++ hc;
    runtimeEnv = {
      TZDIR = tzdir;
      ORG_EDIT_EL = "${org}/edit/org-edit.el";
      ORG_DISPATCH_EL = "${org}/dispatch/org-dispatch.el";
    };
    text = builtins.readFile "${org}/edit/org-edit";
  };

  # Org links to agent sessions; jump shows them in the Herdr app on a desktop, and attaches elsewhere.
  herdrLink = pkgs.writeShellApplication {
    name = "herdr-link";
    runtimeInputs = with pkgs; [coreutils jq openssh procps gawk gnugrep gnused util-linux] ++ hc;
    text = builtins.readFile "${org}/bin/herdr-link";
  };
in {
  config = lib.mkIf cfg.enable {
    # Agents call org-edit, herdr-link, and org-dispatch finish, so they must be on PATH in hc terminals.
    home.packages = [orgEdit herdrLink] ++ notify ++ lib.optional cfg.dispatch.enable orgDispatch;

    # The pinned project-org-tasks and org-triage, for agents to link into their skills.
    xdg.configFile."june/skills".source = "${self}/skills";

    systemd.user.services.org-dispatch = lib.mkIf cfg.dispatch.enable {
      Unit.Description = "Dispatch autonomous Org tasks to agents in herdr-core";
      Service = {
        Type = "oneshot";
        ExecStart = "${lib.getExe orgDispatch} run";
      };
    };

    # One consumer of hc events tells of blocked agents and ended turns, so clients need no notice logic of their own.
    systemd.user.services.herdr-notify = lib.mkIf cfg.notify.watch {
      Unit = {
        Description = "Tell of herdr-core agents that need a person or end a turn";
        StartLimitIntervalSec = 0;
      };
      Service = {
        ExecStart = "${lib.getExe herdrNotify} watch";
        Restart = "always";
        RestartSec = 10;
      };
      Install.WantedBy = ["default.target"];
    };

    systemd.user.timers.org-dispatch = lib.mkIf cfg.dispatch.enable {
      Unit.Description = "Check Org for autonomous tasks every minute";
      Timer = {
        OnCalendar = "minutely";
        Persistent = true;
      };
      Install.WantedBy = ["timers.target"];
    };
  };
}
