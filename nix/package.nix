{
  lib,
  buildNpmPackage,
  nodejs_22,
  makeWrapper,
  ripgrep,
  openssh,
  emacs-nox,
  git,
  jq,
  tzdata,
}: let
  # Node 22: Node 24 aborts when GC collects node:sqlite objects (nodejs/node#65446), and Pi Durable uses node:sqlite.
  nodejs = nodejs_22;
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [../package.json ../package-lock.json ../tsconfig.json ../bin ../src ../templates ../test];
  };
  # The tests also cover org-dispatch and org-edit, whose Emacs Lisp lives beside the daemon.
  testSrc = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [../package.json ../package-lock.json ../tsconfig.json ../bin ../src ../templates ../test ../org];
  };
in
  buildNpmPackage (finalAttrs: {
    pname = "june";
    version = (lib.importJSON ../package.json).version;
    inherit src nodejs;
    npmDepsHash = "sha256-QFMNhKjcj7pyZ2QDJSGs6391XksV0nzIP8hErn+dKuw=";
    nativeBuildInputs = [makeWrapper];

    # Node runs the TypeScript sources directly; typecheck instead of building.
    buildPhase = ''
      runHook preBuild
      node_modules/.bin/tsc --noEmit -p .
      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall
      npm prune --omit=dev --no-save
      mkdir -p $out/lib/june $out/bin
      cp -r package.json src templates node_modules $out/lib/june/
      makeWrapper ${nodejs}/bin/node $out/bin/june \
        --add-flags "--disable-warning=ExperimentalWarning $out/lib/june/src/cli.ts" \
        --suffix PATH : ${lib.makeBinPath [ripgrep openssh]}
      runHook postInstall
    '';

    passthru.tests = buildNpmPackage {
      pname = "june-tests";
      inherit (finalAttrs) version npmDepsHash nodejs;
      src = testSrc;
      nativeBuildInputs = [ripgrep emacs-nox git jq];
      dontNpmInstall = true;
      buildPhase = ''
        runHook preBuild
        export HOME=$TMPDIR TZDIR=${tzdata}/share/zoneinfo
        patchShebangs org
        org/tests/test-org-dispatch
        org/tests/test-org-edit
        node --test --test-concurrency=1 test/coding.test.ts test/config.test.ts test/daemon.test.ts test/dispatch.test.ts test/follow.test.ts test/heartbeat.test.ts test/mail.test.ts test/memory.test.ts test/patter.test.ts test/situation.test.ts test/watch.test.ts test/write.test.ts test/tools.test.ts test/tui.test.ts test/work.test.ts
        runHook postBuild
      '';
      installPhase = "touch $out";
    };

    meta = {
      description = "June, a personal assistant on Pi Durable";
      mainProgram = "june";
      platforms = lib.platforms.linux;
    };
  })
