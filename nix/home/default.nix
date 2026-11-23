# June's Home Manager module, homeModules.default: the june client everywhere it is enabled, and on chosen hosts her
# daemon (daemon.nix), the Org dispatcher (org.nix), and the desktop client (desktop.nix). It needs only Home Manager and nixpkgs; secrets, persistence, and
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
    runtimeInputs = [pkgs.coreutils pkgs.ripgrep pkgs.openssh pkgs.wl-clipboard pkgs.poppler-utils pkgs.libsecret];
    text = ''
      ${daemonHostLine}
      export ICU_TIMEZONE_FILES_DIR=${june.timezoneData}
      source="''${JUNE_SOURCE:-${lib.optionalString (cfg.source != null) cfg.source}}"
      if [[ -n $source && -f $source/src/cli.ts && -d $source/node_modules ]]; then
        exec ${pkgs.nodejs_22}/bin/node --disable-warning=ExperimentalWarning "$source/src/cli.ts" "$@"
      fi
      exec ${june}/bin/june "$@"
    '';
  };
in {
  imports = [./daemon.nix (import ./org.nix self) (import ./desktop.nix self)];

  options.programs.june = {
    enable = lib.mkEnableOption "the june client";
    daemon.enable = lib.mkEnableOption "June's daemon on this host";
    dispatch.enable = lib.mkEnableOption "the Org dispatcher, which runs AUTO headings for this host";
    orgWork = {
      enable = lib.mkEnableOption "the weekly tidy of this host's ~/.local/state/org-work runtime folders (june org-work --clean), on each host where agents work, as each runs its own dispatcher";
      keep = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [];
        example = ["%h/org/june/avatar"];
        description = "Files or directories whose mentions of an org-work folder keep it, such as art provenance notes. systemd specifiers (%h, %H) expand.";
      };
      record = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        example = "%h/org/work/suderman/june/org-work-cleanup/%H.org";
        description = "An Org file each run adds what it removed to; give each host its own, such as with %H, so synced copies never conflict. Null keeps no record.";
      };
      afterDays = lib.mkOption {
        type = lib.types.ints.positive;
        default = 14;
        description = "How long a folder's threads must have been DONE or archived before it goes.";
      };
      calendar = lib.mkOption {
        type = lib.types.str;
        default = "Sun 03:30";
        description = "When the weekly tidy runs, as systemd's OnCalendar.";
      };
    };
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
      description = "A checkout of June used instead of the pinned package: src/cli.ts and node_modules for the daemon/client, desktop/shell.qml for the desktop. Null uses the package unless JUNE_SOURCE overrides it.";
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
      description = "Telegram user ids allowed to talk to June; the first one's private chat is the one the bridge serves. Empty leaves it to TELEGRAM_ALLOWED_USERS in an environment file.";
    };
    telegram.enable = lib.mkOption {
      type = lib.types.bool;
      default = cfg.telegram.allowedUsers != [];
      defaultText = lib.literalExpression "config.programs.june.telegram.allowedUsers != []";
      description = "Run june telegram, the Telegram bridge, as a user service beside the daemon. It needs TELEGRAM_BOT_TOKEN in an environment file, and allowed users from telegram.allowedUsers or TELEGRAM_ALLOWED_USERS; set this when those come only from an environment file.";
    };
    remote.enable = lib.mkEnableOption "the daemon's WebSocket listener for graphical clients, on 127.0.0.1 only; put a reverse proxy such as Traefik in front of it, and add devices with june device add";
    remote.port = lib.mkOption {
      type = lib.types.port;
      default = 7347;
      description = "The loopback port of the WebSocket listener.";
    };
    hcPackage = lib.mkOption {
      type = lib.types.nullOr lib.types.package;
      default = lib.attrByPath ["services" "herdr" "package"] null config;
      defaultText = lib.literalExpression "config.services.herdr.package, when that option exists";
      description = "herdr-core, whose hc command the dispatcher, org-edit, herdr-link and herdr-notify drive.";
    };
    notify = {
      url = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        example = "https://ntfy.sh/my-agents";
        description = "ntfy topic URL for agent notices. The dispatcher posts task-level HOLD and finish notices here; null sends none.";
      };
      tokenFile = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "File holding an ntfy access token, read at each notice. Keep it out of the Nix store.";
      };
      watch = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = "Run herdr-notify watch here, which follows hc events and tells of agents that block or end a turn. Enable it on exactly one host, the one whose hc core has the other machines added, so each event is told once.";
      };
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
        assertion = cfg.hcPackage != null;
        message = "programs.june needs herdr-core: set programs.june.hcPackage";
      }
      {
        assertion = !cfg.notify.watch || cfg.notify.url != null;
        message = "programs.june.notify.watch needs programs.june.notify.url";
      }
    ];

    home.packages = [wrapper];

    # config.json and AGENTS.md are the user's to place in ~/.config/june; her own files are data.
    xdg.dataFile.june = lib.mkIf (cfg.dataDir != null) {
      source = config.lib.file.mkOutOfStoreSymlink cfg.dataDir;
    };

    # `june accounts apply` writes a wrapper per numbered login (claude1, codex2, ...) under ~/.local/state/june/bin and
    # links it into ~/.local/bin, and one per harness name (claude, codex, ...) that picks an account, linked into ~/bin,
    # which comes first on PATH. Restore those links here, since home directories may not survive a reboot; a name
    # something else already holds is left alone. Persisting ~/.local/state/june is the host's job.
    home.activation.juneAccounts = lib.hm.dag.entryAfter ["linkGeneration"] ''
      bin="$HOME/.local/state/june/bin"
      if [[ -d $bin ]]; then
        run mkdir -p "$HOME/.local/bin" "$HOME/bin"
        for wrapper in "$bin"/*; do
          [[ -f $wrapper && $wrapper != *.tmp ]] || continue
          name=''${wrapper##*/}
          if [[ $name == *[0-9] ]]; then link="$HOME/.local/bin/$name"; else link="$HOME/bin/$name"; fi
          if [[ ! -e $link && ! -L $link ]]; then
            run ln -s "$wrapper" "$link"
          fi
        done
      fi
    '';
  };
}
