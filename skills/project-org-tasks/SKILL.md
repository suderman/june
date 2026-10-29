---
name: project-org-tasks
description: >
  Maintains Jon's Org work record for substantive project work. Maps active
  work to a logical project at ~/org/work/<domain>/<project>/<project>.org,
  where a project may reference zero, one, or many repositories. Creates or
  resumes task threads, tracks scope, checklists, follow-ups, verification, and
  TODO state, links Herdr agent sessions, and follows the rules for autonomous
  AUTO tasks. Uses dated task directories for supplied material. Use during
  implementation, debugging, refactoring, actionable reviews, explicit project
  ideas, and other substantive work that should persist across sessions. Skip
  quick informational questions, read-only lookups, isolated commands, and
  trivial edits unless Jon asks to track them.
---

# Project Org Tasks

Keep Jon's Org project record in step with substantive work. The project file
is the canonical planning record for a logical project or workstream. It is not
a transcript, agent scratchpad, repository README, or substitute for source
control. ~/org syncs between kit, cog, and Jon's phone through Syncthing.

## Activation

Use this skill automatically for substantive work on a tracked project,
including repository work when the repository belongs to one, unless Jon opts
out. Keep it active through follow-up requests in the same thread, and
synchronize the project file before the final report.

## Layout

```text
~/org/work/<domain>/
├── northwind.org                       client file
└── portal/
    ├── portal.org                      project file
    └── 2026-09-20-update-selector/     task directory
```

- A domain groups related work. Its direct child Org files are client files;
  its direct child directories are projects, each with a same-named project
  file.
- A project is a logical workstream, not a repository. It may reference zero,
  one, or many repositories, and a repository may serve more than one project.
  A project's client does not change its path; projects are never nested under
  a client directory.
- Repositories keep their real hosting namespace, for GitHub
  `~/src/<owner>/<repository>`. Never reshape `~/src` to mirror `~/org/work`,
  or the reverse. Matching names are a convention, not an invariant.
- Repository-local `work/` directories are not part of this system. Never look
  for, create, or use them.

## Find the project file

1. Honor a project file or directory Jon names.
2. Inside `~/org/work/<domain>/<project>/`, use that project's file.
3. In a Git repository, find the project whose repository link resolves to the
   nearest Git root. If several match, pick the one that fits the request; ask
   only when it is genuinely ambiguous.
4. For `~/src/<namespace>/<repository>`, an existing
   `~/org/work/<namespace>/<repository>/<repository>.org` is a strong default.
5. With no reliable mapping, ask for the project rather than inventing one from
   repository ownership. A repository basename is only a candidate name.

Read the project file before every edit, and merge any changes made since you
last read it. Stop and ask only when concurrent edits conflict with the same
thread. If a `<project>.sync-conflict-*.org` sits beside the project file, tell
Jon before editing; another host's edits may be in it.

## Project files

Create a project file only when substantive work begins, Jon asks to capture an
idea, or the project is otherwise clearly established.

```org
#+TITLE: Portal
#+CATEGORY: portal

Client: [[file:../northwind.org][Northwind]]

Repositories:
- portal: [[file:~/src/studio/portal/][local]] | [[https://github.com/studio/portal][GitHub]]
- portalfr: [[file:~/src/studio/portalfr/][local]] | [[https://github.com/studio/portalfr][GitHub]]
```

- Link repositories with `file:~/src/...` paths to their real location. Use
  ordinary relative links within the Org tree, such as `../northwind.org`.
- Normalize the `origin` remote to `https://github.com/owner/repository`
  without `.git`. Omit the GitHub link when there is no GitHub remote; never
  invent one. Omit `Repositories` for a project without any.
- List every repository that is part of the project in one file. Never create a
  second project file for a secondary repository.
- Link a matching client file when one exists. Never create a client file as a
  side effect. Edit a client file only for work that belongs to the client
  generally, or when Jon asks.
- Always set `#+CATEGORY`: the project slug when it is clear and at most 10
  characters, otherwise a recognizable name of at most 10 characters.
- Preserve existing metadata unless it is missing or demonstrably stale.
- Every first-level heading is one task, idea, bug, feature, or continuing
  thread. Never create a catch-all heading such as "Maintain this project".
- Add new first-level headings directly after the preamble, newest first.

## Task directories and runtime files

A task may have a directory beside the project file for material that belongs
to that ask: emails, client documents, spreadsheets, screenshots, PDFs,
exports, task notes, and readable deliverables.

- Name it `YYYY-MM-DD-<slug>` with the date the task was first captured and a
  short kebab-case slug. Reuse it for the same thread.
- Create one only when there is material for it or Jon wants one.
- Never copy repository source or files that belong in Git into it, and never
  move supplied files into a repository.
