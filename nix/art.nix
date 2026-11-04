# june-art: finish approved generated images into an avatar set kept outside the repository (art/june-art.mjs). It
# checks each manifest with the daemon's own rules (src/avatar.ts) and frames contact sheets as the overlay does
# (overlay/compose.mjs), so it ships those two files beside its own.
{
  lib,
  writeShellApplication,
  nodejs_22,
  imagemagick,
  realesrgan-ncnn-vulkan,
}: let
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [../art ../src/avatar.ts ../overlay/compose.mjs];
  };
in
  writeShellApplication {
    name = "june-art";
    runtimeInputs = [nodejs_22 imagemagick realesrgan-ncnn-vulkan];
    text = ''exec node --disable-warning=ExperimentalWarning ${src}/art/june-art.mjs "$@"'';
    meta.description = "Finish generated art into June's avatar set";
  }
