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
    packages = forAll (pkgs: {
      default = pkgs.callPackage ./nix/package.nix {};
    });

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
