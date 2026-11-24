# The embedded terminal's native library (see "Embedded terminal" in docs/interfaces.org): libghostty-vt, Ghostty's
# terminal emulation library (MIT), built for the phone from a pinned release, linked into June's JNI bridge
# (native/june_terminal_jni.cpp) as one libjuneterm.so. One file, because libghostty-vt's own shared library is named
# libghostty-vt.so.1, which an APK cannot carry, and leaves getauxval to a libc it does not link.
#
# libghostty-vt 1.0.1 needs Zig 0.17.0, which nixpkgs does not have yet: the release's own static build, by hash.
# Ghostty's deps/packages.nix fetches the Zig packages it needs, so the build runs offline.
{
  lib,
  stdenv,
  fetchurl,
  fetchFromGitHub,
  callPackage,
  androidenv,
  zstd,
}: let
  version = "1.0.1";
  ghostty = fetchFromGitHub {
    owner = "ghostty-org";
    repo = "ghostty";
    rev = "vt-${version}"; # 108cacb17ed8990840cd14abfce43d8ed8503ca1
    hash = "sha256-3XBFm8yq25P9eCdjLWwVwZ0tedWCN39U1FbjYD8C+w4=";
  };
  zig = stdenv.mkDerivation {
    pname = "zig-bin";
    version = "0.17.0";
    src = fetchurl {
      url = "https://ziglang.org/download/0.17.0/zig-x86_64-linux-0.17.0.tar.xz";
      hash = "sha256-HL6d+fJ+a3jRTMvKQ7ZwOkBO957xxGPekB1/CI1OICY=";
    };
    dontConfigure = true;
    dontBuild = true;
    dontFixup = true;
    # Zig finds its standard library beside its own binary.
    installPhase = ''
      mkdir -p $out/bin
      cp -r . $out/zig
      ln -s $out/zig/zig $out/bin/zig
    '';
  };
  deps = callPackage "${ghostty}/deps/packages.nix" {zig_0_17 = zig;};
  ndkVersion = "29.0.14206865";
  ndk = "${(androidenv.composeAndroidPackages {
    includeNDK = true;
    ndkVersions = [ndkVersion];
    includeEmulator = false;
    includeSystemImages = false;
  }).ndk-bundle}/libexec/android-sdk/ndk/${ndkVersion}";
in
  stdenv.mkDerivation {
    pname = "june-terminal-native";
    inherit version;
    src = ghostty;
    nativeBuildInputs = [zig zstd];
    dontConfigure = true;
    buildPhase = ''
      runHook preBuild
      export HOME=$TMPDIR ZIG_GLOBAL_CACHE_DIR=$TMPDIR/zig-global ZIG_LOCAL_CACHE_DIR=$TMPDIR/zig-local
      export ANDROID_NDK_HOME=${ndk}
      zig build --system ${deps} -Demit-lib-vt -Dlib-version-string=${version} -Dtarget=aarch64-linux-android \
        -Doptimize=ReleaseFast -Dsimd=false -Dstrip=true -p $TMPDIR/vt
      ${ndk}/toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android33-clang++ -std=c++17 -O2 -fPIC -shared -Wall \
        -I$TMPDIR/vt/include ${./native/june_terminal_jni.cpp} $TMPDIR/vt/lib/libghostty-vt.a \
        -static-libstdc++ -llog -Wl,--no-undefined -Wl,--gc-sections -s \
        -Wl,-z,max-page-size=16384 -Wl,-z,common-page-size=16384 -o libjuneterm.so
      runHook postBuild
    '';
    installPhase = ''
      install -Dm755 libjuneterm.so $out/arm64-v8a/libjuneterm.so
      install -Dm644 LICENSE $out/LICENSE.ghostty
    '';
    meta.license = lib.licenses.mit;
  }