- Keep project-wide material out of dated task directories.
- Do not delete or move task directories or supplied files when a task closes,
  unless Jon asks. Rename files only when it clearly helps. Preserve an
  existing property or link convention that ties a task to its directory.

Generated runtime files never go in ~/org, which syncs between hosts, or in a
repository. That covers capture payloads, replay trees, fixtures, databases,
audit scripts, logs, machine state, and manifests. Put them in:

```text
~/.local/state/org-work/<domain>/<project>/<YYYY-MM-DD-slug>/
```

This directory survives reboots and is neither synced nor in Git. Keep private
material owner-only. Link to it from the thread when useful instead of copying
it into Org. When moving existing runtime trees, verify hashes and update links;
scripts and manifests may keep their recorded paths, so review them before
another run.

### Hosts

Org syncs between hosts; `org-work` does not. kit is the desktop and home of
most work; cog is the laptop, often asleep or offline. `ssh kit` and `ssh cog`
work in either direction for an hour after Jon unlocks his SSH key.

- Name the host in every runtime reference, since a bare path opens an empty
  folder on the other machine: `[[file:~/.local/state/org-work/...][kit: <slug>]]`,
  or `kit:~/.local/state/org-work/...` in verbatim text.
- Before using a thread's runtime files, check `hostname`. If they are on the
  other host, reach them over SSH. If the key is refused, ask Jon to unlock it
  rather than working around it. Do not rebuild or copy a tree to continue elsewhere without saying in
  the thread which copy is current.
- Put scheduled or long-running work on kit unless Jon says otherwise.

### Jobs that outlive the session

Anything left running or scheduled after the session ends, such as
`systemd-run` units and timers, runtime drop-ins under `/run`, or a local Git
remote another checkout uses, goes in the thread's `** Runtime` section. List
the host, unit or path, what depends on it, and when it ends or how to remove
it. Transient units suit bounded work with an end date; Jon will not see them
in `/etc/nixos`, and `/run` changes vanish on reboot. Anything meant to recur
past the task belongs in the NixOS configuration, through Jon. Before moving
or deleting an `org-work` tree, check its threads' `Runtime` sections and
`systemctl --user list-units --all` on that host. When a task closes, remove
what has ended and leave the rest listed.

## Archives

Finished subtrees move to the `archive.org` beside their Org file, and finished
files and directories to a sibling `archive/` directory, which may hold year or
month subdirectories or yearly Org files. A nightly job on kit archives `DONE`
headings 14 days after their `CLOSED` date. The Agenda and Jon's phone app
ignore archives, but their history still matters.

- When a task refers to earlier work, decisions, or files that are not in the
  live file, search the archives before concluding the context is missing or
  asking Jon: the task file's directory first, then each parent up to `~/org`.
  Search with `rg` rather than reading whole archives.
- Say in the thread when archived context informed the work, and link to it.
- Never edit archived entries. Do not archive tasks yourself unless Jon asks.

## Working with supplied material

Treat files in a task directory as source material. Before implementing work
that depends on them, read the relevant files, starting with any summary but
not stopping there, and work out the actual request, constraints, and open
questions. Do not assume a heading, email subject, or summary captures the
whole request when originals exist. Record or report conflicts or important
ambiguity instead of silently choosing.

Never modify supplied files unless Jon asks. Do not create planning, status, or
README files to document agent activity; the task heading is the record. When a
task reveals durable knowledge, record it in the project file, the client file
when it applies across projects, or the repository's documentation.

## Task states

States describe the task from Jon's point of view:

- `TODO`: captured, not started. Jon's to do or to hand on.
- `AUTO`: queued for an unattended agent; see "Autonomous tasks".
- `PROG`: active investigation or implementation.
- `EVAL`: ready for review or acceptance by Jon or an agent he delegates.
- `HOLD`: Jon cannot act on it now, for any reason: an external dependency,
  client approval or feedback, limited bandwidth, or a deliberate pause.
  Record the reason and any known condition for resuming; never invent one.
- `DONE`: the requested work is complete and verified.

- Verification, not a commit or push, is the threshold for `DONE`. Never leave
  a thread in `PROG` only because changes are uncommitted.
- Write a new heading's keyword as text. Change an existing heading's state,
  `SCHEDULED`, or `DEADLINE` only through Org, which writes `CLOSED`, advances
  repeaters, and logs as Emacs does. Never edit those by hand:

  ```sh
  org-edit todo FILE 'Heading title' DONE
  org-edit schedule FILE 'Heading title' '2026-10-30 14:00'
  ```

  Pass the title without keyword or tags. When it is not unique, it is
  refused; pass its outline path, such as `'Parent / Title'`, or `id:UUID`. It
  prints the heading as written. In a dispatched session, use
  `org-dispatch finish` instead.
