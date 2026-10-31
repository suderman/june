{
  description = "June, a personal assistant on Pi Durable";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = {
    self,
    nixpkgs,
  }: let
    systems = ["x86_64-linux" "aarch64-linux"];
    forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
  in {
    packages = forAll (pkgs:
      {
        default = pkgs.callPackage ./nix/package.nix {};
      }
      # The Android assistant. The SDK's build tools are x86_64 binaries, and its licence is accepted only for this build.
      // nixpkgs.lib.optionalAttrs (pkgs.stdenv.hostPlatform.system == "x86_64-linux") {
        android = let
          androidPkgs = import nixpkgs {
            system = "x86_64-linux";
            config = {
              allowUnfree = true;
              android_sdk.accept_license = true;
            };
          };
        in
          androidPkgs.callPackage ./android {};
      });

    apps.x86_64-linux.android-install = {
      type = "app";
      program = "${self.packages.x86_64-linux.android.install}/bin/june-android-install";
    };

    # programs.june for Home Manager: the client, the daemon service, and the Org dispatcher.
    homeModules.default = import ./nix/home self;

    checks = forAll (pkgs: {
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default.tests;
    });

    devShells = forAll (pkgs: {
      default = pkgs.mkShell {
        packages = [pkgs.nodejs_22 pkgs.ripgrep];
      };
    });
  };
}
