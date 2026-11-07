---
name: org-conflicts
description: >
  Resolves Syncthing conflict copies (NAME.sync-conflict-YYYYMMDD-HHMMSS-DEVICE.EXT)
  in Jon's ~/org tree: deletes the ones that add nothing, merges what an Org copy
  alone holds into the live file, then deletes the copy. Use whenever a
  *.sync-conflict-* file sits beside a file you are about to read or edit, when
  a tool or command refuses a write because of one, or when asked to clean up
  sync conflicts.
---

# Org conflicts

~/org syncs between kit, cog, and Jon's phone. When two of them change a file
before syncing, Syncthing keeps one version as the live file and renames the
other to a conflict copy beside it. Most copies add nothing; a few hold edits
the live file lacks. Resolve them yourself, confidently, and keep going. Jon
keeps backups outside ~/org, so deleting a copy after this check is fine. Do
not stop to ask him about routine copies.

The `org-conflict` command beside this file does the mechanical part. Run it
by its path, `~/.agents/skills/org-conflicts/org-conflict`, or from this
skill's directory.

```sh
org-conflict list [ROOT]    # every copy under ROOT (default ~/org) with its status
org-conflict check COPY     # one copy's status and the lines only it has
org-conflict retire COPY    # delete the copy
org-conflict sweep [ROOT]   # retire every identical, junk, and contained copy
```

## Statuses

- `identical`, `junk` (an editor lock or temporary file), `contained` (an Org
  copy whose every line is already in the live file): retire it.
- `diverged`: an Org copy with lines the live file lacks. Reconcile, below.
- `orphan`: an Org copy whose live file is gone. See "Orphans".
- `other`: a different file that is not Org, such as media or an exported
  site. Leave it; mention it to Jon only when it is in your way.

## Reconcile a diverged copy

1. Run `org-conflict check COPY`. It lists each line only the copy has, with
   its line number in the copy. Read those places in both files, with
   `diff -u LIVE COPY` for context. The timestamp in the copy's name is when
   Syncthing found the conflict; the copy is the other host's edit, not
   necessarily the older one.
2. Sort each copy-only line:
   - Stale: an earlier form of something the live file has since changed, such
     as an older TODO state, the unchecked version of a checked item, an
     earlier wording, or an old property value. Drop it.
   - Unique: material the live file lacks, such as a heading, a checklist item,
     a Dialog entry, a note, a verification line, or a later state or date.
     Keep it.
3. Merge each unique piece into the live file at the same place in its
   heading, by reading and then editing, so a change made meanwhile makes the
   edit fail instead of being lost. Keep the live file's own newer material.
   Follow the Org writing rules: one line per paragraph or list item, Dialog
   last, append-only.
4. When both sides changed the same item differently and neither is clearly
   later, keep both versions next to each other and say so in your report.
   Never block on it.
5. Run `org-conflict check COPY` again. Every line still listed should be one
   you judged stale. Then `org-conflict retire COPY`.
6. Apply a later TODO state, SCHEDULED, or DEADLINE from the copy only now,
   through `org-edit` or June's Org tools, never by editing the keyword. Some
   writers refuse to touch a file while a copy sits beside it, which is why
   this comes after retiring.

With several copies of one file, work from the oldest name to the newest.
Re-read the live file between them.

## Orphans

The live file was deleted or renamed on another host. Look for the copy's
headings with `rg` under ~/org, archives included. If they now live elsewhere,
reconcile against that file as above and retire the copy. If they were archived
or deliberately removed, retire it. If the copy is the only record of real
work, move it to the live name and say so in your report.

## Report

Say what you did in one or two lines: copies retired, material merged into
which headings, and any pair you kept side by side. Never put a copy's
contents in a log or a commit.