- Staging, committing, and pushing are never tasks of their own. If Jon later
  asks only for them, do not reopen the task or add a heading; record the
  commit or pull request identifiers in each affected thread. Add a
  publication checklist item to an active task only when it helps the larger
  work.

## Start or resume work

1. Resolve the project and read its file.
2. Find a matching first-level thread before creating one. Mark a new thread
   `PROG` with a concise verb-led heading, and move a matching `TODO`, `EVAL`,
   or `HOLD` thread to `PROG`.
3. Add a short `Scope` stating the outcome and important constraints.
4. Add or update a `Checklist` early, so Jon can see the real work unfold.
   Leave out routine mechanics such as reading files or editing the Org record.
5. When supplied material is involved, find or create the task directory and
   read it before making decisions.
6. Inside Herdr, link this session as described in "Herdr session links".

Write the thread by the Org rules in the global instructions: each heading
directly on its content, one physical line per paragraph or list item, and one
blank line after each finished section.

```org
* PROG Fix duplicate webhook delivery
** Scope
Prevent retries from applying the same delivery twice without changing the provider-facing response contract.

** Checklist
- [X] Reproduce the duplicate write and trace its call path.
- [ ] Add idempotency at the shared persistence boundary.
- [ ] Verify first delivery, retry, and concurrent delivery behavior.

* TODO Next thread
```

## Maintain the active thread

- Update the checklist at meaningful transitions, not after every action.
- Add `Context`, `Decisions`, `Verification`, `Runtime`, or `Outcome` sections
  only when they hold useful information. Record decisions whose rationale will matter
  later.
- Add a dated `Progress YYYY-MM-DD` section only for multi-session work,
  handoffs, or chronology that helps continuation.
- Insert new sections above `** Dialog` when the heading has one; Dialog stays
  last.
- Capture independent follow-ups as separate first-level `TODO` headings.
- Keep paths, commands, issue links, pull requests, and commit hashes that make
  the thread easier to resume. Keep failed hypotheses only when they prevent
  repetition. Never turn the file into a debugging log.
- Refer to task files instead of transcribing them. Keep clear what Jon or a
  client supplied, what you inferred, and what you verified.
- Never put credentials, tokens, private keys, or secret output in Org.
- Treat Jon's manual ideas as first-class: keep his wording where practical,
  set the right state, and grow them with scope and checklist. Preserve his
  headings and prose, and leave unrelated ideas alone.

## Multi-repository projects

Keep one thread for work spanning several repositories unless the parts are
genuinely independent. Make repository-specific steps clear in the checklist
when it matters, verify every required repository, and record each
repository's commits or pull requests when useful.

## Finish and synchronize

Before reporting completion:

1. Re-read the thread, the source state in every repository involved, and any
   supplied material that defines acceptance.
2. Check only items backed by completed work or verification, and record the
   evidence: tests, builds, manual checks.
3. Set `DONE`, `EVAL`, or `HOLD` according to the actual state.
4. Add a first-level `TODO` for independent residual work.
5. Remove stale statements such as "pending commit" once the event happens, and
   record commit or pull request identifiers after success.

Do not claim the record is synchronized until this pass is done.

## Herdr session links

When working in a Herdr pane (`HERDR_PANE_ID` is set) and `herdr-link` is
installed, link the session to the thread so Jon can follow it from Org back to
the pane, or resume it.

1. Run `herdr-link stamp`. It prints an Org link naming host, agent, session,
   and pane, labelled `agent@host/YYYY-MM-DDTHHMM`. When several sessions in
   one thread play different roles, such as a supervisor and a worker, pass a
   short role, `herdr-link stamp supervisor`, to end the label with
   `#supervisor`. Write roles as lowercase hyphenated slugs, such as
   `petrochina-worker`; the tool converts anything else the same way.
   Otherwise pass nothing.
2. Search the thread for `herdr:<host>/<agent>:<session>`. A resumed session
   keeps its ID; if it is listed, add nothing.
3. Otherwise append the link to the thread's `** Sessions` section, creating it
   when needed.

```org
** Sessions
- [[herdr:kit/claude:8419644e-636d-490b-bec0-3c28856a68a5@w2Q:pN][claude@kit/2026-10-11T0738]]
- [[herdr:cog/pi:01a1176c-3aa6-7717-a4c6-eaa0aa0a0833@w9:p1][pi@cog/2026-10-12T0910#worker]]
```

A thread may collect sessions from several hosts and agents. Keep existing
links and write a new one together with other thread updates, not as a
separate edit. Never rewrite a link to track pane moves; following it finds the
live pane. The only exception is a repeating dispatched task: `org-dispatch
finish` moves that run's links into `:LOGBOOK:` and removes the section.

