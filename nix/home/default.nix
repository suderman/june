# June's Home Manager module, homeModules.default: the june client everywhere it is enabled, and on chosen hosts her
# daemon (daemon.nix) and the Org dispatcher (org.nix). It needs only Home Manager and nixpkgs; secrets, persistence, and
# the agents she drives are the host's configuration.
self: {
  config,
  lib,
  pkgs,
  ...
}: let
  cfg = config.programs.june;
  june = self.packages.${pkgs.stdenv.hostPlatform.system}.default;

  # The client finds the daemon's host here; a shell can still override it.
  daemonHostLine = lib.optionalString (cfg.daemonHost != null) "export JUNE_DAEMON_HOST=\"\${JUNE_DAEMON_HOST:-${cfg.daemonHost}}\"";
  # Run a writable checkout when one is installed, so code changes need only a restart; otherwise run the pinned
  # package. A host without the checkout, or JUNE_SOURCE=none, runs the package.
  wrapper = pkgs.writeShellApplication {
    name = "june";
    runtimeInputs = [pkgs.coreutils pkgs.ripgrep pkgs.openssh pkgs.wl-clipboard];
    text = ''
      ${daemonHostLine}
      source="''${JUNE_SOURCE:-${lib.optionalString (cfg.source != null) cfg.source}}"
      if [[ -n $source && -f $source/src/cli.ts && -d $source/node_modules ]]; then
        exec ${pkgs.nodejs_22}/bin/node --disable-warning=ExperimentalWarning "$source/src/cli.ts" "$@"
      fi
      exec ${june}/bin/june "$@"
    '';
  };
in {
  imports = [./daemon.nix (import ./org.nix self)];

  options.programs.june = {
    enable = lib.mkEnableOption "the june client";
    daemon.enable = lib.mkEnableOption "June's daemon on this host";
    dispatch.enable = lib.mkEnableOption "the Org dispatcher, which runs AUTO headings for this host";
    package = lib.mkOption {
      type = lib.types.package;
      default = wrapper;
      readOnly = true;
      internal = true;
      description = "The june command, which the daemon's service also runs.";
    };
    source = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "/home/alex/src/june";
      description = "A checkout of June that runs instead of the pinned package whenever it is installed (src/cli.ts and node_modules present). Null always runs the package.";
    };
    daemonHost = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "The host that runs June's daemon; june on any other host reaches it over SSH.";
    };
    dataDir = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "/home/alex/org/june";
      description = "Where June's SOUL.org, MEMORY.org, and JOURNAL.org really live; ~/.local/share/june links there. Null keeps them in ~/.local/share/june itself.";
    };
    environmentFiles = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [];
      example = ["-/home/alex/.pi/agent/.env" "/run/user/1000/agenix/june-env"];
      description = "KEY=value files for the daemon, such as provider keys and TELEGRAM_BOT_TOKEN, as systemd EnvironmentFile entries; later files win, and a leading - makes one optional.";
    };
    telegram.allowedUsers = lib.mkOption {
      type = lib.types.listOf lib.types.int;
      default = [];
      description = "Telegram user ids allowed to talk to June; empty leaves Telegram off unless an environment file sets TELEGRAM_ALLOWED_USERS.";
    };
    herdrPackage = lib.mkOption {
      type = lib.types.nullOr lib.types.package;
      default = lib.attrByPath ["programs" "herdr" "package"] null config;
      defaultText = lib.literalExpression "config.programs.herdr.package, when that option exists";
      description = "Herdr, which the dispatcher and herdr-link drive.";
    };
    emacsPackage = lib.mkOption {
      type = lib.types.package;
      default =
        if config.programs.emacs.enable
        then config.programs.emacs.finalPackage
        else pkgs.emacs-nox;
      defaultText = lib.literalExpression "config.programs.emacs.finalPackage when programs.emacs is enabled, else pkgs.emacs-nox";
      description = "The Emacs whose Org the dispatcher and org-edit run in batch.";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = cfg.herdrPackage != null;
        message = "programs.june needs Herdr: set programs.june.herdrPackage";
      }
    ];

    home.packages = [wrapper];

    # config.json and AGENTS.md are the user's to place in ~/.config/june; her own files are data.
    xdg.dataFile.june = lib.mkIf (cfg.dataDir != null) {
      source = config.lib.file.mkOutOfStoreSymlink cfg.dataDir;
    };
  };
}
