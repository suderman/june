# June's Android assistant, built with Gradle and the Android Gradle Plugin. Maven dependencies come from deps.json,
# recorded by `gradle.fetchDeps`: regenerate it after changing a dependency with
#   $(nix build .#android.mitmCache.updateScript --print-out-paths)
# The APK is unsigned; the install app signs it with the local debug key and installs it over adb.
{
  lib,
  stdenv,
  androidenv,
  gradle_9,
  jdk17_headless,
  esbuild,
  runCommand,
  imagemagick,
  google-fonts,
  writeShellApplication,
  android-tools,
}: let
  platform = "37.0";
  buildTools = "37.0.0";
  sdk = androidenv.composeAndroidPackages {
    platformVersions = [platform];
    buildToolsVersions = [buildTools];
    includeEmulator = false;
    includeSystemImages = false;
  };
  home = "${sdk.androidsdk}/libexec/android-sdk";
  tools = "${home}/build-tools/${buildTools}";
  jdk = "${jdk17_headless}/lib/openjdk";

  # The overlay's decision modules as one script for QuickJS (js/june.mjs), so the phone decides as the desktop does.
  decisions = let
    src = lib.fileset.toSource {
      root = ../.;
      fileset = lib.fileset.unions [./js (lib.fileset.fileFilter (file: file.hasExt "mjs") ../overlay)];
    };
  in
    runCommand "june-decisions.js" {nativeBuildInputs = [esbuild];} ''
      esbuild ${src}/android/js/june.mjs --bundle --format=iife --global-name=June --target=es2020 --log-level=warning --outfile=$out
    '';

  # The base avatar set the app ships, so June has a face before the daemon's set loads. Android cannot draw the
  # SVG placeholders, so they become lossless WebP and the manifest names those.
  avatar = runCommand "june-avatar-base" {nativeBuildInputs = [imagemagick];} ''
    cp -r ${../templates/avatar} $out
    chmod -R u+w $out
    find $out -name '*.svg' | while read -r f; do
      magick -background none "$f" -define webp:lossless=true "''${f%.svg}.webp"
      rm "$f"
    done
    sed -i 's/\.svg"/.webp"/g' $out/manifest.json
  '';

  # The strip's lettering, display, and caption faces, as the overlay uses them.
  fonts = "${google-fonts.override {fonts = ["ShantellSans" "DelaGothicOne" "ZenKakuGothicNew"];}}/share/fonts/truetype";

  apk = stdenv.mkDerivation (finalAttrs: {
    pname = "june-android";
    version = "0.1";
    src = lib.fileset.toSource {
      root = ./.;
      fileset = lib.fileset.unions [./settings.gradle.kts ./build.gradle.kts ./gradle.properties ./src];
    };
    nativeBuildInputs = [gradle_9 jdk17_headless];

    mitmCache = gradle_9.fetchDeps {
      pkg = finalAttrs.finalPackage;
      data = ./deps.json;
    };

    env = {
      ANDROID_HOME = home;
      JAVA_HOME = jdk;
    };
    # The aapt2 that AGP downloads is a generic Linux binary that does not run on NixOS; the SDK's is patched.
    gradleFlags = [
      "-Pandroid.aapt2FromMavenOverride=${tools}/aapt2"
      "-Dorg.gradle.java.home=${jdk}"
    ];
    gradleBuildTask = "assembleRelease";
    # Record dependencies by building: the default task resolves every configuration, which AGP's do not allow.
    gradleUpdateTask = finalAttrs.gradleBuildTask;
    # AGP keeps its own state in ~/.android, which the sandbox lacks.
    preBuild = ''
      export ANDROID_USER_HOME="$TMPDIR/android-user"
      install -Dm644 ${decisions} src/main/assets/june.js
      mkdir -p src/main/assets && cp -r ${avatar} src/main/assets/avatar && chmod -R u+w src/main/assets/avatar
      install -Dm644 "${fonts}/ShantellSans[BNCE,INFM,SPAC,wght].ttf" src/main/res/font/shantell_sans.ttf
      install -Dm644 ${fonts}/DelaGothicOne-Regular.ttf src/main/res/font/dela_gothic_one.ttf
      install -Dm644 ${fonts}/ZenKakuGothicNew-Medium.ttf src/main/res/font/zen_kaku_gothic_new_medium.ttf
      install -Dm644 ${fonts}/ZenKakuGothicNew-Bold.ttf src/main/res/font/zen_kaku_gothic_new_bold.ttf
    '';

    installPhase = ''
      runHook preInstall
      install -Dm644 build/outputs/apk/release/june-release-unsigned.apk $out/june.apk
      runHook postInstall
    '';
  });

  install = writeShellApplication {
    name = "june-android-install";
    runtimeInputs = [jdk17_headless android-tools];
    text = ''
      # The standard Android debug key, so reinstalls keep one signature. Every host that installs the app must hold
      # the same one (Jon's NixOS config persists ~/.android): an app signed with another key cannot be updated, only
      # uninstalled, which clears its device token and assistant role. So a missing key is an error, not a new key.
      key="$HOME/.android/debug.keystore"
      if [ ! -f "$key" ]; then
        if [ "''${JUNE_ANDROID_NEW_KEY:-}" != 1 ]; then
          echo "No signing key at $key. Copy it from the host that installed June last (scp HOST:.android/debug.keystore ~/.android/)." >&2
          echo "Only for a first install, or after uninstalling the app, rerun with JUNE_ANDROID_NEW_KEY=1 to create one." >&2
          exit 1
        fi
        mkdir -p "$HOME/.android"
        keytool -genkeypair -keystore "$key" -storepass android -keypass android -alias androiddebugkey \
          -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Android Debug,O=Android,C=US"
      fi
      out="$(mktemp -d)"
      trap 'rm -rf "$out"' EXIT
      ${tools}/apksigner sign --ks "$key" --ks-pass pass:android --key-pass pass:android \
        --out "$out/june.apk" ${apk}/june.apk
      adb install -r "$@" "$out/june.apk"
      # GrapheneOS makes network access a permission an ADB install leaves off; elsewhere it cannot be changed.
      adb shell pm grant net.suderman.june android.permission.INTERNET 2>/dev/null || true
      # June's hands (Hands.kt), on by Jon's choice: added to the enabled accessibility services if missing. Settings
      # would refuse it for an app from outside a store (restricted settings); the shell may set it.
      hands="net.suderman.june/net.suderman.june.Hands"
      enabled=$(adb shell settings get secure enabled_accessibility_services | tr -d '\r')
      case ":$enabled:" in
        *":$hands:"* | *":net.suderman.june/.Hands:"*) ;;
        *)
          if [ -z "$enabled" ] || [ "$enabled" = null ]; then enabled="$hands"; else enabled="$enabled:$hands"; fi
          adb shell settings put secure enabled_accessibility_services "$enabled"
          adb shell settings put secure accessibility_enabled 1
          ;;
      esac
      # The under-display fingerprint sensor, as SystemUI reports it (udfpsBounds=Rect(441, 1666 - 639, 1864)), so June's
      # lock-screen prompt can show where to touch; an app cannot ask Android for it.
      bounds=$(adb shell dumpsys activity service SystemUI 2>/dev/null | sed -n 's/.*udfpsBounds=Rect(\([0-9]*\), \([0-9]*\) - \([0-9]*\), \([0-9]*\)).*/\1 \2 \3 \4/p' | head -n 1) || true
      if [ -n "$bounds" ]; then
        read -r left top right bottom <<< "$bounds"
        adb shell am start -n net.suderman.june/.PairActivity --es fingerprint "$(( (left + right) / 2 )),$(( (top + bottom) / 2 )),$(( (right - left) / 2 ))" > /dev/null || true
      fi
    '';
  };
in
  apk // {inherit install sdk decisions avatar;}
