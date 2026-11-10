# june-art: finish approved generated images into an avatar set kept outside the repository (art/june-art.mjs). It
# checks each manifest with the daemon's own rules (src/avatar.ts) and frames contact sheets as the desktop client does
# (desktop/compose.mjs), so it ships those two files beside its own.
{
  lib,
  writeShellApplication,
  nodejs_22,
  imagemagick,
  realesrgan-ncnn-vulkan,
  dejavu_fonts,
}: let
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [../art ../src/avatar.ts ../desktop/compose.mjs];
  };
in
  writeShellApplication {
    name = "june-art";
    runtimeInputs = [nodejs_22 imagemagick realesrgan-ncnn-vulkan];
    text = ''
      export JUNE_ART_FONT=${dejavu_fonts}/share/fonts/truetype/DejaVuSans.ttf
      exec node --disable-warning=ExperimentalWarning ${src}/art/june-art.mjs "$@"
    '';
    meta.description = "Finish generated art into June's avatar set";
  }