## Autonomous tasks

An `AUTO` heading in one of Jon's agenda files (`org-agenda-files`) is run
unattended by `org-dispatch` on the host its property drawer names in `:HOST:`,
with the agent in `:AGENT:`. When either is missing, the dispatcher fills it in
when it claims the task, as it does `:ID:`: from one host tag (`:kit:`, `:cog:`,
`:lux:`) or agent tag (`:pi:`, `:claude:`) on the heading or in `#+FILETAGS`,
else from June's `dispatch.host` and `dispatch.agent` defaults. Two host or two
agent tags hold the task until fixed; once the drawer is set, tags are only
decoration. Only pi can be started for now. A task runs once its text has stopped changing for
`org-dispatch-settle` (headings June writes, marked `:JUNE_REQUEST:`, launch at
once); `org-dispatch scan` shows what that host would launch
now. `SCHEDULED` delays it and a repeater makes it recur. Jon adjusts a run with the
`REVIEW`, `DEPLOY`, `BRANCH`, `MODEL`, `DIR`, and `RETRY` properties. A task may sit at
any level, such as under a heading in a `~/org/life` file; its `Sessions` and
`Dialog` sections are always one level below it.

The dispatcher sets `PROG` when it launches; the agent ends at `EVAL`, `HOLD`,
or `DONE`. Jon sets `AUTO` again to resume the agent after answering in
`Dialog`, or `TODO` to take the task back. A repeating task returns to `AUTO`
through its `REPEAT_TO_STATE` property, which the dispatcher adds.

A one-off task that waits on something outside the agent's control, such as
an upstream fix, can check again later when Jon sets `:RETRY: N` on it. The
agent runs `org-dispatch retry ID WHEN NOTE`. The dispatcher then lowers
`RETRY` by one, sets `SCHEDULED`, logs the run in `:LOGBOOK:` and returns the
task to `AUTO`, and a fresh session picks it up when it is due. Once `RETRY`
reaches 0 the agent must use `HOLD`.

- Coding agents never set `AUTO` on a heading and set `:HOST:` or `:AGENT:`
  only when Jon asks: Jon grants their autonomy. June, Jon's assistant, is the one
  exception. Under her `AGENTS.md` (from `~/.agents/june`), she may queue new `AUTO` tasks, starting each one's body with a line saying she queued it and why. When Jon explicitly asks, she may also resume an existing TODO, EVAL, or HOLD task through `org_resume_task`, which uses the shared `org-edit` command and records his instruction in Dialog. `org-edit` accepting AUTO does not give coding workers permission to set it.
- In a dispatched session, follow the dispatch prompt where it differs from
  this skill, and change the TODO state only with `org-dispatch finish`.
- `** Dialog` is the conversation between agents and Jon on a task. It stays
  last in the heading and holds `- Agent [ts]:`, `- Jon [ts]:`, and
  `- Dispatcher [ts]:` and `- June [ts]:` entries with inactive timestamps. Append only; never
  edit or remove earlier entries. Read it before working on the task.
- The body of a repeating task is standing instructions. Do not add `Scope`,
  `Checklist`, or other sections to it; each run is logged in `:LOGBOOK:`.

## Asana tasks

`~/org/asana.org` mirrors Jon's open Asana tasks. A sync on kit rebuilds every
open task from Asana on each run, and marking one of its headings `DONE`
completes that task in Asana, where clients see it.

- Never edit `asana.org`. Text under an open task is lost on the next sync,
  and a state change publishes to Asana. Only Jon closes those headings.
- Track an Asana task in its project file under a first-level heading with no
  TODO keyword, tagged `:asana:`, so the Agenda lists the task once. Link the
  entry by its ID, which is `asana-` followed by its `:ASANA_ID:`:

  ```org
  * Revisions to EVF Calculator :asana:
  [[id:asana-1219507563660411][Asana task]]
  ```

- Asana owns the title, deadline, description, and state. Read the linked entry
  before working, and refer to it rather than copying it. Its `Project:` line
  helps place the heading.
- Scope, checklist, notes, sections, and task directories go under the project
  heading as for any thread. Work that needs a state goes in a child heading:
  where "Start or resume work" says to mark a thread `PROG`, mark a child
  instead. Jon may set `AUTO` on a child; a dispatched agent reads the parent
  heading and the linked entry for context.
- When the child work is verified, set its state as usual and tell Jon the
  Asana task looks ready to close.

## Restraint

Prefer a small, accurate record over ceremonial project management. Capture a
real follow-up when it will matter later, but do not manufacture tasks,
directories, client records, hierarchy, or status documents to satisfy the
structure. Editing one project file is not permission to change unrelated
project or client files. ~/org/work is not a Git repository; never run Git
operations there.
