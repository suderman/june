# June's Android assistant, built with the SDK's own tools rather than Gradle while it has no dependencies.
# The APK is unsigned; the install app signs it with the local debug key and installs it over adb.
{
  lib,
  stdenv,
  androidenv,
  kotlin,
  jdk17_headless,
  zip,
  writeShellApplication,
  android-tools,
}: let
  platform = "36";
  buildTools = "36.1.0";
  sdk = androidenv.composeAndroidPackages {
    platformVersions = [platform];
    buildToolsVersions = [buildTools];
    includeEmulator = false;
    includeSystemImages = false;
  };
  home = "${sdk.androidsdk}/libexec/android-sdk";
  tools = "${home}/build-tools/${buildTools}";
  androidJar = "${home}/platforms/android-${platform}/android.jar";

  apk = stdenv.mkDerivation {
    pname = "june-android";
    version = "0.1";
    src = lib.fileset.toSource {
      root = ./.;
      fileset = lib.fileset.unions [./AndroidManifest.xml ./res ./src];
    };
    nativeBuildInputs = [kotlin jdk17_headless zip];

    buildPhase = ''
      runHook preBuild
      ${tools}/aapt2 compile --dir res -o res.zip
      ${tools}/aapt2 link -I ${androidJar} --manifest AndroidManifest.xml \
        --min-sdk-version 33 --target-sdk-version ${platform} -o base.apk res.zip
      kotlinc -nowarn -jvm-target 17 -no-reflect -cp ${androidJar} -d classes $(find src -name '*.kt')
      ${tools}/d8 --release --min-api 33 --lib ${androidJar} --output . \
        $(find classes -name '*.class') ${kotlin}/lib/kotlin-stdlib.jar
      zip -qj base.apk classes.dex
      ${tools}/zipalign -p -f 4 base.apk june.apk
      runHook postBuild
    '';

    installPhase = ''
      install -Dm644 june.apk $out/june.apk
    '';
  };

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
    '';
  };
in
  apk // {inherit install sdk;}
