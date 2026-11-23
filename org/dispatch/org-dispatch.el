;;; org-dispatch.el --- Run autonomous Org tasks with pi or Claude in herdr-core  -*- lexical-binding: t; -*-

;; Batch entry points:
;;   org-dispatch-run      watch running tasks, then launch eligible ones
;;   org-dispatch-scan     print the tasks this host would launch
;;   org-dispatch-reconcile --dry-run, show which workers an enabled run would retire
;;   org-dispatch-plan     SPEC.json, queue a requested plan without starting agents
;;   org-dispatch-finish   ID STATE [NOTE] [--headline LINE], used by the agent to end its task
;;   org-dispatch-retry    ID WHEN NOTE, used by the agent to try again later
;;
;; A task is an AUTO heading in Jon's Org agenda files whose HOST is this host.
;; HOST and AGENT live in its property drawer; when either is missing, one tag
;; naming a known host or agent fills it, else June's configured default, and
;; the dispatcher writes it when it claims the task, as it does ID. Once set,
;; tags are decoration. SCHEDULED delays a task; a repeater makes it recur.
;; Other settings are properties: REVIEW, DEPLOY, LIVE_CONTENT, BRANCH, MODEL, DIR, and
;; RETRY, the number of times an agent may return the task to AUTO later.
;; REVIEW is yes (Jon reviews at EVAL, the default), no, or agent: the
;; dispatcher then starts an independent exact-commit review when the worker
;; finishes at EVAL, and advances it on the reviewer's verdict (see
;; "Standing agent review"). It may come from the project file's #+PROPERTY.
;; EVAL with an ASKED stamp is a question or a problem for Jon; HOLD means the
;; task waits on something outside, and nothing is for Jon to do, except an
;; uncertain review-loop launch, which stays HOLD with ASKED.
;; DEPENDS lists id:UUID prerequisites; every one must be DONE before launch.
;; While an agent works on it, a PROG task carries the :auto: tag.

