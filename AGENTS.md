# June development

Check `~/org/work/suderman/june/june.org` before substantive work, or `art.org` beside it for art work. Keep its checklist and verification current. It records active scope and work that still needs approval.

## Ship the testable result

Jon wants verified increments committed, pushed and deployed, not left waiting for a separate publication request. This permission applies to `suderman/june`, not other repositories. Run relevant checks, publish, deploy affected components, then report live verification and what Jon still needs to test.

- Kit runs the daemon from `~/src/suderman/june`. Pull with `git pull --ff-only`, check `june status --json` for busy, background and queued work, then restart `june.service` only when idle. Confirm the service is running and status reports the checkout.
- Kit and cog run the desktop client from the same checkout through `programs.june.source`. Pull on each affected host, restart `june-overlay.service`, then verify its process uses the checkout and reconnects. The managed launcher and `june-overlay` IPC/keybinds must target that same instance. Do not add a local desktop-entry shadow or a transient service override. Over SSH, set `WAYLAND_DISPLAY` to the desktop service's value before IPC checks; Quickshell otherwise searches the wrong display.
- Android has a bundled copy of shared JavaScript. When its code or shared behavior changes, build and install with `nix run .#android-install` if the phone is attached. Check focus first; do not launch or navigate away from the user's app just to verify installation. Leave charging wake enabled. Report when no phone is available.

Ordinary daemon and QML/JavaScript changes need only a pull and service restart, not a NixOS rebuild. Changes to Nix wrappers, Qt/runtime dependencies or host configuration need a June input update and activation. Get explicit approval before editing or activating `/etc/nixos`, or committing/pushing that repository. `JUNE_SOURCE=none` selects the packaged fallback.

## Safety

This repository is public. Keep personal data, credentials and generated runtime evidence outside it. Do not open or capture the user's desktop for tests; use offscreen Qt or a private compositor. Art generation, production promotion and larger batches require their own approval.
