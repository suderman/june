{lib, fetchurl, linkFarm}: let
  version = "2026e";
  rev = "bae5ca647fa41703393dbf00240ec1b807a9c353";
  hashes = {
    "metaZones.res" = "sha256-W0hMfwLJnVFkIIzoThj7pnxjFNd89gUD4rGfcItmxto=";
    "timezoneTypes.res" = "sha256-XnfOWvtzdKNsvjvhl9Cm3qqRnm9nLCo3L3qdkbf4U08=";
    "windowsZones.res" = "sha256-uMOnrblP1ln4ID7kr03HKk5rFFZrqsGFXEkwlvM3GEs=";
    "zoneinfo64.res" = "sha256-WhaPt4zM/IcvmlDpH6zwv4tyBKbE+S/lxkqBZenmJEg=";
  };
in
  # ICU's supported drop-in data for ICU 44+, little endian (both June targets).
  # https://unicode-org.github.io/icu/userguide/datetime/timezone/#icu4c-tz-update-with-drop-in-res-files-icu-54-and-newer
  linkFarm "icu-tzdata-${version}" (lib.mapAttrsToList (name: hash: {
      inherit name;
      path = fetchurl {
        inherit name hash;
        url = "https://raw.githubusercontent.com/unicode-org/icu-data/${rev}/tzdata/icunew/${version}/44/le/${name}";
      };
    })
    hashes)
