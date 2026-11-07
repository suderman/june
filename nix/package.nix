{
  lib,
  buildNpmPackage,
  callPackage,
  nodejs_22,
  makeWrapper,
  ripgrep,
  openssh,
  wl-clipboard,
  emacs-nox,
  git,
  jq,
  tzdata,
  qt6,
  imagemagick,
  poppler-utils,
}: let
  # Node 22: Node 24 aborts when GC collects node:sqlite objects (nodejs/node#65446), and Pi Durable uses node:sqlite.
  nodejs = nodejs_22;
  timezoneData = callPackage ./icu-timezone-data.nix {};
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [../package.json ../package-lock.json ../tsconfig.json ../bin ../src ../templates ../test ../skills];
  };
  # The tests also cover org-dispatch and org-edit, whose Emacs Lisp lives beside the daemon.
  testSrc = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [../package.json ../package-lock.json ../tsconfig.json ../bin ../src ../templates ../test ../org ../overlay ../art ../skills];
  };
in
  buildNpmPackage (finalAttrs: {
    pname = "june";
    version = (lib.importJSON ../package.json).version;
    inherit src nodejs;
    npmDepsHash = "sha256-l/mbdNsHu8ztyQ8DTduJFotrxWB+UGT49PQGkugpFZs=";
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
      cp -r package.json src templates skills node_modules $out/lib/june/
      makeWrapper ${nodejs}/bin/node $out/bin/june \
        --set ICU_TIMEZONE_FILES_DIR ${timezoneData} \
        --add-flags "--disable-warning=ExperimentalWarning $out/lib/june/src/cli.ts" \
        --suffix PATH : ${lib.makeBinPath [ripgrep openssh wl-clipboard poppler-utils]}
      runHook postInstall
    '';

    passthru.timezoneData = timezoneData;
    passthru.tests = buildNpmPackage {
      pname = "june-tests";
      inherit (finalAttrs) version npmDepsHash nodejs;
      src = testSrc;
      nativeBuildInputs = [ripgrep emacs-nox git jq imagemagick poppler-utils];
      dontNpmInstall = true;
      buildPhase = ''
        runHook preBuild
        export HOME=$TMPDIR TZDIR=${tzdata}/share/zoneinfo
        export ICU_TIMEZONE_FILES_DIR=${timezoneData}
        export JUNE_TEST_QML=${qt6.qtdeclarative}/bin/qml
        export QML2_IMPORT_PATH=${qt6.qtdeclarative}/lib/qt-6/qml:${qt6.qtwebsockets}/lib/qt-6/qml
        patchShebangs org skills
        org/tests/test-org-dispatch
        org/tests/test-org-edit
        node --test --test-concurrency=1 test/coding.test.ts test/config.test.ts test/daemon.test.ts test/dispatch.test.ts test/conflicts.test.ts test/show.test.ts test/follow.test.ts test/heartbeat.test.ts test/history.test.ts test/mail.test.ts test/memory.test.ts test/patter.test.ts test/people.test.ts test/situation.test.ts test/watch.test.ts test/write.test.ts test/tools.test.ts test/tui.test.ts test/work.test.ts test/view.test.ts test/detail.test.ts test/telegram.test.ts test/pdf.test.ts test/timezone.test.ts test/remote.test.ts test/expression.test.ts test/avatar.test.ts test/overlay.test.mjs test/links.test.mjs test/connection.test.mjs test/art.test.mjs
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
