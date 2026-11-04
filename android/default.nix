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
      # The standard Android debug key, so reinstalls keep one signature.
      key="$HOME/.android/debug.keystore"
      if [ ! -f "$key" ]; then
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
    '';
  };
in
  apk // {inherit install sdk;}
