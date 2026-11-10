#!/usr/bin/env bash
# Pictures and files the user attaches on the desktop, read for the desktop client (attach.mjs), which QML cannot do itself.
#
#   attach.sh read PATH...  each path as one line (below)
#   attach.sh paste         the clipboard: a picture (a screenshot) as one line, or files copied in a file manager as
#                           `read` prints them; exits 1 when it holds neither, so the composer pastes words instead
#
# Lines: `picture\tNAME\timage/jpeg\tSIZE\tBASE64` (shrunk to at most 2000 px, the most the model sees), `file\tNAME\t
# TYPE\tSIZE\tBASE64`, `big\tNAME\tTYPE\tSIZE` for a file over 20 MiB, `gone\tPATH` for one not there.
set -uo pipefail

max_file=$((20 * 1024 * 1024))

shrink() { magick "$1" -auto-orient -resize '2000x2000>' -quality 88 jpg:- 2>/dev/null | base64 -w0; }

read_paths() {
	local f name mime size data
	for f; do
		if [[ ! -f $f ]]; then printf 'gone\t%s\n' "$f"; continue; fi
		name=$(basename -- "$f")
		mime=$(file -b --mime-type -- "$f")
		size=$(stat -c %s -- "$f")
		case $mime in
		image/png | image/jpeg | image/webp | image/gif | image/bmp | image/heic | image/heif | image/avif | image/tiff)
			data=$(shrink "${f}[0]")
			if [[ -n $data ]]; then
				printf 'picture\t%s\timage/jpeg\t%s\t%s\n' "${name%.*}.jpg" "$size" "$data"
				continue
			fi
			;;
		esac
		if ((size > max_file)); then printf 'big\t%s\t%s\t%s\n' "$name" "$mime" "$size"; continue; fi
		printf 'file\t%s\t%s\t%s\t' "$name" "$mime" "$size"
		base64 -w0 -- "$f"
		printf '\n'
	done
}

paste() {
	local types t data uri p
	types=$'\n'$(wl-paste --list-types 2>/dev/null)$'\n' || exit 1
	for t in image/png image/jpeg image/webp image/gif image/bmp; do
		if [[ $types == *$'\n'$t$'\n'* ]]; then
			data=$(wl-paste --no-newline --type "$t" | shrink -)
			if [[ -n $data ]]; then
				printf 'picture\tscreenshot.jpg\timage/jpeg\t0\t%s\n' "$data"
				exit 0
			fi
		fi
	done
	if [[ $types == *$'\n'text/uri-list$'\n'* ]]; then
		local paths=()
		while IFS= read -r uri; do
			uri=${uri%$'\r'}
			[[ $uri == file://* ]] || continue
			p=${uri#file://}
			p=${p#localhost}
			paths+=("$(printf '%b' "${p//%/\\x}")")
		done < <(wl-paste --no-newline --type text/uri-list)
		if ((${#paths[@]} > 0)); then
			read_paths "${paths[@]}"
			exit 0
		fi
	fi
	exit 1
}

case ${1:-} in
read) shift; read_paths "$@" ;;
paste) paste ;;
*) echo "usage: attach.sh read PATH... | attach.sh paste" >&2; exit 2 ;;
esac
