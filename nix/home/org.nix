# The Org agent system: org-edit and herdr-link wherever June is enabled, and with programs.june.dispatch.enable the
# dispatcher every minute. All of it, prompts and skills too, comes from the same June commit as the package.
self: {
  config,
  lib,
  pkgs,
  ...
}: let
  cfg = config.programs.june;
  org = "${self}/org";
  tzdir = "${pkgs.tzdata}/share/zoneinfo";

  orgDispatch = pkgs.writeShellApplication {
    name = "org-dispatch";
    runtimeInputs = [pkgs.coreutils cfg.emacsPackage pkgs.git pkgs.util-linux] ++ lib.optional (cfg.herdrPackage != null) cfg.herdrPackage;
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
    runtimeInputs = [pkgs.coreutils cfg.emacsPackage];
    runtimeEnv = {
      TZDIR = tzdir;
      ORG_EDIT_EL = "${org}/edit/org-edit.el";
      ORG_DISPATCH_EL = "${org}/dispatch/org-dispatch.el";
    };
    text = builtins.readFile "${org}/edit/org-edit";
  };

  # Org links to agent sessions; jump expects Hyprland and kitty on the desktop.
  herdrLink = pkgs.writeShellApplication {
    name = "herdr-link";
    runtimeInputs = with pkgs; [coreutils jq openssh procps gawk gnugrep gnused util-linux] ++ lib.optional (cfg.herdrPackage != null) cfg.herdrPackage;
    text = builtins.readFile "${org}/bin/herdr-link";
  };
in {
  config = lib.mkIf cfg.enable {
    # Agents call org-edit, herdr-link, and org-dispatch finish, so they must be on PATH in Herdr panes.
    home.packages = [orgEdit herdrLink] ++ lib.optional cfg.dispatch.enable orgDispatch;

    # The pinned project-org-tasks and org-triage, for agents to link into their skills.
    xdg.configFile."june/skills".source = "${self}/skills";

    systemd.user.services.org-dispatch = lib.mkIf cfg.dispatch.enable {
      Unit.Description = "Dispatch autonomous Org tasks to pi in Herdr";
      Service = {
        Type = "oneshot";
        ExecStart = "${lib.getExe orgDispatch} run";
      };
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