(require 'org)
(require 'org-id)
(require 'seq)
(require 'subr-x)
(require 'cl-lib)

(defun org-dispatch--env (name default)
  (let ((value (getenv name)))
    (if (and value (not (string-empty-p value))) value default)))

(defvar org-dispatch-host
  (org-dispatch--env "ORG_DISPATCH_HOST" (car (split-string (system-name) "\\."))))
(defvar org-dispatch-hosts
  (split-string (org-dispatch--env "ORG_DISPATCH_HOSTS" "kit cog lux")))
(defvar org-dispatch-agents
  (split-string (org-dispatch--env "ORG_DISPATCH_AGENTS" "pi claude codex agy"))
  "Agents a task may name in AGENT or a tag.")
(defconst org-dispatch-launchable '("pi" "claude" "codex" "agy")
  "Agents this dispatcher can start; a task for another waits until it can.")
(defvar org-dispatch-config
  (expand-file-name "config.json"
                    (org-dispatch--env "JUNE_CONFIG_DIR"
                                       (expand-file-name "june" (org-dispatch--env "XDG_CONFIG_HOME" "~/.config"))))
  "June's config.json, whose dispatch.host and dispatch.agent are the defaults.")
(defvar org-dispatch-root
  (expand-file-name (org-dispatch--env "ORG_DISPATCH_ROOT" "~/org/work"))
  "Directory scanned when Jon's Emacs config cannot list agenda files.")
(defvar org-dispatch-emacs-init
  (expand-file-name (org-dispatch--env "ORG_DISPATCH_EMACS_INIT" "~/.config/emacs/init.el"))
  "Jon's Emacs init file, loaded in batch to read `org-agenda-files'.")
(defvar org-dispatch-state-dir
  (expand-file-name "org-dispatch" (org-dispatch--env "XDG_STATE_HOME" "~/.local/state")))
(defvar org-dispatch-prompts
  ;; The Nix wrapper pins the prompts; from a checkout, use the ones beside this file.
  (expand-file-name (org-dispatch--env "ORG_DISPATCH_PROMPTS"
                                       (expand-file-name "../prompts" (file-name-directory (or load-file-name buffer-file-name))))))
(defvar org-dispatch-june (org-dispatch--env "ORG_DISPATCH_JUNE" "june")
  "The june command, which picks a roster agent for a task (june agents pick).
Without it a task naming one harness runs on it as before the roster.")
(defvar org-dispatch-model (getenv "ORG_DISPATCH_MODEL")
  "Model for pi, such as codex-lb/gpt-6.1-sol:high. Nil uses pi's defaults.")
(defvar org-dispatch-max-agents
  (string-to-number (org-dispatch--env "ORG_DISPATCH_MAX_AGENTS" "5")))
(defvar org-dispatch-max-nudges
  (string-to-number (org-dispatch--env "ORG_DISPATCH_MAX_NUDGES" "3")))
(defvar org-dispatch-settle
  (let ((value (org-dispatch--env "ORG_DISPATCH_SETTLE" nil)))
    (and value (string-to-number value)))
  "Seconds a heading must stay unchanged before it launches.
Nil takes dispatch.settle from June's config.json, else 120.")
(defvar org-dispatch-nudge-after
  (string-to-number (org-dispatch--env "ORG_DISPATCH_NUDGE_AFTER" "300"))
  "Seconds an agent must stay idle in PROG before each nudge.")
(defvar org-dispatch-time-limit
  (string-to-number (org-dispatch--env "ORG_DISPATCH_TIME_LIMIT" "14400")))
(defvar org-dispatch-log-keep
  (string-to-number (org-dispatch--env "ORG_DISPATCH_LOG_KEEP" "14"))
  "Run entries a repeating task keeps in its LOGBOOK; older ones go to archive.org.")
(defvar org-dispatch-retry-min
  (string-to-number (org-dispatch--env "ORG_DISPATCH_RETRY_MIN" "900"))
  "Seconds ahead a retry must be scheduled, so a task cannot spin.")

;; Calgary time regardless of the host's zone; date-only SCHEDULED is midnight.
;; libc falls back to UTC without a word when it cannot find the zone, which
;; dates evenings as tomorrow, so refuse to run instead.
(let ((zones (or (getenv "TZDIR") "/usr/share/zoneinfo")))
  (unless (file-readable-p (expand-file-name "America/Edmonton" zones))
    (error "No zone data for America/Edmonton in %s; set TZDIR" zones)))
(set-time-zone-rule "America/Edmonton")

(setq org-todo-keywords '((sequence "TODO" "PROG" "EVAL" "HOLD" "|" "DONE")
                          (sequence "AUTO" "|"))
      org-log-into-drawer t
      org-log-done 'time
      org-log-repeat nil
      org-auto-align-tags nil
      org-id-track-globally nil
      org-element-use-cache nil
      make-backup-files nil
      auto-save-default nil
      create-lockfiles nil)

;; :auto: tells a PROG task an agent is working on from one Jon left in PROG.
;; Claiming adds it. Any other state removes it, however it changes in batch
;; Org (finish, retry, a hold, org-edit); the watcher covers changes in Jon's Emacs.
(defun org-dispatch--untag-auto ()
  "Remove :auto: from the heading at point."
  (when (member "auto" (org-get-tags nil t))
    (org-toggle-tag "auto" 'off)))

(defvar org-state)
(defun org-dispatch--leave-prog ()
  (unless (equal org-state "PROG") (org-dispatch--untag-auto)))
(add-hook 'org-after-todo-state-change-hook #'org-dispatch--leave-prog)

;; ASKED marks an EVAL that holds a question or a problem for Jon. Leaving EVAL,
;; by a resume, a claim, or a close, answers it.
(defun org-dispatch--leave-asked ()
  (unless (equal org-state "EVAL") (org-entry-delete nil "ASKED")))
(add-hook 'org-after-todo-state-change-hook #'org-dispatch--leave-asked)

(defun org-dispatch--ask (who text)
  "Put this EVAL entry to Jon: WHO's TEXT in Dialog and an ASKED stamp."
  (org-dispatch--append "Dialog" (org-dispatch--entry who text))
  (org-entry-put nil "ASKED" (org-dispatch--stamp)))

(defun org-dispatch--in-loop-p ()
  "Whether the entry at point is in an independent review loop: a development
task with live review state, or a review task."
  (and (or (org-entry-get nil "REVIEW_PHASE") (org-entry-get nil "DEV_REVIEW")
           (org-entry-get nil "REVIEW_PARENT"))
       t))

(defun org-dispatch--review-mode ()
  "Who reviews the entry at point: `jon', `agent', or `none'.
REVIEW may be inherited, so a project file's #+PROPERTY can set it."
  (pcase (downcase (or (org-entry-get nil "REVIEW" t) "yes"))
    ("no" 'none)
    ("agent" 'agent)
    (_ 'jon)))

(defun org-dispatch--log (format-string &rest args)
  (princ (concat (format-time-string "%F %T ") (apply #'format format-string args) "\n")))

;;; Herdr Core

;; hc runs each worker as the program of its own terminal. An address such as
;; t7 is never reused on its core, but an address alone is not proof of which
;; run owns a terminal: a reinstalled core starts again at t1. So the dispatcher
;; labels every worker with the task, the run, the agent and the session it
;; chose before launch, and checks all four before any input, interrupt or kill.
;; Status is whatever the agent reports through OSC 7501. A terminal without a
;; status is unknown, never idle.

(define-error 'org-dispatch-hc "hc failed")

(defun org-dispatch--hc (&rest args)
  "Run hc ARGS with JSON output and return the parsed result.
Failures signal `org-dispatch-hc' with hc's error kind, such as not_found."
  (let ((stderr (make-temp-file "org-dispatch")))
    (unwind-protect
        (with-temp-buffer
          (let ((exit (apply #'call-process "hc" nil (list t stderr) nil
                             (car args) "--json" (cdr args))))
            (unless (eq exit 0)
              (let* ((text (string-trim (concat (buffer-string)
                                                (with-temp-buffer
                                                  (insert-file-contents stderr)
                                                  (buffer-string)))))
                     (json (ignore-errors (json-parse-string text :object-type 'alist
                                                             :null-object nil :false-object nil)))
                     (err (alist-get 'error json)))
                (signal 'org-dispatch-hc
                        (list (or (alist-get 'kind err) "failed")
                              (format "hc %s: %s" (string-join args " ")
                                      (or (alist-get 'message err) text))))))
            (goto-char (point-min))
            (unless (eobp)
              (json-parse-buffer :object-type 'alist :null-object nil :false-object nil))))
      (delete-file stderr))))

(defun org-dispatch--get (object &rest keys)
  (dolist (key keys object)
    (setq object (alist-get key object))))

(defun org-dispatch--hc-kind (err)
  "The hc error kind of a caught `org-dispatch-hc' ERR."
  (cadr err))

(defun org-dispatch--reason (err)
  "A readable message for a caught ERR, using hc's own words for hc failures."
  (if (eq (car err) 'org-dispatch-hc) (caddr err) (error-message-string err)))

(defun org-dispatch--terminal (address)
  "ADDRESS's terminal record, live or finished, or nil when hc has none."
  (condition-case err
      (org-dispatch--hc "get" address)
    (org-dispatch-hc
     (if (equal (org-dispatch--hc-kind err) "not_found") nil (signal (car err) (cdr err))))))

(defun org-dispatch--label (terminal key)
  (alist-get key (alist-get 'labels terminal) nil nil #'string=))

(defun org-dispatch--labels (terminal)
  "TERMINAL's labels as an alist with string keys."
  (mapcar (lambda (pair) (cons (symbol-name (car pair)) (cdr pair)))
          (alist-get 'labels terminal)))

(defun org-dispatch--owner (terminal)
  "The (TASK RUN AGENT SESSION) labels TERMINAL carries, or nil."
  (let ((labels (org-dispatch--labels terminal)))
    (mapcar (lambda (key) (cdr (assoc key labels)))
            '("org.task" "org.run" "org.agent" "org.session"))))

(defun org-dispatch--owns-p (state terminal)
  "Non-nil when TERMINAL is STATE's worker: every identity label matches."
  (and terminal
       (equal (org-dispatch--owner terminal)
              (list (plist-get state :id) (plist-get state :run)
                    (plist-get state :agent) (plist-get state :session)))))

(defun org-dispatch--live-p (terminal)
  (equal (alist-get 'state terminal) "live"))

(defun org-dispatch--status (terminal)
  "TERMINAL's reported status word; \"unknown\" when live without one; nil once gone.
TERMINAL is an hc get record, whose status is an object, or an hc ls row,
whose status is the bare word."
  (when (org-dispatch--live-p terminal)
    (let ((status (alist-get 'status terminal)))
      (or (if (stringp status) status (alist-get 'state status)) "unknown"))))

(defun org-dispatch--worker (state)
  "STATE's live worker terminal after checking its identity, else nil.
A terminal at STATE's address that carries other labels is not this run's."
  (let ((terminal (and (plist-get state :terminal)
                       (org-dispatch--terminal (plist-get state :terminal)))))
    (cond ((null terminal) nil)
          ((not (org-dispatch--owns-p state terminal))
           (org-dispatch--log "terminal %s no longer carries task %s's run; leaving it alone"
                              (plist-get state :terminal) (plist-get state :id))
           nil)
          ((org-dispatch--live-p terminal) terminal))))

(defun org-dispatch--worker-account (state)
  "The June account login (claude1, codex2, ...) STATE's worker runs on, or nil.
June's wrappers export JUNE_ACCOUNT, which the harness process keeps."
  (let ((pid (alist-get 'pid (org-dispatch--worker state))))
    (when (integerp pid) (org-dispatch--process-account pid 3))))

(defun org-dispatch--process-account (pid depth)
  "JUNE_ACCOUNT in process PID's environment, or in its descendants' to DEPTH.
A terminal started as a shell runs the harness as its child."
  (or (ignore-errors
        (with-temp-buffer
          (insert-file-contents-literally (format "/proc/%d/environ" pid))
          (when (re-search-forward "\\(?:^\\|\0\\)JUNE_ACCOUNT=\\([a-z]+[0-9]+\\)" nil t)
            (match-string 1))))
      (and (> depth 0)
           (seq-some (lambda (child) (org-dispatch--process-account (string-to-number child) (1- depth)))
                     (ignore-errors
                       (with-temp-buffer
                         (insert-file-contents-literally (format "/proc/%d/task/%d/children" pid pid))
                         (split-string (buffer-string))))))))

(defun org-dispatch--check-account (slot)
  "June's answer on whether login SLOT can still work, an alist with usable,
reason and next, or nil when june cannot say."
  (let ((june (executable-find org-dispatch-june)))
    (when june
      (with-temp-buffer
        (call-process june nil '(t nil) nil "accounts" "check" slot "--refresh" "--json")
        (ignore-errors
          (json-parse-string (buffer-string) :object-type 'alist :null-object nil :false-object nil))))))

(defvar org-dispatch-max-switches 3
  "Account switches one run may make before its task goes to Jon.")

(defun org-dispatch--out-of-quota (state)
  "Continue STATE's idle worker on another account when its own has run out.
Return non-nil when it did, or when no account can continue and the task
went to Jon; nil leaves the worker to the usual nudges."
  (let* ((slot (org-dispatch--worker-account state))
         (check (and slot (org-dispatch--check-account slot))))
    (when (and check (not (alist-get 'usable check)))
      (let ((next (alist-get 'next check))
            (reason (alist-get 'reason check))
            (switches (or (plist-get state :switches) 0)))
        (if (or (null next) (>= switches org-dispatch-max-switches) (null (plist-get state :session)))
            (org-dispatch--park state (format "%s ran out of quota (%s), and %s." slot reason
                                              (cond ((null (plist-get state :session)) "its session is unknown, so it cannot continue elsewhere")
                                                    ((null next) "no other account can continue it")
                                                    (t (format "it already moved %d times" switches)))))
          (org-dispatch--continue-elsewhere state slot reason))
        t))))

(defun org-dispatch--continue-elsewhere (state slot reason)
  "End STATE's worker on spent login SLOT and resume its session in a new
terminal through the harness's plain name, which picks an account with quota.
Sessions are shared between a harness's accounts, so the agent carries on."
  (let* ((agent (plist-get state :agent))
         (card (and (plist-get state :card)
                    (json-parse-string (plist-get state :card) :object-type 'alist :null-object nil :false-object nil)))
         (task (list :agent agent :heading (plist-get state :heading) :model (plist-get state :model) :card card))
         (command (or (org-dispatch--command agent) agent))
         (prompt (format "The account you were working on (%s) ran out of quota: %s. This is the same session, resumed on another account. Continue the task from where you stopped." slot reason))
         (old (plist-get state :terminal))
         (slug (alist-get 'slug card)))
    (ignore-errors (org-dispatch--hc "kill" old))
    (let* ((started (apply #'org-dispatch--hc "run" "--bg" "--no-parent"
                           "--name" (format "auto-%s-%s" (org-dispatch--id8 (plist-get state :id)) (format-time-string "%H%M%S"))
                           "--cwd" (plist-get state :dir)
                           "--label" (concat "org.dispatch=" org-dispatch-host)
                           "--label" (concat "org.task=" (plist-get state :id))
                           "--label" (concat "org.run=" (plist-get state :run))
                           "--label" (concat "org.agent=" agent)
                           "--label" (concat "org.session=" (plist-get state :session))
                           (append (when slug (list "--label" (concat "june.agent=" slug)))
                                   (list "--")
                                   (org-dispatch--agent-argv task command (plist-get state :session) nil prompt))))
           (address (alist-get 'address started)))
      (unless address (error "hc run returned no terminal address"))
      (setq state (plist-put state :terminal address))
      (setq state (plist-put state :idle 0))
      (setq state (plist-put state :switches (1+ (or (plist-get state :switches) 0))))
      (org-dispatch--save-state state)
      (org-dispatch--edit (plist-get state :file) (plist-get state :id)
        (lambda ()
          (org-dispatch--append "Dialog" (org-dispatch--entry "Dispatcher"
            (format "%s ran out of quota (%s); the session continues on another account in hc terminal %s." slot reason address))))
        (plist-get state :heading))
      (org-dispatch--log "%s: %s ran out of quota; continued in %s" (plist-get state :id) slot address))))

(defun org-dispatch--agent-status (state)
  "STATE's worker status, or nil when its worker is gone."
  (org-dispatch--status (org-dispatch--worker state)))

(defun org-dispatch--session-terminals (session &optional host)
  "Terminals labelled with agent SESSION, on HOST when it is another machine."
  (let ((terminals (org-dispatch--get (org-dispatch--hc "ls" "--all" "--label" (concat "org.session=" session))
                                      'terminals)))
    (unless (vectorp terminals) (error "hc did not return a terminal list"))
    (seq-filter (lambda (terminal)
                  (let ((address (alist-get 'address terminal)))
                    (if (or (null host) (equal host org-dispatch-host))
                        (not (string-search "/" address))
                      (string-prefix-p (concat host "/") address))))
                terminals)))

(defun org-dispatch--live-session (session agent)
  "The address of the live local terminal running AGENT's SESSION, if any.
Ambiguity is an error: two live terminals must never run one session."
  (let ((live (seq-filter (lambda (terminal)
                            (and (org-dispatch--live-p terminal)
                                 (equal (org-dispatch--label (org-dispatch--hc "get" (alist-get 'address terminal))
                                                             'org.agent)
                                        agent)))
                          (org-dispatch--session-terminals session))))
    (when (cdr live) (error "session %s runs in %d terminals" session (length live)))
    (alist-get 'address (car live))))

(defun org-dispatch--space (project)
  "The herdr-app space named PROJECT, from the labels of its live terminals.
The app labels each terminal it shows with where (\"SPACE / TAB\") and
herdr.space. Spaces only decide where the app shows a worker; nil keeps it
hidden."
  (let ((pattern (concat "\\`\\(?:\\[[0-9]+\\] \\)?" (regexp-quote project) " / ")))
    (seq-some (lambda (row)
                (and (string-match-p pattern (or (alist-get 'where row) ""))
                     (org-dispatch--label (org-dispatch--terminal (alist-get 'address row)) 'herdr.space)))
              (ignore-errors (org-dispatch--get (org-dispatch--hc "ls") 'terminals)))))

(defun org-dispatch--shared-claude-session-p (uuid)
  "Non-nil when Claude session UUID is in ~/.claude/projects, which June's
account folders (claude1, claude2, ...) share, so any of them resumes it."
  (file-expand-wildcards (format "~/.claude/projects/*/%s.jsonl" uuid)))

(defun org-dispatch--claude-launcher (uuid)
  "Account launcher for the Claude config directory holding session UUID.
A launcher such as claude-work fixes CLAUDE_CONFIG_DIR to ~/.claude-work, so
only claude-NAME can resume a session saved under ~/.claude-NAME. Return nil
when the session is elsewhere or that launcher is missing."
  (seq-some (lambda (dir)
              (let ((launcher (and (string-match "/\\.claude-\\([^/]+\\)\\'" dir)
                                   (concat "claude-" (match-string 1 dir)))))
                (and launcher
                     (file-expand-wildcards (format "%s/projects/*/%s.jsonl" dir uuid))
                     (executable-find launcher)
                     launcher)))
            (file-expand-wildcards "~/.claude-*" t)))

(defun org-dispatch--session-file (uuid)
  (car (append (file-expand-wildcards
                (format "~/.local/state/pi/sessions/*/*_%s.jsonl" uuid) t)
               (file-expand-wildcards
                (format "~/.pi/agent/sessions/*/*_%s.jsonl" uuid) t))))

(defun org-dispatch--notify (title body &optional link)
  "Send a task-level notification through herdr-notify, when it is installed.
Terminal-level done and blocked notices come from its event consumer."
  (when (executable-find "herdr-notify")
    (ignore-errors
      (apply #'call-process "herdr-notify" nil 0 nil "send" "--title" title "--body" body
             (and link (list "--link" link))))))

;;; Org

(defvar org-dispatch--agenda-memo nil
  "Within one dispatcher run, its agenda files as (FILES . WRITE).
The run loads Jon's Emacs config once, not at every step that wants
the list. WRITE is non-nil while a list read from the config has yet
to be written to the cache file. Outside a run, which binds
`org-dispatch--memoize', every call reads the config again.")

(defvar org-dispatch--memoize nil
  "Non-nil while one dispatcher run may reuse its list of agenda files.")

(defun org-dispatch--agenda-files (&optional read-only)
  "Jon's `org-agenda-files', read by loading his Emacs config in batch.
Cache the list, and reuse the last good one when the config fails to load,
so a half-edited config does not stop dispatching.
READ-ONLY leaves the cache alone."
  (unless (and org-dispatch--memoize org-dispatch--agenda-memo)
    (setq org-dispatch--agenda-memo (org-dispatch--read-agenda-files)))
  (when (and (not read-only) (cdr org-dispatch--agenda-memo))
    (org-dispatch--write-agenda-cache (cadr org-dispatch--agenda-memo))
    (setcdr org-dispatch--agenda-memo nil))
  (seq-filter (lambda (file)
                (and (file-regular-p file)
                     (not (string-search ".sync-conflict-" file))))
              (car org-dispatch--agenda-memo)))

(defun org-dispatch--write-agenda-cache (files)
  "Write FILES to the cached agenda list.
June's boards read it, and a run whose config fails to load."
  (make-directory org-dispatch-state-dir t)
  (with-temp-file (expand-file-name "agenda-files" org-dispatch-state-dir) (insert (string-join files "\n"))))

(defun org-dispatch--read-agenda-files ()
  "Jon's agenda files as (FILES . WRITE).
FILES come from his Emacs config, else the cache, else every Org file
under the root. WRITE holds the list read from the config, to be
written to the cache, or nil when the config failed to load."
  (let ((cache (expand-file-name "agenda-files" org-dispatch-state-dir))
        files)
    (when (file-readable-p org-dispatch-emacs-init)
      (with-temp-buffer
        (when (eq 0 (call-process
                     (expand-file-name invocation-name invocation-directory) nil '(t nil) nil
                     "--batch" "-l" org-dispatch-emacs-init "--eval"
                     "(dolist (f (org-agenda-files)) (princ (format \"\\norg-dispatch-file:%s\\n\" f)))"))
          (goto-char (point-min))
          (while (re-search-forward "^org-dispatch-file:\\(.+\\)$" nil t)
            (push (match-string 1) files)))))
    (if files
        (let ((files (nreverse files))) (cons files (list files)))
      (org-dispatch--log "could not read org-agenda-files from %s; using %s"
                         org-dispatch-emacs-init
                         (if (file-exists-p cache) "the cached list" org-dispatch-root))
      (list (if (file-exists-p cache)
                (with-temp-buffer
                  (insert-file-contents cache)
                  (split-string (buffer-string) "\n" t))
              (directory-files-recursively
               org-dispatch-root "\\.org\\'" nil
               (lambda (dir) (not (string-prefix-p "." (file-name-nondirectory dir))))))))))

(defun org-dispatch--files (&optional agenda)
  "Live AGENDA files, or Jon's agenda files, with an AUTO heading."
  (seq-filter (lambda (file)
                (and (not (equal (file-name-nondirectory file) "archive.org"))
                     (not (string-match-p "/archive/" file))
                     (with-temp-buffer
                       (insert-file-contents file)
                       (re-search-forward "^\\*+ AUTO " nil t))))
              (or agenda (org-dispatch--agenda-files))))

(defun org-dispatch--edit (file id function &optional heading)
  "Call FUNCTION at the heading with ID in FILE, then save.
Without an ID in the file yet, find the HEADING by its text instead. Visit
the file fresh so concurrent edits by agents are not overwritten."
  (let ((buffer (find-file-noselect file t)))
    (unwind-protect
        (with-current-buffer buffer
          (org-mode)
          ;; With a nil ID, org-find-property matches any heading that has one.
          (let ((position (or (and id (org-find-property "ID" id))
                              (and heading (org-find-exact-headline-in-buffer heading)))))
            (unless position (error "no heading %s in %s" (or heading id) file))
            (goto-char position)
            (prog1 (funcall function)
              (when (buffer-modified-p) (save-buffer)))))
      (kill-buffer buffer))))

(defun org-dispatch--org-root ()
  "Org root above work, or the explicitly configured fixture root."
  (let ((root (file-name-as-directory org-dispatch-root)))
    (if (equal (file-name-nondirectory (directory-file-name root)) "work")
        (file-name-directory (directory-file-name root)) root)))

(defun org-dispatch--lookup-files (&optional agenda)
  "AGENDA and their archives, nearest directory first, up to the Org root."
  (let* ((agenda (or agenda (org-dispatch--agenda-files)))
         (root (org-dispatch--org-root))
         (seen (make-hash-table :test 'equal))
         archives)
    (dolist (file agenda)
      (let ((dir (file-name-directory file)))
        (while (and dir (file-in-directory-p dir root))
          (unless (gethash dir seen)
            (puthash dir t seen)
            (let ((archive (expand-file-name "archive.org" dir))
                  (tree (expand-file-name "archive" dir)))
              (when (file-readable-p archive) (push archive archives))
              (when (file-directory-p tree)
                (setq archives
                      (append (directory-files-recursively
                               tree "\\.org\\'" nil
                               (lambda (dir) (not (string-prefix-p "." (file-name-nondirectory dir)))))
                              archives)))))
          (setq dir (unless (equal (directory-file-name dir) (directory-file-name root))
                      (file-name-directory (directory-file-name dir)))))))
    (seq-filter (lambda (file) (not (string-search ".sync-conflict-" file)))
                (delete-dups (append agenda (nreverse archives))))))

(defun org-dispatch--find (id &optional agenda)
  "Return the file holding ID in AGENDA or their archives."
  (seq-find (lambda (file)
              (with-temp-buffer
                (insert-file-contents file)
                (re-search-forward (format "^[ \t]*:ID:[ \t]+%s[ \t]*$" (regexp-quote id)) nil t)))
            (org-dispatch--lookup-files agenda)))

(defun org-dispatch--stamp ()
  (format-time-string (org-time-stamp-format t t)))

(defun org-dispatch--subtree-text ()
  (buffer-substring-no-properties
   (point) (save-excursion (org-end-of-subtree t t) (point))))

(defun org-dispatch--section-stars ()
  "Stars for a direct child of the entry at point."
  (make-string (1+ (org-current-level)) ?*))

(defun org-dispatch--section-bounds (title)
  "Return (BEGIN . END) of the child section TITLE of this entry."
  (save-excursion
    (let ((end (save-excursion (org-end-of-subtree t t) (point))))
      (when (re-search-forward (format "^%s %s[ \t]*$"
                                       (regexp-quote (org-dispatch--section-stars))
                                       (regexp-quote title))
                               end t)
        (let ((begin (match-beginning 0)))
          (goto-char begin)
          (cons begin (save-excursion (org-end-of-subtree t t) (point))))))))

(defun org-dispatch--append (title text)
  "Append TEXT to section TITLE of this entry, creating it when needed.
New sections go before Dialog, which stays last."
  (save-excursion
    (let ((section (org-dispatch--section-bounds title))
          (stars (org-dispatch--section-stars)))
      (if section
          (goto-char (cdr section))
        (goto-char (or (and (not (equal title "Dialog"))
                            (car (org-dispatch--section-bounds "Dialog")))
                       (save-excursion (org-end-of-subtree t t) (point)))))
      (skip-chars-backward " \t\n")
      (end-of-line)
      (insert (if section "\n" (format "\n\n%s %s\n" stars title)) text)
      (unless section
        (unless (looking-at-p "\n") (insert "\n"))
        (when (looking-at-p "\n\\*") (insert "\n"))))))

(defun org-dispatch--remove-section (title)
  (let ((section (org-dispatch--section-bounds title)))
    (when section (delete-region (car section) (cdr section)))))

(defun org-dispatch--trim-log (id)
  "Move LOGBOOK entries of the entry at point past `org-dispatch-log-keep'
to a run log heading for ID in archive.org beside this file, newest first."
  (save-excursion
    (let ((limit (save-excursion (outline-next-heading) (point)))
          items)
      (when (re-search-forward "^[ \t]*:LOGBOOK:[ \t]*\n" limit t)
        (let ((end (save-excursion (re-search-forward "^[ \t]*:END:" limit) (match-beginning 0))))
          (while (re-search-forward "^- " end t)
            (push (match-beginning 0) items))
          (setq items (nreverse items))
          (when (> (length items) org-dispatch-log-keep)
            (let ((cut (nth org-dispatch-log-keep items))
                  (heading (org-get-heading t t t t))
                  (olpath (save-excursion
                            (goto-char (org-entry-beginning-position))
                            (string-join (org-get-outline-path) "/")))
                  (category (org-get-category))
                  (source (abbreviate-file-name buffer-file-name)))
              ;; Save the archive before deleting, so a failure loses nothing.
              (org-dispatch--edit-archive
               (expand-file-name "archive.org" (file-name-directory buffer-file-name))
               id (buffer-substring-no-properties cut end)
               (format ":ARCHIVE_FILE: %s\n:ARCHIVE_OLPATH: %s\n:ARCHIVE_CATEGORY: %s\n"
                       source olpath category)
               heading)
              (delete-region cut end))))))))

(defun org-dispatch--log-run (id to from note)
  "Log this run in the LOGBOOK of the entry at point as a change FROM to TO
with NOTE, moving the Sessions links into it, then trim the log."
  (let ((links (save-excursion
                 (let ((section (org-dispatch--section-bounds "Sessions")) found)
                   (when section
                     (goto-char (car section))
                     (while (re-search-forward "\\[\\[herdr:[^]]+\\]\\[[^]]+\\]\\]"
                                               (cdr section) t)
                       (push (match-string 0) found)))
                   (nreverse found)))))
    (org-dispatch--remove-section "Sessions")
    (save-excursion
      (goto-char (org-log-beginning t))
      (insert (format "- State %-12s from %-12s %s \\\\\n  %s\n"
                      (format "\"%s\"" to) (format "\"%s\"" from)
                      (org-dispatch--stamp)
                      (string-trim (concat (string-join links " ") " " note)))))
    (org-dispatch--trim-log id)))

(defun org-dispatch--edit-archive (file id text properties heading)
  "Insert TEXT at the top of ID's run log in FILE, creating it when needed."
  (let ((buffer (find-file-noselect file t)))
    (unwind-protect
        (with-current-buffer buffer
          (org-mode)
          (let ((position (org-find-property "ARCHIVE_ID" id)))
            (if position
                (goto-char position)
              (goto-char (point-max))
              (unless (bolp) (insert "\n"))
              (insert (format "\n* %s run log\n:PROPERTIES:\n:ARCHIVE_ID: %s\n%s:END:\n"
                              heading id properties))
              (forward-line -1)))
          (org-end-of-meta-data)
          (insert text)
          (save-buffer))
      (kill-buffer buffer))))

(defun org-dispatch--entry (title text)
  "Format a Dialog entry by TITLE with TEXT, indenting continuation lines."
  (format "- %s %s: %s" title (org-dispatch--stamp)
          (replace-regexp-in-string "\n" "\n  " (string-trim text))))

(defun org-dispatch--project-repos (file)
  "Local repository links in FILE's preamble, in either the one-line
=Repository:= form or the =Repositories:= list."
  (with-temp-buffer
    (insert-file-contents file)
    (let (repos (end (or (re-search-forward "^\\* " nil t) (point-max))))
      (goto-char (point-min))
      (while (re-search-forward "\\[\\[file:\\([^]]+\\)\\]\\[local\\]\\]" end t)
        (push (directory-file-name (expand-file-name (match-string 1))) repos))
      (nreverse repos))))

(defun org-dispatch--project-dir (file)
  "The project's only local repository, or the project directory."
  (let ((repos (org-dispatch--project-repos file)))
    (if (= (length repos) 1)
        (car repos)
      (directory-file-name (file-name-directory file)))))

(defvar org-dispatch--defaults nil)
(defun org-dispatch--default (key fallback)
  "June's dispatch KEY, such as \"host\" or \"settle\", or FALLBACK when it
has none of FALLBACK's type. A nil FALLBACK returns the untyped value."
  (unless org-dispatch--defaults
    (setq org-dispatch--defaults
          (or (ignore-errors
                (with-temp-buffer
                  (insert-file-contents org-dispatch-config)
                  (let ((dispatch (gethash "dispatch" (json-parse-buffer))))
                    (and (hash-table-p dispatch) dispatch))))
              (make-hash-table :test 'equal))))
  (let ((value (gethash key org-dispatch--defaults)))
    (cond ((and (stringp fallback) (stringp value) (not (string-empty-p value))) value)
          ((and (numberp fallback) (natnump value)) value)
          ((null fallback) value)
          (t fallback))))

(defun org-dispatch--command (agent)
  "Executable override for AGENT, or nil for Herdr's native launcher."
  (let ((commands (org-dispatch--default "commands" nil)))
    (when commands
      (unless (hash-table-p commands) (error "dispatch.commands must be an object"))
      (maphash
       (lambda (kind command)
         (unless (and (member kind org-dispatch-launchable) (stringp command)
                      (string-match-p "\\`\\(?:[A-Za-z0-9_][A-Za-z0-9_.+-]*\\|/[A-Za-z0-9_./+-]+\\)\\'" command))
           (error "dispatch.commands must map pi, claude, codex or agy to executable names or absolute paths, without arguments")))
       commands)
      (gethash agent commands))))

(defun org-dispatch--resolve (property known default)
  "The entry's PROPERTY: from its drawer, else the one tag among KNOWN on the
heading, else in #+FILETAGS, else DEFAULT. Return (:value V :fill BOOL) or
(:problem TEXT); :fill means the drawer lacks it."
  (let ((set (org-entry-get nil property)))
    (if set
        (if (member set known)
            (list :value set)
          (list :problem (format "%s %s is not one of %s" property set (string-join known ", "))))
      (let ((tagged (or (seq-intersection (org-get-tags nil t) known)
                        (seq-intersection org-file-tags known))))
        (cond ((cdr tagged)
               (list :problem (format "tagged for %s" (string-join tagged " and "))))
              (tagged (list :value (car tagged) :fill t))
              ((member default known) (list :value default :fill t))
              (t (list :problem (format "no %s, and the default %s is not one of %s"
                                        property default (string-join known ", ")))))))))

(defun org-dispatch--parse-live-content (text)
  "Read the bounded content approval in TEXT, never a deployment flag."
  (let ((grant (condition-case nil (json-parse-string text :object-type 'alist)
                 (error (error "invalid live-content JSON")))))
    (unless (and (listp grant) (= (length grant) 3) (seq-every-p #'consp grant)
                 (seq-every-p (lambda (key)
                               (let ((value (alist-get key grant)))
                                 (and (stringp value) (<= (length value) 4000)
                                      (not (string-empty-p (string-trim value)))
                                      (not (string-match-p "[[:cntrl:]]" value)))))
                             '(target actions limits)))
      (error "live-content needs only target, actions and limits, each one non-empty line of at most 4000 characters"))
    grant))

(defun org-dispatch--live-content-scope ()
  "Bind content approval to this task's ID, title, directory and unique Scope."
  (let ((level (1+ (org-outline-level)))
        (end (save-excursion (org-end-of-subtree t t)))
        (count 0) scope)
    (save-excursion
      (forward-line 1)
      (while (re-search-forward (format "^%s Scope[ \t]*$" (regexp-quote (make-string level ?*))) end t)
        (setq count (1+ count))
        (setq scope (string-trim (buffer-substring-no-properties
                                 (line-beginning-position 2) (save-excursion (org-end-of-subtree t t)))))))
    (unless (and (= count 1) (not (string-empty-p scope)))
      (error "live-content approval needs one non-empty Scope section"))
    (secure-hash 'sha256 (json-serialize (vector (org-entry-get nil "ID")
                                                (org-get-heading t t t t)
                                                (org-entry-get nil "DIR") scope)))))

(defun org-dispatch--live-content ()
  "Return valid saved approval, or refuse malformed or changed scope."
  (let ((text (org-entry-get nil "LIVE_CONTENT"))
        (scope (org-entry-get nil "LIVE_CONTENT_SCOPE")))
    (when (or text scope)
      (unless (and text scope) (error "incomplete live-content approval; reconfirm or revoke it"))
      (let ((grant (org-dispatch--parse-live-content text)))
        (unless (equal scope (org-dispatch--live-content-scope))
          (error "live-content approval scope changed; reconfirm or revoke it"))
        grant))))

(defun org-dispatch--task ()
  "Describe the entry at point."
  (let* ((host (org-dispatch--resolve "HOST" org-dispatch-hosts
                                      (org-dispatch--default "host" (car org-dispatch-hosts))))
         (named (org-dispatch--roster-names))
         ;; A roster task's harness is known once June picks its agent.
         (agent (if named (list :value nil)
                  (org-dispatch--resolve "AGENT" org-dispatch-agents
                                         (org-dispatch--default "agent" "pi"))))
         (section (org-dispatch--section-bounds "Sessions"))
         (dir (org-entry-get nil "DIR"))
         (live-content (condition-case err (org-dispatch--live-content)
                         (error (list (cons 'error (error-message-string err))))))
         sessions)
    ;; Only the Sessions section names this run's sessions; LOGBOOK holds past runs.
    (when section
      (save-excursion
        (goto-char (car section))
        (while (re-search-forward
                (format "herdr:%s/\\(%s\\):\\([0-9a-f-]+\\)"
                        (regexp-quote org-dispatch-host)
                        (mapconcat #'regexp-quote org-dispatch-launchable "\\|"))
                (cdr section) t)
          (push (cons (match-string 1) (match-string 2)) sessions))))
    (list :file buffer-file-name
          :id (org-entry-get nil "ID")
          :heading (org-get-heading t t t t)
          :todo (org-get-todo-state)
          :host (plist-get host :value)
          :agent (plist-get agent :value)
          :problem (or (plist-get host :problem) (plist-get agent :problem) (alist-get 'error live-content))
          :fill (append (when (plist-get agent :fill) (list (cons "AGENT" (plist-get agent :value))))
                        (when (plist-get host :fill) (list (cons "HOST" (plist-get host :value)))))
          :scheduled (org-get-scheduled-time (point))
          :repeat (org-get-repeat)
          :depends (split-string (or (org-entry-get nil "DEPENDS") ""))
          :retry (string-to-number (or (org-entry-get nil "RETRY") "0"))
          :june (or (org-entry-get nil "JUNE_REQUEST") (org-entry-get nil "PLAN_REQUEST"))
          :review-loop (org-dispatch--in-loop-p)
          :review (not (eq (org-dispatch--review-mode) 'none))
          :agent-review (eq (org-dispatch--review-mode) 'agent)
          :deploy (equal (downcase (or (org-entry-get nil "DEPLOY") "no")) "yes")
          :live-content live-content
          :branch (org-entry-get nil "BRANCH")
          :model (or (org-entry-get nil "MODEL")
                     (when (equal (plist-get agent :value) "pi") org-dispatch-model))
          :model-set (org-entry-get nil "MODEL")
          ;; Roster agents to choose among, in Jon's order: AGENTS, a roster
          ;; AGENT, or June's dispatch.roster. A harness name among them is an
          ;; unnamed worker on it; a task naming only its harness has none.
          :roster named
          :sessions sessions
          :stopped (cons (org-entry-get nil "JUNE_STOP_SESSION")
                         (split-string (or (org-entry-get nil "JUNE_STOP_SESSIONS") "")))
          :dir (if dir (expand-file-name dir) (org-dispatch--project-dir buffer-file-name))
          :repos (org-dispatch--project-repos buffer-file-name)
          ;; An interrupted session stays in history but must never receive work again.
          :session (org-dispatch--session-for
                    sessions (plist-get agent :value)
                    (cons (org-entry-get nil "JUNE_STOP_SESSION")
                          (split-string (or (org-entry-get nil "JUNE_STOP_SESSIONS") ""))))
          :dialog (org-dispatch--new-dialog)
          :hash (secure-hash 'sha1 (org-dispatch--subtree-text)))))

(defun org-dispatch--session-for (sessions agent stopped)
  "AGENT's latest session among SESSIONS, (KIND . UUID) pairs newest first,
unless STOPPED names it."
  (let ((latest (cdr (assoc agent sessions))))
    (unless (member latest stopped) latest)))

(defun org-dispatch--roster-names ()
  "The roster agents the entry at point asks for, in order, or nil.
AGENTS lists candidates. An AGENT that is not a harness name is one agent.
A task with no AGENT, AGENTS or agent tag takes June's dispatch.roster."
  (let ((agents (org-entry-get nil "AGENTS"))
        (agent (org-entry-get nil "AGENT")))
    (cond (agents (split-string agents))
          (agent (unless (member agent org-dispatch-agents) (list agent)))
          ((or (seq-intersection (org-get-tags nil t) org-dispatch-agents)
               (seq-intersection org-file-tags org-dispatch-agents))
           nil)
          (t (let ((roster (org-dispatch--default "roster" nil)))
               (when (and (vectorp roster) (> (length roster) 0))
                 (append roster nil)))))))

(defun org-dispatch--pick (names taken)
  "June's choice among roster NAMES for this host, skipping TAKEN agents.
Return the parsed answer of `june agents pick', or nil when june cannot run."
  (let ((june (executable-find org-dispatch-june)))
    (when june
      (with-temp-buffer
        (apply #'call-process june nil '(t nil) nil "agents" "pick" "--json"
               "--host" org-dispatch-host
               "--harnesses" (string-join org-dispatch-launchable ",")
               (append (when taken (list "--except" (string-join taken ","))) names))
        (ignore-errors
          (json-parse-string (buffer-string) :object-type 'alist :null-object nil :false-object nil))))))

(defun org-dispatch--choose (task taken)
  "TASK with its agent chosen, or (:wait REASON) when none can take it now.
TAKEN lists the roster agents given tasks earlier in this pass."
  (let* ((names (or (plist-get task :roster)
                    (when (plist-get task :agent) (list (plist-get task :agent)))))
         (single (and (null (cdr names)) (member (car names) org-dispatch-launchable) (car names)))
         ;; A task naming only a harness runs an unnamed worker on it, as before the roster.
         (pick (unless single (org-dispatch--pick names taken)))
         (card (alist-get 'card pick))
         (harness (or (alist-get 'legacy pick) (alist-get 'harness card)
                      (and (null pick) single))))
    (cond
     ((not (member harness org-dispatch-launchable))
      (list :wait (if pick (or (alist-get 'why pick) "no agent is free")
                    (format "%s cannot run to pick among %s" org-dispatch-june (string-join names " ")))))
     ;; The plain harness it already names, with no roster agent: as before the roster.
     ((and (null card) (equal harness (plist-get task :agent))) task)
     (t
      (let ((task (copy-sequence task))
            (model (or (plist-get task :model-set) (alist-get 'model card))))
        (setq task (plist-put task :agent harness))
        (setq task (plist-put task :card card))
        (setq task (plist-put task :session
                              (org-dispatch--session-for (plist-get task :sessions) harness
                                                         (plist-get task :stopped))))
        (setq task (plist-put task :model
                              (cond ((and model (equal harness "pi") (not (string-search "/" model)))
                                     (concat "openai-codex/" model))
                                    (model)
                                    ((equal harness "pi") org-dispatch-model))))
        ;; The task now names its agent, so a resume returns to the same one.
        (setq task (plist-put task :set (list (cons "AGENT" (or (alist-get 'slug card) harness)))))
        task)))))

(defun org-dispatch--new-dialog ()
  "Dialog entries written since the agent's last entry."
  (let ((section (org-dispatch--section-bounds "Dialog")))
    (when section
      (save-excursion
        (goto-char (car section))
        (forward-line 1)
        (let ((start (point)))
          (while (re-search-forward "^- Agent\\b" (cdr section) t)
            (setq start (if (re-search-forward "^- " (cdr section) t)
                            (match-beginning 0)
                          (cdr section))))
          (let ((text (string-trim (buffer-substring-no-properties start (cdr section)))))
            (unless (string-empty-p text) text)))))))

(defun org-dispatch--tasks (&optional agenda)
  "AUTO headings in AGENDA, or Jon's agenda files."
  (let (tasks)
    (dolist (file (org-dispatch--files agenda))
      (let ((buffer (find-file-noselect file t)))
        (with-current-buffer buffer
          (org-mode)
          (org-map-entries
           (lambda ()
             (let ((task (org-dispatch--task)))
               (when (equal (plist-get task :todo) "AUTO")
                 (push task tasks))))
           "/AUTO"))
        (kill-buffer buffer)))
    (nreverse tasks)))

;;; Dependencies

(defun org-dispatch--dependency-entry ()
  "Dependency facts for the heading at point, without launch settings."
  (let ((section (org-dispatch--section-bounds "Outcome")))
    (list :id (org-entry-get nil "ID") :file buffer-file-name
          :heading (org-get-heading t t t t) :todo (org-get-todo-state)
          :depends (split-string (or (org-entry-get nil "DEPENDS") ""))
          :note (org-entry-get nil "DISPATCH_FINISH")
          :plan-hash (org-entry-get nil "PLAN_HASH")
          :outcome (when section
                     (string-trim (buffer-substring-no-properties
                                   (save-excursion (goto-char (car section)) (forward-line 1) (point))
                                   (cdr section)))))))

(defun org-dispatch--dependency-index (&optional files)
  "Index IDs across FILES, including archives. Duplicate IDs fail closed."
  (let ((index (make-hash-table :test 'equal)))
    (dolist (file (or files (org-dispatch--lookup-files)))
      (with-temp-buffer
        (insert-file-contents file)
        (setq buffer-file-name file)
        (org-mode)
        (org-map-entries
         (lambda ()
           (when-let* ((entry (org-dispatch--dependency-entry)) (id (plist-get entry :id)))
             (puthash id (if (gethash id index) (list :duplicate id) entry) index))))))
    index))

(defun org-dispatch--dependencies (task &optional index)
  "Return (:kind ready|waiting|blocked :reason TEXT) for TASK's graph.
Only DONE satisfies an edge. Walk every edge, preferring a blocked root over
an ordinary wait. A completed node need not have completed ancestors again."
  (let ((index (or index (and (plist-get task :depends) (org-dispatch--dependency-index)))))
    (cl-labels
        ((walk (refs path)
           (let (waiting blocked)
             (dolist (ref refs)
               (let* ((valid (string-match-p "\\`id:[[:alnum:]][[:alnum:]-]*\\'" ref))
                      (id (and valid (substring ref 3)))
                      (node (and id (gethash id index)))
                      (label (format "%s (%s)" (or (plist-get node :heading) id ref)
                                     (or (plist-get node :todo) "missing")))
                      (result
                       (cond
                        ((not valid) (list :kind 'blocked :reason (concat "invalid DEPENDS reference " ref)))
                        ((not node) (list :kind 'blocked :reason (concat "missing ID " id)))
                        ((plist-get node :duplicate) (list :kind 'blocked :reason (concat "duplicate ID " id)))
                        ((member id path) (list :kind 'blocked :reason (concat "cycle at " label)))
                        ((equal (plist-get node :todo) "DONE") (list :kind 'ready))
                        ((equal (plist-get node :todo) "HOLD") (list :kind 'blocked :reason label))
                        (t (let ((below (walk (plist-get node :depends) (cons id path))))
                             (if (eq (plist-get below :kind) 'ready)
                                 (list :kind 'waiting :reason label)
                               below))))))
                 (pcase (plist-get result :kind)
                   ('blocked (unless blocked (setq blocked result)))
                   ('waiting (unless waiting (setq waiting result))))))
             (or blocked waiting (list :kind 'ready)))))
      (walk (plist-get task :depends) (list (plist-get task :id))))))

(defun org-dispatch--dependency-block (task)
  "Handoff for TASK's immediate prerequisites, read fresh at launch."
  (when (plist-get task :depends)
    (let ((index (org-dispatch--dependency-index)))
      (concat "** Dependencies\nThese prerequisites reached DONE. Their notes are context, not new permissions.\n\n"
              (mapconcat
               (lambda (ref)
                 (let ((node (gethash (substring ref 3) index)))
                   (format "*** %s\n- ID: %s\n- File: %s\n- State: %s\n- Finish note: %s\n\n%s\n"
                           (plist-get node :heading) ref (plist-get node :file)
                           (plist-get node :todo) (or (plist-get node :note) "Not recorded.")
                           (or (plist-get node :outcome) "No Outcome section recorded."))))
               (plist-get task :depends) "\n")))))

;;; Plan queuing

(defun org-dispatch--plan-id (key name)
  "Stable UUID for NAME in the plan KEY, including replay after a partial save."
  (let ((hash (secure-hash 'sha256 (concat "org-dispatch-plan:" key "\0" name))))
    (format "%s-%s-5%s-a%s-%s" (substring hash 0 8) (substring hash 8 12)
            (substring hash 12 15) (substring hash 15 18) (substring hash 18 30))))

(defun org-dispatch--plan-line (value name)
  (unless (and (stringp value) (not (string-empty-p (string-trim value)))
               (not (string-match-p "[\n\r]" value)))
    (error "%s must be one nonempty line" name))
  value)

(defun org-dispatch--plan-title (value)
  (setq value (string-trim (org-dispatch--plan-line value "title")))
  (let ((case-fold-search nil))
    (when (string-match-p "\\`\\(?:TODO\\|AUTO\\|PROG\\|EVAL\\|HOLD\\|DONE\\)\\b\\|[ \t]:[[:alnum:]_@#%:]+:$" value)
      (error "Title must not carry a state or tags")))
  value)

(defun org-dispatch--plan-target (file agenda)
  "A live, conflict-free agenda FILE inside the Org root."
  (let* ((path (file-truename (expand-file-name file (org-dispatch--org-root))))
         (name (file-name-nondirectory path)))
    (unless (and (file-in-directory-p path (org-dispatch--org-root))
                 (member path (mapcar #'file-truename agenda))
                 (file-writable-p path)
                 (string-suffix-p ".org" path)
                 (not (member name '("asana.org" "inbox.org" "archive.org")))
                 (not (string-match-p "/archive/\\|/\\.stversions/\\|\\.sync-conflict-" path)))
      (error "Not a writable agenda file: %s" file))
    (when (file-expand-wildcards
           (concat (file-name-sans-extension path) ".sync-conflict-*.org"))
      (error "Resolve Syncthing conflict copies before writing %s" path))
    path))

(defun org-dispatch--validate-graph (ids index)
  "Reject missing IDs, duplicate IDs, malformed edges, and cycles from IDS."
  (let ((visited (make-hash-table :test 'equal)))
    (cl-labels
        ((walk (id path)
           (when (member id path) (error "Dependency cycle at %s" id))
           (unless (gethash id visited)
             (let ((node (gethash id index)))
               (unless node (error "Missing dependency ID %s" id))
               (when (plist-get node :duplicate) (error "Duplicate dependency ID %s" id))
               (dolist (ref (plist-get node :depends))
                 (unless (string-match-p "\\`id:[[:alnum:]][[:alnum:]-]*\\'" ref)
                   (error "Invalid DEPENDS reference %s" ref))
                 (walk (substring ref 3) (cons id path)))
               (puthash id t visited)))))
      (mapc (lambda (id) (walk id nil)) ids))))

(defun org-dispatch--queue-plan (spec)
  "Validate SPEC, then publish its tasks and plan table. Return task IDs.
Each file is replaced atomically. A crash between files is recoverable by
replaying the same key and spec; missing prerequisites block partial plans."
  (let* ((key (org-dispatch--plan-line (alist-get 'key spec) "key"))
         (title (org-dispatch--plan-title (alist-get 'title spec)))
         (tasks (alist-get 'tasks spec))
         (hash (secure-hash 'sha256 (prin1-to-string spec)))
         (agenda (org-dispatch--agenda-files))
         (table-file (org-dispatch--plan-target (alist-get 'file spec) agenda))
         (table-id (org-dispatch--plan-id key "table"))
         (index (org-dispatch--dependency-index (org-dispatch--lookup-files agenda)))
         (names (make-hash-table :test 'equal))
         (before (make-hash-table :test 'equal))
         (texts (make-hash-table :test 'equal))
         records)
    (unless (string-match-p "\\`[[:alnum:]_-]+\\'" key) (error "key must be a plain plan name"))
    (unless (and (listp tasks) tasks) (error "tasks must be a nonempty array"))
    ;; Assign all IDs before resolving edges, including forward references.
    (dolist (task tasks)
      (let ((name (org-dispatch--plan-line (alist-get 'key task) "task key")))
        (unless (and (string-match-p "\\`[[:alnum:]_-]+\\'" name) (not (gethash name names)))
          (error "Invalid or duplicate task key %s" name))
        (puthash name (org-dispatch--plan-id key (concat "task:" name)) names)))
    (dolist (task tasks)
      (let* ((name (alist-get 'key task))
             (id (gethash name names))
             (file (org-dispatch--plan-target (alist-get 'file task) agenda))
             (heading (org-dispatch--plan-title (alist-get 'title task)))
             (body (alist-get 'body task))
             (host (or (alist-get 'host task) (org-dispatch--default "host" (car org-dispatch-hosts))))
             (agent (or (alist-get 'agent task) (org-dispatch--default "agent" "pi")))
             ;; Roster agents to choose among, in order, written as AGENTS instead.
             (agents (alist-get 'agents task))
             (dir (alist-get 'dir task))
             (review (alist-get 'review task 'yes))
             (refs (alist-get 'depends task))
             (existing (gethash id index))
             depends)
        (unless (and (stringp body) (not (string-empty-p (string-trim body)))
                     (not (string-match-p "^\\*[ \t]\\|^[ \t]*:\\(?:PROPERTIES\\|END\\):" body)))
          (error "Task body is Org text without top-level headings or property drawers"))
        (unless (member host org-dispatch-hosts) (error "Unknown host %s" host))
        (if agents
            (unless (and (listp agents) agents
                         (seq-every-p (lambda (name) (and (stringp name) (string-match-p "\\`[a-z0-9-]+\\'" name))) agents))
              (error "agents must be a list of roster agent or harness names"))
          (unless (and (member agent org-dispatch-agents) (member agent org-dispatch-launchable))
            (error "Unknown agent %s" agent)))
        (unless (or (memq review '(yes t :false)) (equal review "agent"))
          (error "review must be a boolean or \"agent\""))
        (when dir
          (org-dispatch--plan-line dir "dir")
          (unless (and (or (file-name-absolute-p dir) (string-prefix-p "~/" dir))
                       (file-directory-p (expand-file-name dir)))
            (error "dir must be an existing absolute or ~/ directory")))
        (unless (listp refs) (error "depends must be an array"))
        (dolist (ref refs)
          (let ((dependency (and (stringp ref) (gethash ref names))))
            (push (if dependency (concat "id:" dependency) ref) depends)))
        (setq depends (delete-dups (nreverse depends)))
        (when (and existing (not (equal (plist-get existing :plan-hash) hash)))
          (error "Plan key %s already exists with a different spec or conflicting ID" key))
        ;; Existing headings keep their state, edits, and archive location on replay.
        (unless existing
          (puthash id (list :id id :file file :heading heading :todo "AUTO" :depends depends) index))
        (push (list :id id :file (if existing (plist-get existing :file) file)
                    :heading heading :depends depends :existing existing
                    :text (format "* AUTO %s\n:PROPERTIES:\n:ID: %s\n:HOST: %s\n%s\n:PLAN_REQUEST: %s\n:PLAN_HASH: %s\n%s%s%s:END:\n%s\n"
                                  heading id host
                                  (if agents (concat ":AGENTS: " (string-join (append agents nil) " ")) (concat ":AGENT: " agent))
                                  key hash
                                  (if dir (concat ":DIR: " dir "\n") "")
                                  (cond ((eq review :false) ":REVIEW: no\n")
                                        ((equal review "agent") ":REVIEW: agent\n")
                                        (t ""))
                                  (if depends (concat ":DEPENDS: " (string-join depends " ") "\n") "")
                                  (string-trim body))) records)))
    (setq records (nreverse records))
    (org-dispatch--validate-graph (mapcar (lambda (task) (plist-get task :id)) records) index)
    (when-let* ((table (gethash table-id index)))
      (unless (equal (plist-get table :plan-hash) hash)
        (error "Plan key %s already exists with a different spec" key)))
    (cl-labels
        ((insert-entry (file text)
           (let ((content (or (gethash file texts)
                              (let ((original (with-temp-buffer (insert-file-contents file) (buffer-string))))
                                (puthash file original before) original))))
             (with-temp-buffer
               (insert content)
               (goto-char (point-min))
               (if (re-search-forward "^\\* " nil t) (goto-char (match-beginning 0))
                 (goto-char (point-max)))
               (skip-chars-backward "\n")
               (delete-region (point) (progn (skip-chars-forward "\n") (point)))
               (unless (bobp) (insert "\n\n"))
               (insert text)
               (unless (eobp) (insert "\n"))
               (puthash file (buffer-string) texts)))))
      ;; Reverse insertion keeps the spec order, with its table above the tasks.
      (dolist (task (reverse records))
        (unless (plist-get task :existing)
          (insert-entry (plist-get task :file) (plist-get task :text))))
      (unless (gethash table-id index)
        (insert-entry
         table-file
         (format "* %s\n:PROPERTIES:\n:ID: %s\n:PLAN_HASH: %s\n:END:\n| Task | ID | Depends on |\n|------+----+------------|\n%s\n"
                 (replace-regexp-in-string "|" " " title t t) table-id hash
                 (mapconcat (lambda (task)
                              (format "| %s | [[id:%s][%s]] | %s |"
                                      (replace-regexp-in-string "|" " " (plist-get task :heading) t t)
                                      (plist-get task :id) (plist-get task :id)
                                      (string-join (plist-get task :depends) ", ")))
                            records "\n")))))
    ;; Check every snapshot before the first write, and again before each rename.
    (maphash (lambda (file original)
               (unless (equal original (with-temp-buffer (insert-file-contents file) (buffer-string)))
                 (error "%s changed while preparing the plan; replay to retry" file))) before)
    (maphash
     (lambda (file text)
       (let ((temp (make-temp-file (expand-file-name ".org-dispatch-plan-" (file-name-directory file)))))
         (unwind-protect
             (progn
               (with-temp-file temp (insert text))
               (set-file-modes temp (file-modes file))
               (unless (equal (gethash file before)
                              (with-temp-buffer (insert-file-contents file) (buffer-string)))
                 (error "%s changed before publishing the plan; replay to retry" file))
               (rename-file temp file t))
           (when (file-exists-p temp) (delete-file temp))))) texts)
    (mapcar (lambda (task) (list :id (plist-get task :id) :file (plist-get task :file))) records)))

(defun org-dispatch-plan ()
  "Queue a JSON plan SPEC supplied on the command line. Does not launch agents."
  (let ((file (pop command-line-args-left)))
    (unless (and file (null command-line-args-left)) (error "usage: org-dispatch plan SPEC.json"))
    (let ((spec (with-temp-buffer
                  (insert-file-contents file)
                  (json-parse-buffer :object-type 'alist :array-type 'list :false-object :false))))
      (princ (json-serialize (vconcat (org-dispatch--queue-plan spec))))
      (princ "\n"))))

;;; Local state

(defun org-dispatch--write-json (file object)
  "Write OBJECT to FILE as UTF-8 JSON, decoding the serializer's bytes first."
  (let ((coding-system-for-write 'utf-8-unix))
    (with-temp-file file
      (insert (decode-coding-string (json-serialize object) 'utf-8)))))

(defun org-dispatch--state-file (id)
  (expand-file-name (concat id ".json") org-dispatch-state-dir))

(defun org-dispatch--states ()
  (when (file-directory-p org-dispatch-state-dir)
    (mapcar (lambda (file)
              (with-temp-buffer
                (insert-file-contents file)
                (json-parse-buffer :object-type 'plist :null-object nil :false-object nil)))
            (directory-files org-dispatch-state-dir t "\\`[0-9a-f-]+\\.json\\'"))))

(defun org-dispatch--save-state (state)
  (make-directory org-dispatch-state-dir t)
  (let ((temp (make-temp-file (expand-file-name ".state-" org-dispatch-state-dir))))
    (unwind-protect
        (progn
          (org-dispatch--write-json temp state)
          (rename-file temp (org-dispatch--state-file (plist-get state :id)) t))
      (when (file-exists-p temp) (delete-file temp)))))

(defun org-dispatch--drop-state (id)
  (ignore-errors (delete-file (org-dispatch--state-file id))))

(defun org-dispatch--check-stopped-task (&optional worker)
  "Refuse unconfirmed stops, or WORKER writes from a stopped or superseded run.
A worker is identified by its terminal, HC_TERMINAL_ID: while a run is active,
only that run's terminal may finish, retry or change the task."
  (let* ((request (org-entry-get nil "JUNE_STOP_REQUEST"))
         (file (org-dispatch--state-file (org-entry-get nil "ID")))
         (state (and (file-exists-p file)
                     (with-temp-buffer (insert-file-contents file)
                                       (json-parse-buffer :object-type 'plist))))
         (status (plist-get state :status))
         (caller (getenv "HC_TERMINAL_ID")))
    (when (equal status "launch-uncertain")
      (error "launch ownership is uncertain; Jon must inspect the task, hc and child processes before recovery"))
    (when (or (and request (not (equal request (org-entry-get nil "JUNE_STOPPED"))))
              (equal status "stopping")
              (and worker request (not (equal status "running"))))
      (error "task stop is pending or completed; inspect before resuming, never finish or retry this run"))
    (when (and worker caller state (plist-get state :terminal)
               (or request (member status '("starting" "running")))
               (not (equal caller (plist-get state :terminal))))
      (error "this worker is not the task's current dispatcher terminal"))
    (when (and request (not worker) (equal status "stopped"))
      (let ((status (org-dispatch--status (org-dispatch--stop-terminal state))))
        (when (and status (not (member status '("idle" "done"))))
          (error "stopped worker is active or unknown again; inspect before resuming"))))))

(defun org-dispatch--stop-terminal (state)
  "STATE's live worker terminal, refusing ambiguous or altered identities.
Nil when no live terminal carries STATE's session. A live terminal at the run's
own address that no longer carries its labels is an error, not an exit."
  (let* ((session (plist-get state :session))
         (matches (seq-filter #'org-dispatch--live-p
                              (org-dispatch--session-terminals session (plist-get state :host))))
         (terminal (and (car matches) (org-dispatch--hc "get" (alist-get 'address (car matches)))))
         (own (and (plist-get state :terminal) (plist-get state :run)
                   (org-dispatch--terminal (plist-get state :terminal)))))
    (when (cdr matches) (error "session appears in %d live terminals; stop remains unconfirmed" (length matches)))
    (when (and (org-dispatch--live-p own) (not (org-dispatch--owns-p state own)))
      (error "terminal %s no longer carries this run's labels; stop remains unconfirmed"
             (plist-get state :terminal)))
    (when (and terminal (not (equal (org-dispatch--label terminal 'org.agent) (plist-get state :agent))))
      (error "session agent changed; stop remains unconfirmed"))
    (when (and terminal (plist-get state :run)
               (not (equal (org-dispatch--label terminal 'org.run) (plist-get state :run))))
      (error "session runs in a terminal from another dispatch run; stop remains unconfirmed"))
    terminal))

(defun org-dispatch--settle (address &optional seconds)
  "Poll ADDRESS for up to SECONDS until it reads settled or gone twice running.
Return its last status."
  (let ((polls (* 2 (or seconds 15))) (settled 0) status)
    (while (progn
             (setq status (org-dispatch--status (org-dispatch--terminal address)))
             (setq settled (if (member status '("idle" "done" nil)) (1+ settled) 0))
             (and (< settled 2) (> (setq polls (1- polls)) 0)))
      (sleep-for 0.5))
    status))

(defun org-dispatch--confirm-settled (state)
  "Confirm STATE's session is settled or gone, sending it nothing."
  (let* ((terminal (org-dispatch--stop-terminal state))
         (status (org-dispatch--status terminal)))
    (when (member status '("working" "blocked" "unknown"))
      (setq status (org-dispatch--settle (alist-get 'address terminal) 5)))
    (unless (member status '("idle" "done" nil))
      (error "worker %s is %s; stop it before continuing" (alist-get 'address terminal) status))))

(defun org-dispatch--interrupt-session (state)
  "Stop STATE's worker and return what happened, once it is known.
Checks the terminal's identity labels first, presses its stop key, waits, and
kills that one terminal only when the agent does not stop. Never touches a
terminal from another run. Returns \"gone\", \"settled\" (it was not working),
\"interrupted\" or \"killed\"; signals an error while the result is unknown."
  (let* ((terminal (org-dispatch--stop-terminal state))
         (address (alist-get 'address terminal))
         (status (org-dispatch--status terminal)))
    (cond
     ((null status) "gone")
     ((member status '("idle" "done")) "settled")
     (t
      (org-dispatch--hc "interrupt" address)
      (setq status (org-dispatch--settle address 15))
      (if (member status '("idle" "done" nil))
          "interrupted"
        ;; Recheck identity: the kill must land on the same run's terminal.
        (unless (equal (org-dispatch--owner (org-dispatch--terminal address))
                       (org-dispatch--owner terminal))
          (error "terminal %s changed owner; stop remains unconfirmed" address))
        (org-dispatch--hc "kill" address)
        (setq status (org-dispatch--status (org-dispatch--terminal address)))
        (when status (error "terminal %s is still %s after kill; stop remains unconfirmed" address status))
        "killed")))))

;;; Prompts

(defun org-dispatch--git-p (dir)
  (eq 0 (call-process "git" nil nil nil "-C" dir "rev-parse" "--git-dir")))

(defun org-dispatch--policy (task)
  (when-let* ((err (alist-get 'error (plist-get task :live-content)))) (error "%s" err))
  (string-join
   (delq nil
         (list
          (cond
           ((and (plist-get task :agent-review) (not (plist-get task :review-loop)))
            "- An independent agent reviews this task's exact commit when you finish with EVAL; never finish DONE. Commit all of this task's work and leave the worktree clean: the review starts from HEAD. If it finds in-scope problems, this task comes back to you with them. Say in Outcome which checks only Jon can do, such as taste or hardware.")
           ((plist-get task :review)
            "- Jon or an agent he delegates reviews this task. Finish with EVAL, never DONE.")
           (t
            "- No separate review is required. Finish with DONE once agent-run checks verify the requested work. Use EVAL only for a remaining review that genuinely needs human judgment, eyes, or physical checks; name it explicitly."))
          (let ((where (if (org-dispatch--git-p (plist-get task :dir))
                           "your work"
                         "your work in each repository you change"))
                (branch (plist-get task :branch)))
            (if (or (org-dispatch--git-p (plist-get task :dir)) (plist-get task :repos))
                (if branch
                    (format "- Commit %s and push it to the branch =%s=, not the default branch, unless the task itself says not to."
                            where branch)
                  (format "- Commit %s and push it to the current branch, unless the task itself says not to." where))
              "- No repository belongs to this task; there is nothing to commit."))
          (if-let* ((grant (plist-get task :live-content)))
              (format (concat "- Scoped live-content authorization, already approved by Jon: do not ask again for these unchanged actions.\n"
                              "  - Target: %s\n  - Allowed content operations: %s\n  - Limits: %s\n"
                              "  - This approval supersedes older manual-only, ask-before-production and no-deploy wording only for these named content operations. Preserve all backup, current-content reconciliation, rollback and verification requirements. Hold if scope or approval is unclear or materially changed.\n"
                              "  - Do not deploy code, push a database, activate, or install anything system-wide. Theme/plugin deployments and unrelated live changes remain forbidden. This grant does not waive review or permit client communications.")
                      (alist-get 'target grant) (alist-get 'actions grant) (alist-get 'limits grant))
            (if (plist-get task :deploy)
                "- Deploying is allowed when the task calls for it."
              "- Do not deploy, activate, or install anything system-wide."))
          (when (plist-get task :repeat)
            (concat "- This task repeats. The heading body is standing instructions: do not edit it"
                    " or add Scope, Checklist, or other sections. The finish note becomes the run's"
                    " log entry: one short sentence on what changed, or just \"No change.\""
                    " Do not list the checks you ran."))))
   "\n"))

(defun org-dispatch--retry-rule (task)
  "Prompt text offering a retry when Jon allowed one on TASK."
  (if (or (plist-get task :repeat) (< (or (plist-get task :retry) 0) 1))
      ""
    (format (concat "- The task waits on something outside your control that a later run can\n"
                    "  check, or it asks you to reschedule: run\n"
                    "  =org-dispatch retry %s WHEN \"what it waits for\"=. WHEN is an Org\n"
                    "  date such as =+1d 06:00= or =2026-10-20 06:00=. This sets SCHEDULED and\n"
                    "  returns the task to AUTO, and a fresh session picks it up then; Jon\n"
                    "  allowed %d more retr%s. Do not edit SCHEDULED by hand, since that\n"
                    "  leaves the task out of the queue. Update the task record in place\n"
                    "  rather than adding a section per run.\n")
            (plist-get task :id) (plist-get task :retry)
            (if (= (plist-get task :retry) 1) "y" "ies"))))

(defun org-dispatch--render (name task &optional extra)
  "Fill prompt template NAME for TASK. EXTRA is an alist of more placeholders."
  (let ((text (with-temp-buffer
                (insert-file-contents (expand-file-name (concat name ".org") org-dispatch-prompts))
                (buffer-string)))
        (values (append
                 `(("ID" . ,(plist-get task :id))
                   ("FILE" . ,(abbreviate-file-name (plist-get task :file)))
                   ("HEADING" . ,(plist-get task :heading))
                   ("DIR" . ,(abbreviate-file-name (plist-get task :dir)))
                   ("POLICY" . ,(org-dispatch--policy task))
                   ("RETRY" . ,(org-dispatch--retry-rule task))
                   ("DEPENDENCIES" . ,(org-dispatch--dependency-block task)))
                 extra)))
    (dolist (pair values text)
      (setq text (string-replace (format "{{%s}}" (car pair)) (or (cdr pair) "") text)))))

(defun org-dispatch--dialog-block (task resumed)
  (cond ((not resumed) "")
        ((plist-get task :dialog)
         (concat "Jon set this task back to AUTO. New Dialog entries since your last one:\n\n"
                 "#+begin_quote\n" (plist-get task :dialog) "\n#+end_quote\n"))
        (t "Jon set this task back to AUTO without replying. Proceed with the default you stated.\n")))

;;; Launching

(defun org-dispatch--validate-headline (headline)
  "Return HEADLINE unchanged, or reject text that is not one plain line."
  (unless (and (not (string-empty-p headline))
               (equal headline (string-trim headline))
               (not (string-match-p "[\n\r]" headline)))
    (error "--headline needs one non-empty line without surrounding whitespace"))
  headline)

(defun org-dispatch--headline (headline signal)
  "Bind HEADLINE to SIGNAL and this write, or clear the previous report."
  (if headline
      (progn
        (org-entry-put nil "HEADLINE" headline)
        (org-entry-put nil "HEADLINE_STATE" signal)
        (org-entry-put nil "HEADLINE_AT" (number-to-string (float-time))))
    (dolist (property '("HEADLINE" "HEADLINE_STATE" "HEADLINE_AT"))
      (org-entry-delete nil property))))

(defun org-dispatch--claim (task terminal session)
  "Mark TASK in progress and link SESSION in TERMINAL, in one edit.
Without a TERMINAL, as when its launcher could not start, nothing is linked."
  (let* ((agent (plist-get task :agent))
         (link (format "herdr:%s/%s:%s" org-dispatch-host agent session)))
    (org-dispatch--edit
     (plist-get task :file) (plist-get task :id)
     (lambda ()
       (org-entry-put nil "ID" (plist-get task :id))
       ;; Written once, so tags no longer decide where or how the task runs.
       (pcase-dolist (`(,property . ,value) (plist-get task :fill))
         (unless (org-entry-get nil property) (org-entry-put nil property value)))
       (pcase-dolist (`(,property . ,value) (plist-get task :set))
         (org-entry-put nil property value))
       ;; Org resets a repeat to TODO, which is Jon's; keep it AUTO. Also trim
       ;; here: a reviewed repeat is closed in Emacs, not by finish.
       (when (plist-get task :repeat)
         (org-entry-put nil "REPEAT_TO_STATE" "AUTO")
         (org-dispatch--trim-log (plist-get task :id)))
       (org-entry-delete nil "DISPATCH_FINISH")
       (org-dispatch--headline nil nil)
       (org-todo "PROG")
       (org-toggle-tag "auto" 'on)
       (unless (or (null terminal)
                   (let ((section (org-dispatch--section-bounds "Sessions")))
                 (and section (string-search (concat link "@" terminal)
                                             (buffer-substring-no-properties
                                              (car section) (cdr section))))))
         (org-dispatch--append
          "Sessions"
          (format "- [[%s@%s][%s@%s/%s]]" link terminal agent org-dispatch-host
                  (format-time-string "%Y-%m-%dT%H%M")))))
     (plist-get task :heading))))

(defun org-dispatch--prompt (state text)
  "Send TEXT to STATE's worker after checking its identity.
hc refuses to type into a blocked dialog."
  (let ((terminal (org-dispatch--worker state)))
    (unless terminal (error "task %s has no live worker to prompt" (plist-get state :id)))
    (org-dispatch--hc "send" (alist-get 'address terminal) text)))

(defun org-dispatch--agent-argv (task command resume session prompt)
  "The argv that starts TASK's agent with COMMAND in SESSION, taking PROMPT first.
RESUME names the session to continue; nil starts SESSION fresh."
  (let ((agent (plist-get task :agent))
        (label (truncate-string-to-width (concat "auto · " (plist-get task :heading)) 60)))
    (pcase agent
      ;; Codex resumes through a subcommand, its options after it, and names
      ;; its own sessions, found once it starts (org-dispatch--find-session).
      ("codex"
       (append (list command) (when resume (list "resume"))
               (list "--dangerously-bypass-approvals-and-sandbox")
               (when (plist-get task :model) (list "--model" (plist-get task :model)))
               (org-dispatch--card-flags agent (plist-get task :card))
               (when resume (list resume))
               (list prompt)))
      ;; Antigravity's wrapper skips permissions already; it has no
      ;; instructions flag, so a card's instructions lead the prompt.
      ("agy"
       (let ((text (alist-get 'instructions (plist-get task :card))))
         (append (list command)
                 (when (plist-get task :model) (list "--model" (plist-get task :model)))
                 (org-dispatch--card-flags agent (plist-get task :card))
                 (when resume (list "--conversation" resume))
                 (list "--prompt-interactive"
                       (if (and text (not (string-empty-p text))) (concat text "\n\n" prompt) prompt)))))
      (_
       (append
        (list command)
        (if (equal agent "claude")
            ;; CLAUDE_CODE_DISABLE_TERMINAL_TITLE also turns off Claude's OSC 7501
            ;; status, which the watcher needs; clear it for this worker only.
            (list "--dangerously-skip-permissions"
                  "--settings" "{\"env\":{\"CLAUDE_CODE_DISABLE_TERMINAL_TITLE\":\"\"}}")
          (list "--no-approve"))
        (list "--name" label)
        (when (plist-get task :model) (list "--model" (plist-get task :model)))
        (org-dispatch--card-flags agent (plist-get task :card))
        (cond ((and resume (equal agent "claude")) (list "--resume" resume))
              (resume (list "--session" (or (org-dispatch--session-file resume) resume)))
              (t (list "--session-id" session)))
        (list prompt))))))

(defun org-dispatch--card-flags (agent card)
  "AGENT's flags for roster CARD's effort and instructions.
The card's model comes through the task's :model."
  (let ((effort (alist-get 'effort card))
        (instructions (alist-get 'instructions card)))
    (pcase agent
      ("codex"
       (append
        (when effort (list "-c" (format "model_reasoning_effort=%S" (if (equal effort "max") "xhigh" effort))))
        (when (and instructions (not (string-empty-p instructions)))
          (list "-c" (concat "developer_instructions=" (json-serialize instructions))))))
      ;; Its instructions lead the prompt instead.
      ("agy" (when effort (list "--effort" effort)))
      (_
       (append
        (when effort (list (if (equal agent "pi") "--thinking" "--effort") effort))
        (when (and instructions (not (string-empty-p instructions)))
          (list "--append-system-prompt" instructions)))))))

(defun org-dispatch--find-session (agent dir since)
  "The session AGENT started in DIR after SINCE (float time), or nil.
Codex and Antigravity pick their own IDs: Codex names its working directory
in each session log's first line; an Antigravity conversation database
mentions it."
  (pcase agent
    ("codex"
     (seq-some (lambda (file)
                 (and (time-less-p (seconds-to-time (- since 5)) (file-attribute-modification-time (file-attributes file)))
                      (with-temp-buffer
                        (insert-file-contents file nil 0 65536)
                        (goto-char (point-min))
                        (let ((meta (ignore-errors
                                      (json-parse-string (buffer-substring (point) (line-end-position))
                                                         :object-type 'alist))))
                          (and (equal (alist-get 'cwd (alist-get 'payload meta)) dir)
                               (alist-get 'id (alist-get 'payload meta)))))))
               (sort (file-expand-wildcards (expand-file-name "~/.codex/sessions/*/*/*/rollout-*.jsonl"))
                     #'file-newer-than-file-p)))
    ("agy"
     (seq-some (lambda (file)
                 (and (time-less-p (seconds-to-time (- since 5)) (file-attribute-modification-time (file-attributes file)))
                      (with-temp-buffer
                        (set-buffer-multibyte nil)
                        (insert-file-contents-literally file)
                        (when (file-exists-p (concat file "-wal")) (insert-file-contents-literally (concat file "-wal")))
                        (search-forward (encode-coding-string dir 'utf-8) nil t))
                      (file-name-base file)))
               (sort (file-expand-wildcards (expand-file-name "~/.gemini/antigravity-cli/conversations/*.db"))
                     #'file-newer-than-file-p)))))

(defun org-dispatch--await-session (state agent dir since)
  "STATE with the session AGENT started in DIR, once it shows within 30 s.
The terminal is relabelled with it; STATE is unchanged when none shows."
  (let ((deadline (+ (float-time) 30)) found)
    (while (and (not (setq found (org-dispatch--find-session agent dir since)))
                (< (float-time) deadline))
      (sleep-for 1))
    (if (not found)
        (progn (org-dispatch--log "%s at %s: no session found; the task restarts fresh if resumed" agent (plist-get state :terminal))
               state)
      (org-dispatch--hc "label" (plist-get state :terminal) (concat "org.session=" found))
      (plist-put state :session found))))

(defun org-dispatch--await-start (address agent)
  "Wait until the worker at ADDRESS reports a status, or fail.
A blocked startup is an error for the caller to hold; no status after a minute
is accepted as unknown, which the watcher never mistakes for idle."
  (let ((deadline (+ (float-time) 60)) status)
    (while (progn
             (let ((terminal (org-dispatch--terminal address)))
               (unless (org-dispatch--live-p terminal)
                 (error "%s exited during startup (code %s)" agent (alist-get 'exit_code terminal)))
               (setq status (org-dispatch--get terminal 'status 'state)))
             (and (null status) (< (float-time) deadline)))
      (sleep-for 0.5))
    (when (equal status "blocked") (error "%s is blocked during startup" agent))
    (or status
        (progn (org-dispatch--log "%s at %s reports no status; watching it as unknown" agent address)
               "unknown"))))

(defun org-dispatch--launch (task)
  "Start or resume TASK's agent in hc and claim it. Return non-nil on success."
  ;; Eligibility is only a snapshot. Recheck before starting anything.
  (let ((current (ignore-errors
                   (org-dispatch--edit (plist-get task :file) (plist-get task :id)
                                       #'org-dispatch--task (plist-get task :heading)))))
    (when (and (equal (plist-get current :todo) "AUTO")
               (eq (plist-get (org-dispatch--dependencies current) :kind) 'ready))
      (setq task (plist-put (copy-sequence task) :depends (plist-get current :depends)))
      (let* ((id (or (plist-get task :id) (org-id-new)))
             (task (plist-put (copy-sequence task) :id id))
             (agent (plist-get task :agent))
             (resume (plist-get task :session))
             ;; The session continues in a terminal that still runs it; otherwise
             ;; a new terminal reopens it, or starts a session chosen here.
             (live (and resume (org-dispatch--live-session resume agent)))
             (session (or resume (org-id-uuid)))
             (run (org-id-uuid))
             ;; A closed Claude session resumes through its own account's
             ;; launcher; a custom chooser such as claude-auto may pick another.
             (native (and resume (not live) (equal agent "claude")
                          (org-dispatch--claude-launcher resume)))
             (custom (unless (or live native) (org-dispatch--command agent)))
             (command (or native custom agent))
             ;; A custom launcher may choose another account. June's account
             ;; folders share ~/.claude's session store, so a session there
             ;; resumes on any of them; one only in a separate store restarts
             ;; from the Org record.
             (fresh (and resume custom
                         (not (and (equal agent "claude")
                                   (org-dispatch--shared-claude-session-p resume)))))
             (name (format "auto-%s-%s" (org-dispatch--id8 id) (format-time-string "%H%M%S")))
             (state (list :id id :file (plist-get task :file) :heading (plist-get task :heading)
                          :dir (plist-get task :dir) :agent agent :status "starting"
                          :host org-dispatch-host :run run
                          :session (if fresh (org-id-uuid) session)
                          :review-loop (if (plist-get task :review-loop) 1 0)
                          :started (float-time) :nudges 0
                          :repeat (if (plist-get task :repeat) 1 0)))
             ;; What a later switch to another account needs to start the same agent.
             (state (append state
                            (when (plist-get task :model) (list :model (plist-get task :model)))
                            (when (plist-get task :card) (list :card (json-serialize (plist-get task :card))))))
             (prompt (org-dispatch--render
                      "task" task `(("DIALOG" . ,(concat
                                                 (when fresh
                                                   "This is a fresh session, not a native resume. Read the whole Org task and Dialog before continuing.\n\n")
                                                 (org-dispatch--dialog-block task resume))))))
             address)
        (when live
          ;; Adopt the running terminal: it becomes this run's worker.
          (setq state (plist-put state :session resume)))
        (org-dispatch--save-state state)
        (condition-case err
            (progn
              (if live
                  (progn
                    (setq address live)
                    (org-dispatch--hc "label" address (concat "org.dispatch=" org-dispatch-host)
                                      (concat "org.task=" id) (concat "org.run=" run)
                                      (concat "org.agent=" agent) (concat "org.session=" resume)
                                      (concat "june.agent=" (or (alist-get 'slug (plist-get task :card)) "")))
                    (setq state (plist-put state :terminal address))
                    (org-dispatch--save-state state)
                    (org-dispatch--prompt state prompt))
                (let* ((space (org-dispatch--space (file-name-base (plist-get task :file))))
                       (started (apply #'org-dispatch--hc "run" "--bg" "--no-parent" "--name" name
                                       "--cwd" (plist-get task :dir)
                                       "--label" (concat "org.dispatch=" org-dispatch-host)
                                       "--label" (concat "org.task=" id)
                                       "--label" (concat "org.run=" run)
                                       "--label" (concat "org.agent=" agent)
                                       "--label" (concat "org.session=" (plist-get state :session))
                                       (append
                                        (when space (list "--label" (concat "herdr.space=" space)))
                                        ;; The roster agent's, so June shows it busy while it works here.
                                        (let ((slug (alist-get 'slug (plist-get task :card))))
                                          (when slug (list "--label" (concat "june.agent=" slug))))
                                        (list "--")
                                        (org-dispatch--agent-argv
                                         task command (and (not fresh) resume)
                                         (plist-get state :session) prompt)))))
                  (setq address (alist-get 'address started))
                  (unless address (error "hc run returned no terminal address"))
                  (setq state (plist-put state :terminal address))
                  (org-dispatch--save-state state)
                  (org-dispatch--await-start address agent)
                  (when (and (member agent '("codex" "agy")) (not (and resume (not fresh))))
                    (setq state (org-dispatch--await-session state agent (plist-get task :dir) (plist-get state :started)))
                    (org-dispatch--save-state state))))
              (org-dispatch--claim task address (plist-get state :session))
              (setq state (plist-put state :status "running"))
              (org-dispatch--save-state state)
              (org-dispatch--log "%s %s: %s in %s" (cond (fresh "restarted") (resume "resumed") (t "launched"))
                                 id (plist-get task :heading) address)
              t)
          (error
           ;; Blocked dialogs and failed launchers need attention, not another
           ;; terminal every tick when quota is exhausted or a command is wrong.
           (let ((reason (org-dispatch--reason err)))
             (cond
              ((plist-get task :review-loop)
               (org-dispatch--uncertain-launch state reason))
              (address
               (org-dispatch--claim task address (plist-get state :session))
               (org-dispatch--park
                state (format "%s did not start cleanly in hc terminal %s on %s: %s. Inspect it with hc read %s before resuming."
                              agent address org-dispatch-host reason address)))
              ;; A launcher hc cannot run is wrong until someone fixes it.
              ((and (eq (car err) 'org-dispatch-hc) (equal (org-dispatch--hc-kind err) "spawn_failed"))
               (org-dispatch--claim task nil nil)
               (org-dispatch--park state (format "%s could not start on %s: %s" command org-dispatch-host reason)))
              ;; hc itself failing, such as a stopped core, leaves the task AUTO for a later run.
              (t (org-dispatch--drop-state id)))
             (org-dispatch--log "launch failed for %s: %s" (plist-get task :heading) reason))
           nil))))))

;;; Watching

(defun org-dispatch--park (state reason)
  "Hand STATE's task to Jon: EVAL, ASKED, and a Dispatcher entry giving REASON.
Not HOLD, which means the task waits on something outside."
  (org-dispatch--edit (plist-get state :file) (plist-get state :id)
                      (lambda ()
                        (org-todo "EVAL")
                        (org-dispatch--ask "Dispatcher" reason)))
  (org-dispatch--drop-state (plist-get state :id))
  (org-dispatch--notify (concat "EVAL · " (plist-get state :heading)) reason)
  (org-dispatch--log "parked %s for Jon: %s" (plist-get state :id) reason))

(defun org-dispatch--todo-state (state)
  "Current unique TODO keyword across live files and archives, else nil.
The original file may still exist after its heading has been archived."
  (plist-get (gethash (plist-get state :id) (org-dispatch--dependency-index)) :todo))

(defun org-dispatch--uncertain-launch (state reason)
  "Reserve STATE's worktree before parking an uncertain review-loop startup."
  (org-dispatch--save-state (plist-put state :status "launch-uncertain"))
  (org-dispatch--edit (plist-get state :file) (plist-get state :id)
    (lambda ()
      (unless (equal (org-get-todo-state) "HOLD")
        (org-todo "HOLD")
        ;; HOLD stays, since recovery checks depend on it, but this is Jon's to inspect.
        (org-entry-put nil "ASKED" (org-dispatch--stamp))
        (org-dispatch--append "Dialog" (org-dispatch--entry "Dispatcher"
          (concat "Review-loop launch ownership is uncertain; directory/slot remain reserved and no relaunch or terminal input is allowed. Jon must inspect hc, this receipt and child processes before recovery. " reason))))))
  (org-dispatch--notify (concat "HOLD · " (plist-get state :heading)) reason))

(defun org-dispatch--watch (state)
  (let* ((id (plist-get state :id))
         (todo (org-dispatch--todo-state state))
         ;; Only a terminal carrying this run's labels counts as its worker.
         (status (and (plist-get state :terminal) (org-dispatch--agent-status state)))
         (nudges (plist-get state :nudges)))
    (cond
     ((equal (plist-get state :status) "launch-uncertain")
      ;; Recover a crash after reserving but before the Org HOLD save.
      (unless (equal todo "HOLD") (org-dispatch--uncertain-launch state "Recovered uncertain startup receipt.")))
     ((member (plist-get state :status) '("stopping" "stopped"))
      ;; Explicit stops never nudge, expire, or touch the worker's terminal.
      nil)
     ((equal (plist-get state :status) "finished")
      ;; Keep the slot while the finished run's agent is still busy.
      (unless (member status '("working" "blocked"))
        (org-dispatch--drop-state id)))
     ((not (equal (plist-get state :status) "running"))
      ;; A launch that died part way leaves a "starting" entry behind.
      (when (> (- (float-time) (plist-get state :started)) 600)
        (if (or (eq (plist-get state :review-loop) 1)
                ;; Older starting receipts may not carry the loop marker.
                (org-dispatch--edit (plist-get state :file) id
                  (lambda () (plist-get (org-dispatch--task) :review-loop))))
            (org-dispatch--uncertain-launch state "Startup did not publish a complete worker claim within ten minutes.")
          (org-dispatch--drop-state id))))
     ((null todo)
      ;; Missing/duplicate IDs include archive copy gaps. Keep the receipt and
      ;; slot for a later pass; absence is not permission to touch the worker.
      (org-dispatch--log "waiting for unique task record: %s" id))
     ((not (equal todo "PROG"))
      ;; A state change made elsewhere is not permission to interrupt the worker.
      (ignore-errors (org-dispatch--edit (plist-get state :file) id #'org-dispatch--untag-auto))
      (org-dispatch--drop-state id))
     ((> (- (float-time) (plist-get state :started)) org-dispatch-time-limit)
      (ignore-errors (org-dispatch--hc "interrupt" (plist-get state :terminal)))
      (org-dispatch--park state (format "Interrupted after %d minutes without finishing."
                                        (/ org-dispatch-time-limit 60))))
     ((null status)
      (org-dispatch--park state (format "%s is no longer running in its hc terminal %s."
                                        (or (plist-get state :agent) "pi")
                                        (plist-get state :terminal))))
     ((equal status "blocked")
      ;; herdr-notify's event consumer tells Jon; the dispatcher only waits.
      (org-dispatch--save-state (plist-put state :idle 0)))
     ((member status '("idle" "done"))
      (let* ((idle (plist-get state :idle))
             (since (if (and idle (> idle 0)) idle (float-time))))
        (setq state (plist-put state :idle since))
        (cond
         ((< (- (float-time) since) org-dispatch-nudge-after)
          (org-dispatch--save-state state))
         ;; An agent that stopped because its account ran out continues on another.
         ((org-dispatch--out-of-quota state))
         ((>= nudges org-dispatch-max-nudges)
          (org-dispatch--park state (format "Still idle without a state change after %d nudge%s."
                                            org-dispatch-max-nudges
                                            (if (= org-dispatch-max-nudges 1) "" "s"))))
         (t
          (setq state (plist-put state :nudges (1+ nudges)))
          (setq state (plist-put state :idle 0))
          (org-dispatch--save-state state)
          (org-dispatch--prompt
           state (org-dispatch--render
                 "nudge" state `(("NUDGE" . ,(number-to-string (1+ nudges)))
                                 ("MAX" . ,(number-to-string org-dispatch-max-nudges)))))
          (org-dispatch--log "nudged %s (%d of %d)" id (1+ nudges) org-dispatch-max-nudges)))))
     ;; Working, or unknown: a worker without status is never nudged as idle.
     (t (org-dispatch--save-state (plist-put state :idle 0))))))

;;; Standing agent review

;; With REVIEW agent, Jon has delegated an independent review of every exact
;; commit the worker finishes at EVAL, with in-scope fixes returned to the same
;; worker: the loop in org-review.el, which June otherwise starts for him each
;; time. Each run starts a review for a development task that is settled at
;; EVAL, and advances one whose reviewer has recorded a verdict. Anything the
;; loop refuses, or a fixes round without a new commit, goes to Jon as EVAL with
;; ASKED and a Dispatcher entry; it never retries on its own.

(declare-function org-review--git "org-review" (dir &rest args))
(declare-function org-review--start "org-review" (spec))
(declare-function org-review--advance "org-review" (spec))

(defconst org-dispatch--directory
  (file-name-directory (or load-file-name buffer-file-name default-directory)))

(defun org-dispatch--require-review ()
  "Load org-review.el from the edit directory beside this file."
  (unless (featurep 'org-review)
    (add-to-list 'load-path (expand-file-name "../edit" org-dispatch--directory))
    (require 'org-review)))

(defun org-dispatch--revision ()
  "The read revision org-edit and June use for the entry at point."
  (secure-hash 'sha256 (encode-coding-string
                        (replace-regexp-in-string "\n+\\'" "" (org-dispatch--subtree-text)) 'utf-8)))

(defun org-dispatch--loop ()
  "This development task's live review state, or nil: :phase, :round, :commit
and :review, from its properties (see org-review.el), or the JSON older loops
kept in DEV_REVIEW."
  (cond
   ((org-entry-get nil "REVIEW_PHASE")
    (list :phase (org-entry-get nil "REVIEW_PHASE")
          :round (string-to-number (or (org-entry-get nil "REVIEW_ROUND") "0"))
          :commit (org-entry-get nil "REVIEW_COMMIT")
          :review (org-entry-get nil "REVIEW_TASK")))
   ((org-entry-get nil "DEV_REVIEW")
    (ignore-errors (json-parse-string (org-entry-get nil "DEV_REVIEW") :object-type 'plist
                                      :array-type 'list :null-object nil :false-object :false)))))

(defun org-dispatch--review-spec (task commit)
  "The standing contract for TASK's first review of COMMIT."
  (let* (;; pi by default: Claude Code stops at its trust prompt in each new snapshot.
         (reviewer (or (org-entry-get nil "REVIEWER") "pi"))
         (checks (or (org-entry-get nil "REVIEW_CHECKS")
                     "Check the work against the task's Scope and Checklist: run the project's tests and checks, try the edge cases and failure paths it names or implies, and confirm the commit holds only this task's changes."))
         (human (seq-remove #'string-empty-p
                            (mapcar #'string-trim (split-string (or (org-entry-get nil "REVIEW_HUMAN") "") ";")))))
    (list :revision (org-dispatch--revision) :commit commit
          :authorization "Standing agent review: this task's REVIEW is agent, which Jon sets."
          :permissions (format "Reviewer: read-only apart from local test artifacts and its own review record. Developer, for fixes: %s, %s. A verdict grants no activation or deployment."
                               (if (plist-get task :branch)
                                   (format "commit and push to %s as the task allows" (plist-get task :branch))
                                 "commit and push as the task allows")
                               (if (plist-get task :deploy) "and deploy when the task calls for it" "and no deployment"))
          :checks checks :human human :agent reviewer)))

(defun org-dispatch--review-work (file)
  "What the standing reviews in FILE need on this host: (start . ID),
(advance . PARENT-ID) or (park PARENT-ID . REASON). Read-only."
  (let (work)
    (with-temp-buffer
      (insert-file-contents file)
      (setq buffer-file-name file)
      (org-mode)
      (org-map-entries
       (lambda ()
         (let ((id (org-entry-get nil "ID")) (parent (org-entry-get nil "REVIEW_PARENT")))
           (when (and id (equal (org-get-todo-state) "EVAL")
                      (not (org-entry-get nil "ASKED"))
                      ;; Each host runs only its own loops: Org syncs everywhere,
                      ;; but the repository, snapshot and worker are on HOST.
                      (equal (org-entry-get nil "HOST") org-dispatch-host)
                      ;; A run still holding its slot is not settled yet.
                      (not (file-exists-p (org-dispatch--state-file id))))
             (if parent
                 (save-excursion
                   (let ((verdict (or (org-entry-get nil "REVIEW_VERDICT") (org-entry-get nil "REVIEW_RESULT"))))
                     (when-let* ((at (org-find-property "ID" parent)))
                       (goto-char at)
                       (let ((loop (org-dispatch--loop)))
                         (when (and (eq (org-dispatch--review-mode) 'agent)
                                    (equal (plist-get loop :phase) "review")
                                    (equal (plist-get loop :review) id))
                           (push (if verdict (cons 'advance parent)
                                   (cons 'park (cons parent "the reviewer finished without recording a verdict")))
                                 work))))))
               (let ((task (org-dispatch--task)))
                 (when (and (plist-get task :agent-review)
                            (equal (plist-get task :host) org-dispatch-host)
                            (not (plist-get task :repeat))
                            (member (plist-get (org-dispatch--loop) :phase) '(nil "fixes")))
                   (push (cons 'start id) work)))))))))
    (nreverse work)))

(defun org-dispatch--edit-or-revert (file id function)
  "Call FUNCTION at ID in FILE and save; on an error, save nothing."
  (org-dispatch--edit file id
                      (lambda ()
                        (condition-case err (funcall function)
                          (error (set-buffer-modified-p nil)
                                 (signal (car err) (cdr err)))))))

(defun org-dispatch--review-start (file id)
  (org-dispatch--edit-or-revert
   file id
   (lambda ()
     (let* ((task (org-dispatch--task))
            (dir (or (plist-get task :dir) (error "the task has no directory to review")))
            (commit (org-review--git dir "rev-parse" "HEAD"))
            (loop (org-dispatch--loop)))
       (when (and loop (equal commit (plist-get loop :commit)))
         (error "the fixes for round %d finished without a new commit" (plist-get loop :round)))
       (setq loop (org-review--start (org-dispatch--review-spec task commit)))
       (org-dispatch--log "started agent review round %d of %s at %s" (plist-get loop :round) id commit)))))

(defun org-dispatch--review-advance (file parent)
  (let ((loop (org-dispatch--edit-or-revert
               file parent
               (lambda ()
                 (org-review--advance (list :commit (plist-get (org-dispatch--loop) :commit)
                                            :revision (org-dispatch--revision)))))))
    (org-dispatch--log "agent review of %s: %s" parent (plist-get loop :phase))
    (pcase (plist-get loop :phase)
      ("accepted" (org-dispatch--notify (concat "DONE · " parent) "The agent review passed; no human checks remained."))
      ("human" (org-dispatch--notify (concat "EVAL · " parent) (concat "The agent review passed; Jon's checks remain: " (string-join (plist-get loop :human) "; "))))
      ("escalated" (org-dispatch--notify (concat "ASK · " parent) "The agent review needs Jon's decision.")))))

(defun org-dispatch--review-park (file id reason)
  "Hand the development task ID to Jon, once, with REASON."
  (org-dispatch--edit file id
                      (lambda ()
                        (unless (org-entry-get nil "ASKED")
                          (org-dispatch--ask "Dispatcher" (format "Agent review stopped: %s. Jon decides how to continue." reason)))))
  (org-dispatch--notify (concat "ASK · " id) (concat "Agent review stopped: " reason))
  (org-dispatch--log "agent review of %s stopped: %s" id reason))

(defvar org-review-author)

(defun org-dispatch--agent-reviews (&optional agenda)
  "Start and advance standing agent reviews in AGENDA on this host."
  (let ((org-review-author "Dispatcher")
        (files (seq-filter (lambda (file)
                             (with-temp-buffer
                               (insert-file-contents file)
                               (re-search-forward "^\\*+ EVAL " nil t)))
                           (or agenda (org-dispatch--agenda-files)))))
    (dolist (file files)
      (dolist (item (org-dispatch--review-work file))
        (when (equal (car item) 'park)
          (org-dispatch--review-park file (cadr item) (cddr item)))
        (unless (equal (car item) 'park)
          (org-dispatch--require-review)
          (condition-case err
              (if (equal (car item) 'start)
                  (org-dispatch--review-start file (cdr item))
                (org-dispatch--review-advance file (cdr item)))
            (error (org-dispatch--review-park file (cdr item) (error-message-string err)))))))))

;;; Worker retirement

;; The dispatcher labels each worker org.dispatch=HOST with its task, run,
;; agent and session. A finished task's worker is retired, killed and removed,
;; only when those labels, the task's Org session link and an unchanged
;; observation from the previous run all agree, after one last read. Input
;; reaching the terminal between that read and the kill is lost with the turn it
;; started. Saved history is never touched; the Org link reopens the session.

(defun org-dispatch--retirement-records (agenda &optional needles)
  "Read task identities and local session links across AGENDA and archives.
Include ID-less tasks as blockers. Nested task links can conservatively count
as shared; links never establish dispatcher ownership. With NEEDLES, parse
only files whose text contains one of those strings."
  (let (records)
    (dolist (file (org-dispatch--lookup-files agenda))
      (with-temp-buffer
        (insert-file-contents file)
        (when (or (null needles)
                  (seq-some (lambda (needle) (save-excursion (goto-char (point-min)) (search-forward needle nil t)))
                            needles))
          (setq buffer-file-name file)
          (org-mode)
          (let ((hash (secure-hash 'sha256 (current-buffer)))
                (conflict (file-expand-wildcards
                           (concat (file-name-sans-extension file) ".sync-conflict-*.org"))))
            (org-map-entries
             (lambda ()
               (when (or (org-entry-get nil "ID") (org-get-todo-state))
                 (let ((text (org-dispatch--subtree-text)) (start 0) sessions)
                   (while (string-match
                           (concat "herdr:" (regexp-quote org-dispatch-host)
                                   "/\\(pi\\|claude\\):\\([0-9a-f-]+\\)\\(?:@[^] \n]+\\)?\\]") text start)
                     (push (cons (match-string 1 text) (match-string 2 text)) sessions)
                     (setq start (match-end 0)))
                   (push (list :id (org-entry-get nil "ID") :file file :hash hash
                               :todo (org-get-todo-state) :repeat (and (org-get-repeat) t)
                               :review-loop (and (or (org-entry-get nil "DEV_REVIEW") (org-entry-get nil "REVIEW_PHASE")
                                                     (org-entry-get nil "REVIEW_PARENT")) t)
                               :conflict (and conflict t) :sessions (delete-dups sessions))
                         records)))))))))
    (nreverse records)))

(defun org-dispatch--worker-observation (terminal)
  "Identity and lifecycle fields of a worker TERMINAL that must not change."
  (list (alist-get 'address terminal) (alist-get 'state terminal)
        (org-dispatch--owner terminal) (org-dispatch--get terminal 'status 'state)
        (alist-get 'turn terminal) (alist-get 'status_ms terminal) (alist-get 'pid terminal)))

(defun org-dispatch--id8 (id)
  (let ((hex (replace-regexp-in-string "[^0-9a-f]" "" (or id ""))))
    (and (>= (length hex) 8) (substring hex 0 8))))

(defun org-dispatch--reopenable (session)
  "Non-nil when SESSION (AGENT . UUID) can be reopened from its Org link."
  (pcase (car session)
    ("pi" (org-dispatch--session-file (cdr session)))
    ("claude" (or (org-dispatch--claude-launcher (cdr session))
                  (org-dispatch--shared-claude-session-p (cdr session))))
    ("codex" (file-expand-wildcards (format (expand-file-name "~/.codex/sessions/*/*/*/rollout-*-%s.jsonl") (cdr session))))
    ("agy" (file-exists-p (expand-file-name (concat (cdr session) ".db") "~/.gemini/antigravity-cli/conversations")))))

(defun org-dispatch--retire-file ()
  (expand-file-name "retire.json" org-dispatch-state-dir))

(defun org-dispatch--retire-seen ()
  "Observations of eligible workers saved by the previous enabled run.
An unreadable file counts as none, which only restarts the wait."
  (let ((file (org-dispatch--retire-file)))
    (when (file-readable-p file)
      (ignore-errors
        (with-temp-buffer
          (insert-file-contents file)
          (append (json-parse-buffer :object-type 'alist :array-type 'list
                                     :null-object nil :false-object nil)
                  nil))))))

(defun org-dispatch--retire-save (rows)
  (make-directory org-dispatch-state-dir t)
  (let ((temp (make-temp-file (expand-file-name ".retire-" org-dispatch-state-dir))))
    (unwind-protect
        (progn
          (org-dispatch--write-json
           temp (vconcat (mapcar (lambda (row) (vconcat (mapcar (lambda (v) (if (listp v) (vconcat v) (or v :null)))
                                                              (plist-get row :observation))))
                                 rows)))
          (rename-file temp (org-dispatch--retire-file) t))
      (when (file-exists-p temp) (delete-file temp)))))

(defun org-dispatch--normal-observation (observation)
  "OBSERVATION as it reads back from retire.json, for comparison."
  (mapcar (lambda (v) (if (vectorp v) (append v nil) v)) observation))

(defun org-dispatch--workers ()
  "This host's dispatcher workers, live, with full records."
  (let ((rows (org-dispatch--get (org-dispatch--hc "ls" "--label" (concat "org.dispatch=" org-dispatch-host))
                                 'terminals)))
    (unless (vectorp rows) (error "hc did not return a terminal list"))
    ;; Copies, so each observation is a snapshot of the moment it was read.
    (delq nil (mapcar (lambda (row) (copy-tree (org-dispatch--terminal (alist-get 'address row)) t)) rows))))

(defun org-dispatch--reconcile-panes (agenda &optional seen)
  "Classify live dispatcher workers for retirement without changing anything.
Each row is :eligible when every check passes on this run, and :stable when
SEEN, the previous run's observations, holds the same observation."
  (let* ((workers (org-dispatch--workers))
         (needles (delete-dups (delq nil (mapcan (lambda (terminal)
                                                   (list (org-dispatch--label terminal 'org.task)
                                                         (org-dispatch--label terminal 'org.session)))
                                                 workers))))
         (records (and needles (org-dispatch--retirement-records agenda needles)))
         (states (org-dispatch--states))
         (again (org-dispatch--workers))
         (changed (and needles (not (equal records (org-dispatch--retirement-records agenda needles)))))
         (seen (mapcar #'org-dispatch--normal-observation seen))
         rows)
    (dolist (terminal workers)
      (pcase-let* ((address (alist-get 'address terminal))
                   (`(,task-id ,run ,agent ,uuid) (org-dispatch--owner terminal))
                   (session (and agent uuid (cons agent uuid)))
                   (tasks (and task-id (seq-filter (lambda (record) (equal task-id (plist-get record :id))) records)))
                   (task (car tasks))
                   (status (org-dispatch--status terminal))
                   (observation (org-dispatch--normal-observation (org-dispatch--worker-observation terminal)))
                   (reasons nil))
        (unless (and task-id run session) (push "missing dispatcher identity labels" reasons))
        (when (and task-id run session)
          (unless tasks (push "no task with this worker's ID" reasons))
          (when (cdr tasks) (push "duplicate task ID" reasons))
          (when task
            (unless (member session (plist-get task :sessions)) (push "task does not link this session" reasons))
            (unless (equal (plist-get task :todo) "DONE")
              (push (concat "task is " (or (plist-get task :todo) "without TODO state")) reasons))
            (when (plist-get task :repeat) (push "repeating task has future runs" reasons))
            (when (plist-get task :review-loop) (push "linked review workflow needs coordinator" reasons))
            (when (plist-get task :conflict) (push "task file has a Syncthing conflict copy" reasons)))
          (when (seq-find (lambda (record) (and (not (equal (plist-get record :id) task-id))
                                                (member session (plist-get record :sessions))))
                          records)
            (push "session shared by another task record" reasons))
          (unless (org-dispatch--reopenable session)
            (push "saved session cannot be reopened from its link" reasons)))
        (unless (member status '("idle" "done"))
          (push (concat "agent is " (or status "gone")) reasons))
        (when (and uuid (> (seq-count (lambda (other) (equal (org-dispatch--label other 'org.session) uuid)) workers) 1))
          (push "session appears in multiple live terminals" reasons))
        (when (seq-find (lambda (state) (and (member (plist-get state :status) '("starting" "running" "stopping" "stopped"))
                                             (or (equal (plist-get state :terminal) address)
                                                 (and uuid (equal (plist-get state :session) uuid)))))
                        states)
          (push "terminal belongs to an active dispatcher run" reasons))
        (when changed (push "Org records changed during inventory" reasons))
        (unless (equal observation
                       (org-dispatch--normal-observation
                        (org-dispatch--worker-observation
                         (seq-find (lambda (other) (equal (alist-get 'address other) address)) again))))
          (push "worker identity or lifecycle changed during inventory" reasons))
        (let ((eligible (null reasons))
              (stable (and (member observation seen) t)))
          (when (and eligible (not stable))
            (push "not yet seen unchanged by a previous run" reasons))
          (push (list :terminal address :agent agent :session uuid :run run :status status
                      :eligible eligible :stable stable :close (and eligible stable)
                      :tasks (vconcat (mapcar (lambda (task)
                                               (list :id (plist-get task :id) :file (plist-get task :file)
                                                     :todo (plist-get task :todo))) tasks))
                      :skip (vconcat (delete-dups (nreverse reasons)))
                      :observation observation)
                rows))))
    (nreverse rows)))

(defun org-dispatch--retire-panes (agenda)
  "Kill and remove workers eligible and unchanged since the previous run.
Run only under the dispatcher lock, which June's Org commands share. Save this
run's eligible observations for the next one. Return the retired rows."
  (let* ((rows (org-dispatch--reconcile-panes agenda (org-dispatch--retire-seen)))
         (eligible (seq-filter (lambda (row) (plist-get row :eligible)) rows))
         closed)
    ;; Save first: a crash below must not let a later run skip the second look.
    (org-dispatch--retire-save (seq-remove (lambda (row) (plist-get row :close)) eligible))
    (dolist (row eligible)
      (when (plist-get row :close)
        (condition-case err
            (let* ((address (plist-get row :terminal))
                   (now (org-dispatch--terminal address)))
              (if (not (equal (org-dispatch--normal-observation (org-dispatch--worker-observation now))
                              (plist-get row :observation)))
                  (org-dispatch--log "kept worker %s: changed at the final check" address)
                (org-dispatch--hc "kill" address)
                (ignore-errors (org-dispatch--hc "rm" address))
                (push row closed)
                (org-dispatch--log "retired worker %s for DONE task %s; reopen with herdr-link attach herdr:%s/%s:%s"
                                   address (plist-get (aref (plist-get row :tasks) 0) :id)
                                   org-dispatch-host (plist-get row :agent) (plist-get row :session))))
          (error (org-dispatch--log "kept worker %s: %s" (plist-get row :terminal)
                                    (error-message-string err))))))
    (nreverse closed)))

(defun org-dispatch--retire-enabled ()
  "Non-nil when June's config sets dispatch.retire to true."
  (eq (org-dispatch--default "retire" nil) t))

(defun org-dispatch-reconcile ()
  "Print the retirement inventory, using saved observations. Change nothing."
  (unless (equal command-line-args-left '("--dry-run"))
    (error "only reconcile --dry-run is supported; enabled runs retire workers"))
  (setq command-line-args-left nil)
  (let ((agenda (let ((standard-output #'external-debugging-output))
                  (org-dispatch--agenda-files t))))
    (princ (json-serialize
            (vconcat (mapcar (lambda (row)
                               (let ((row (org-plist-delete (copy-sequence row) :observation)))
                                 (dolist (key '(:eligible :stable :close))
                                   (setq row (plist-put row key (if (plist-get row key) t :false))))
                                 (dolist (key '(:terminal :agent :session :run :status))
                                   (setq row (plist-put row key (or (plist-get row key) :null))))
                                 (plist-put row :tasks
                                            (vconcat (mapcar (lambda (task)
                                                               (plist-put (copy-sequence task) :id
                                                                          (or (plist-get task :id) :null)))
                                                             (plist-get row :tasks))))))
                             (org-dispatch--reconcile-panes agenda (org-dispatch--retire-seen))))))
    (princ "\n")))

;;; Entry points

(defun org-dispatch--pending-file ()
  (expand-file-name "pending.json" org-dispatch-state-dir))

(defun org-dispatch--worktree (dir)
  "Git worktree root for DIR, or DIR itself outside Git."
  (or (and dir (file-directory-p dir)
           (with-temp-buffer
             (when (eq 0 (call-process "git" nil '(t nil) nil "-C" dir "rev-parse" "--show-toplevel"))
               (string-trim (buffer-string))))) dir))

(defun org-dispatch--same-dir-p (a b)
  "Whether A and B share a worktree or a non-Git directory, including aliases."
  (let ((a (org-dispatch--worktree a)) (b (org-dispatch--worktree b)))
    (or (equal a b) (and a b (file-equal-p a b)))))

(defun org-dispatch--eligible (tasks states &optional dry-run)
  "TASKS this host may launch now, respecting STATES already running.
A task launches only after its text stays unchanged for
`org-dispatch-settle' seconds, so a heading still being typed waits.
June writes a whole heading at once and marks it with JUNE_REQUEST,
so hers launch without settling.
DRY-RUN marks waiting tasks with :waiting instead of recording progress."
  (let* ((now (float-time))
         (file (org-dispatch--pending-file))
         (old (if (file-exists-p file)
                  (with-temp-buffer (insert-file-contents file) (json-parse-buffer))
                (make-hash-table :test 'equal)))
         (new (make-hash-table :test 'equal))
         (running (seq-filter (lambda (s) (member (plist-get s :status) '("running" "starting" "stopping" "launch-uncertain")))
                              states))
         (index (when (seq-some (lambda (task) (plist-get task :depends)) tasks)
                  (org-dispatch--dependency-index)))
         eligible reports taken)
    (dolist (task tasks)
      (let* ((key (or (plist-get task :id)
                      (concat (plist-get task :file) "::" (plist-get task :heading))))
             (seen (gethash key old))
             (same (and seen (equal (gethash "hash" seen) (plist-get task :hash))))
             (entry (if same seen
                      (let ((entry (make-hash-table :test 'equal)))
                        (puthash "hash" (plist-get task :hash) entry)
                        (puthash "seen" now entry)
                        (when seen (puthash "dependency" (gethash "dependency" seen) entry))
                        entry))))
        (cond
         ((plist-get task :problem)
          (unless same
            (org-dispatch--log "skipped %s: %s" (plist-get task :heading) (plist-get task :problem)))
          (puthash key entry new))
         ((not (equal (plist-get task :host) org-dispatch-host)))
         ((and (plist-get task :agent) (not (member (plist-get task :agent) org-dispatch-launchable)))
          (unless same
            (org-dispatch--log "skipped %s: AGENT %s cannot be launched yet"
                               (plist-get task :heading) (plist-get task :agent)))
          (puthash key entry new))
         ;; Record text before checking SCHEDULED, so a task written ahead of
         ;; time starts on schedule instead of settling then.
         ((progn (puthash key entry new) nil))
         ((let* ((dependency (org-dispatch--dependencies task index))
                 (kind (plist-get dependency :kind))
                 (reason (plist-get dependency :reason))
                 (notice (gethash "dependency" entry)))
            (if (eq kind 'ready)
                (progn (remhash "dependency" entry) nil)
              (when dry-run
                (push (plist-put (copy-sequence task) :dependency
                                 (format "%s on %s" kind reason)) reports))
              (when (and (not dry-run) (eq kind 'blocked) (not (equal notice reason)))
                (org-dispatch--notify (concat "Blocked · " (plist-get task :heading)) reason)
                (org-dispatch--log "blocked %s: %s" (plist-get task :heading) reason))
              (if (eq kind 'blocked) (puthash "dependency" reason entry)
                (remhash "dependency" entry))
              t)))
         ((and (plist-get task :scheduled) (time-less-p now (plist-get task :scheduled))))
         ((seq-find (lambda (s) (equal (plist-get s :id) (plist-get task :id))) running))
         ((and (not (plist-get task :june))
               (< (- now (gethash "seen" entry))
                  (or org-dispatch-settle (org-dispatch--default "settle" 120))))
          (when dry-run (push (plist-put task :waiting t) eligible)))
         ((seq-find (lambda (s) (org-dispatch--same-dir-p (plist-get s :dir) (plist-get task :dir)))
                    (append running eligible)))
         ((>= (+ (length running) (length eligible)) org-dispatch-max-agents))
         ;; Last, so June is asked only for a task that would launch now.
         (t (let ((chosen (org-dispatch--choose task taken)))
              (if (plist-get chosen :wait)
                  (let ((reason (plist-get chosen :wait)))
                    (when dry-run
                      (push (plist-put (copy-sequence task) :dependency (concat "no agent: " reason)) reports))
                    (unless (or dry-run (equal (gethash "roster" entry) reason))
                      (org-dispatch--log "waiting %s: %s" (plist-get task :heading) reason))
                    (puthash "roster" reason entry))
                (remhash "roster" entry)
                (let ((slug (alist-get 'slug (plist-get chosen :card))))
                  (when slug (push slug taken)))
                (push chosen eligible)))))))
    (unless dry-run
      (make-directory org-dispatch-state-dir t)
      (org-dispatch--write-json file new))
    (append (nreverse eligible) (nreverse reports))))

(defvar org-dispatch-lock-wait 5
  "Seconds a run waits for the dispatcher lock before skipping a pass.
June's board edits hold it for milliseconds; another run holds it
for its whole pass.")

(defun org-dispatch--with-lock (function)
  "Call FUNCTION holding the dispatcher lock that org-edit shares.
Skip it and return nil when the lock stays taken for
`org-dispatch-lock-wait' seconds. A separate flock process holds it,
closing its descriptor before its command, so nothing this run starts
inherits the lock, and the lock goes when that process or Emacs ends."
  (let* ((file (expand-file-name "org-dispatch.lock" (or (getenv "XDG_RUNTIME_DIR") "/tmp")))
         (output "")
         (holder (make-process
                  :name "org-dispatch-lock" :noquery t :connection-type 'pipe
                  :command (list "flock" "--close" "-w" (number-to-string org-dispatch-lock-wait) "-E" "75" file
                                 "sh" "-c" "echo held; exec cat >/dev/null")
                  :filter (lambda (_process text) (setq output (concat output text))))))
    (while (and (process-live-p holder) (not (string-search "held" output)))
      (accept-process-output holder 0.1))
    (if (not (string-search "held" output))
        (progn (when (process-live-p holder) (delete-process holder)) nil)
      (unwind-protect (funcall function)
        (when (process-live-p holder) (delete-process holder))))))

(defun org-dispatch-run ()
  "One dispatcher pass.
Listing Jon's agenda files loads his Emacs config in a second Emacs,
a second or more, and reads no task, so it happens before the lock;
everything that reads or writes tasks happens under it."
  (let ((org-dispatch--memoize t) (org-dispatch--agenda-memo nil))
    (org-dispatch--agenda-files)
    (org-dispatch--with-lock #'org-dispatch--run-locked)))

(defun org-dispatch--run-locked ()
  "The pass under the dispatcher lock.
Watch running tasks, retire finished workers, advance agent reviews,
then launch."
  (dolist (state (org-dispatch--states))
    (condition-case err
        (org-dispatch--watch state)
      (error (org-dispatch--log "watch failed for %s: %s"
                                (plist-get state :id) (error-message-string err)))))
  ;; Before launching, so a task resumed in this run starts in a terminal it owns.
  (when (org-dispatch--retire-enabled)
    (condition-case err
        (org-dispatch--retire-panes (org-dispatch--agenda-files))
      (error (org-dispatch--log "worker retirement failed: %s" (error-message-string err)))))
  ;; Before launching, so a review it queues or fixes it returns start in this run.
  (condition-case err
      (org-dispatch--agent-reviews)
    (error (org-dispatch--log "agent reviews failed: %s" (error-message-string err))))
  (dolist (task (org-dispatch--eligible (org-dispatch--tasks) (org-dispatch--states)))
    (org-dispatch--launch task)))

(defun org-dispatch-scan ()
  (dolist (task (org-dispatch--eligible (org-dispatch--tasks) (org-dispatch--states) t))
    (princ (format "%s\t%s\t%s\n" (plist-get task :heading)
                   (abbreviate-file-name (plist-get task :dir))
                   (cond ((plist-get task :dependency))
                         ((plist-get task :waiting) "settling")
                         ((plist-get task :session) "resume")
                         (t "new"))))))

(defun org-dispatch-finish ()
  "Finish a task: ID STATE [NOTE] [--headline LINE] from the command line.
STATE is EVAL, DONE, HOLD (waiting on something outside, NOTE says what), or
ASK (a question for Jon in NOTE, recorded in Dialog with the task at EVAL)."
  (let* ((id (pop command-line-args-left))
         (todo (upcase (or (pop command-line-args-left) "")))
         (flag (member "--headline" command-line-args-left))
         (headline (when flag
                     (unless (= (length flag) 2)
                       (error "--headline needs one non-empty line after the note"))
                     (org-dispatch--validate-headline (cadr flag))))
         (note (string-trim (string-join
                             (if flag (butlast command-line-args-left 2) command-line-args-left) " ")))
         (file (or (org-dispatch--find id) (error "no heading with ID %s" id)))
         (state-file (org-dispatch--state-file id))
         (state (and (file-exists-p state-file)
                     (with-temp-buffer
                       (insert-file-contents state-file)
                       (json-parse-buffer :object-type 'plist :null-object nil :false-object nil))))
         result)
    (setq command-line-args-left nil)
    (unless (member todo '("EVAL" "ASK" "HOLD" "DONE"))
      (error "STATE must be EVAL, ASK, HOLD, or DONE"))
    (when (and (equal todo "ASK") (string-empty-p note))
      (error "ASK needs the question for Jon"))
    (when (and (equal todo "HOLD") (string-empty-p note))
      (error "HOLD needs what the task waits for"))
    (setq result
          (org-dispatch--edit
           file id
           (lambda ()
             (org-dispatch--check-stopped-task t)
             (let ((task (org-dispatch--task))
                   (ask (equal todo "ASK")))
               (when (and (equal todo "DONE")
                          (or (plist-get task :review) (org-dispatch--in-loop-p)
                              (org-entry-get nil "REVIEW_PARENT")))
                 (setq todo "EVAL"))
               (when ask (setq todo "EVAL"))
               (cond
                (ask nil)
                ((equal todo "HOLD")
                 (org-dispatch--append "Dialog" (org-dispatch--entry "Agent" note)))
                ((and (equal todo "DONE") (plist-get task :repeat))
                 (org-dispatch--remove-section "Dialog")
                 (org-dispatch--log-run id "DONE" (plist-get task :todo) note)))
               (unless (string-empty-p note)
                 (org-entry-put nil "DISPATCH_FINISH" (replace-regexp-in-string "[\n\r]+" " " note)))
               (org-dispatch--headline headline todo)
               (org-todo todo)
               ;; A plain EVAL is ready for review; only a question asks Jon.
               (org-entry-delete nil "ASKED")
               (when ask (org-dispatch--ask "Agent" note))
               (if ask "EVAL (asked)" (org-get-todo-state))))))
    (when state
      (org-dispatch--save-state (plist-put state :status "finished")))
    (org-dispatch--notify (format "%s · %s" (if (equal result "EVAL (asked)") "ASK" todo) (or (plist-get state :heading) id))
                          (if (string-empty-p note) "Finished." note)
                          (and (plist-get state :terminal)
                               (format "herdr:%s/%s:%s@%s" org-dispatch-host (plist-get state :agent)
                                       (plist-get state :session) (plist-get state :terminal))))
    (princ (format "%s is now %s\n" id result))
    (setq result (car (split-string result)))
    (when (equal result "AUTO")
      (princ "The repeat was logged and the next run is scheduled.\n"))))

;; Only Jon sets AUTO. His RETRY property lets a run hand the task back to a
;; later date, a set number of times, when it waits on something it cannot change.
(defun org-dispatch-retry ()
  "Reschedule a running task: ID WHEN NOTE from the command line."
  (let* ((id (pop command-line-args-left))
         (when-text (string-trim (or (pop command-line-args-left) "")))
         (note (string-trim (string-join command-line-args-left " ")))
         (file (or (org-dispatch--find id) (error "no heading with ID %s" id)))
         (state-file (org-dispatch--state-file id))
         (state (and (file-exists-p state-file)
                     (with-temp-buffer
                       (insert-file-contents state-file)
                       (json-parse-buffer :object-type 'plist :null-object nil :false-object nil))))
         (time (if (string-empty-p when-text)
                   (error "WHEN is missing, such as +1d 06:00")
                 (org-read-date nil t when-text)))
         ;; Batch org-read-date never sets this; without a time, use the date.
         (org-time-was-given (string-match-p "[0-9]:[0-5][0-9]" when-text))
         (time (if org-time-was-given time (org-read-date nil t (format-time-string "%F" time))))
         (stamp (format-time-string (if org-time-was-given "%F %a %H:%M" "%F %a") time))
         left)
    (setq command-line-args-left nil)
    (when (string-empty-p note)
      (error "retry needs a note saying what the task waits for"))
    (when (time-less-p time (time-add nil org-dispatch-retry-min))
      (error "<%s> is less than %d minutes away" stamp (/ org-dispatch-retry-min 60)))
    (org-dispatch--edit
     file id
     (lambda ()
       (org-dispatch--check-stopped-task t)
       (let ((task (org-dispatch--task)))
         (unless (equal (plist-get task :todo) "PROG")
           (error "only a running task can retry; this one is %s" (plist-get task :todo)))
         (when (plist-get task :repeat)
           (error "a repeating task recurs on its own; finish it with DONE"))
         (when (< (plist-get task :retry) 1)
           (error "Jon allowed no more retries; finish with ASK or HOLD instead"))
         (setq left (1- (plist-get task :retry)))
         (org-entry-put nil "RETRY" (number-to-string left))
         ;; A string keeps the time; a time value loses it when nothing was scheduled.
         (org-entry-put nil "SCHEDULED" (format "<%s>" stamp))
         (org-dispatch--log-run id "AUTO" "PROG" (format "Retry <%s>: %s" stamp note))
         (org-todo "AUTO"))))
    (when state
      (org-dispatch--save-state (plist-put state :status "finished")))
    (org-dispatch--log "retry %s at <%s>, %d left: %s" id stamp left note)
    (princ (format "%s is now AUTO, scheduled for <%s> with %d retr%s left\n"
                   id stamp left (if (= left 1) "y" "ies")))))

(provide 'org-dispatch)
;;; org-dispatch.el ends here
