;;; org-dispatch.el --- Run autonomous Org tasks with pi or Claude in Herdr  -*- lexical-binding: t; -*-

;; Batch entry points:
;;   org-dispatch-run      watch running tasks, then launch eligible ones
;;   org-dispatch-scan     print the tasks this host would launch
;;   org-dispatch-plan     SPEC.json, queue a requested plan without starting agents
;;   org-dispatch-finish   ID STATE [NOTE] [--headline LINE], used by the agent to end its task
;;   org-dispatch-retry    ID WHEN NOTE, used by the agent to try again later
;;
;; A task is an AUTO heading in Jon's Org agenda files whose HOST is this host.
;; HOST and AGENT live in its property drawer; when either is missing, one tag
;; naming a known host or agent fills it, else June's configured default, and
;; the dispatcher writes it when it claims the task, as it does ID. Once set,
;; tags are decoration. SCHEDULED delays a task; a repeater makes it recur.
;; Other settings are properties: REVIEW, DEPLOY, BRANCH, MODEL, DIR, and
;; RETRY, the number of times an agent may return the task to AUTO later.
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
  (split-string (org-dispatch--env "ORG_DISPATCH_AGENTS" "pi claude"))
  "Agents a task may name in AGENT or a tag.")
(defconst org-dispatch-launchable '("pi" "claude")
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

(defun org-dispatch--log (format-string &rest args)
  (princ (concat (format-time-string "%F %T ") (apply #'format format-string args) "\n")))

;;; Herdr

(defun org-dispatch--herdr (&rest args)
  "Run herdr with ARGS in the default session and return parsed JSON."
  (let ((stderr (make-temp-file "org-dispatch")))
    (unwind-protect
        (with-temp-buffer
          (let ((exit (apply #'call-process "herdr" nil (list t stderr) nil
                             "--session" "default" args)))
            (unless (eq exit 0)
              (error "herdr %s: %s" (string-join args " ")
                     (string-trim (concat (buffer-string)
                                          (with-temp-buffer
                                            (insert-file-contents stderr)
                                            (buffer-string))))))
            (goto-char (point-min))
            (unless (eobp)
              (json-parse-buffer :object-type 'alist :null-object nil :false-object nil))))
      (delete-file stderr))))

(defun org-dispatch--get (object &rest keys)
  (dolist (key keys object)
    (setq object (alist-get key object))))

(defun org-dispatch--agent-status (pane)
  "Return PANE's agent status, or nil when no agent runs there."
  (ignore-errors
    (org-dispatch--get (org-dispatch--herdr "agent" "get" pane) 'result 'agent 'agent_status)))

(defun org-dispatch--pane-session (pane agent)
  "Return AGENT's session UUID running in PANE, waiting briefly for Herdr."
  (let (uuid)
    (dotimes (_ 20)
      (unless uuid
        (let* ((session (org-dispatch--get (org-dispatch--herdr "pane" "get" pane)
                                          'result 'pane 'agent_session))
               (value (alist-get 'value session))
               (pattern (if (equal agent "claude")
                            "\\`\\([0-9a-f]\\{8\\}-[0-9a-f-]\\{27\\}\\)\\'"
                          "\\([0-9a-f]\\{8\\}-[0-9a-f-]\\{27\\}\\)\\.jsonl\\'")))
          (if (and (equal (alist-get 'agent session) agent)
                   value (string-match pattern value))
              (setq uuid (match-string 1 value))
            (sleep-for 0.5)))))
    (or uuid (error "no %s session reported for %s" agent pane))))

(defun org-dispatch--live-pane (uuid kind)
  "Return the pane where KIND's session UUID is running, if any."
  (seq-some (lambda (agent)
              (and (equal (org-dispatch--get agent 'agent) kind)
                   (string-search uuid (or (org-dispatch--get agent 'agent_session 'value) ""))
                   (org-dispatch--get agent 'pane_id)))
            (org-dispatch--get (org-dispatch--herdr "agent" "list") 'result 'agents)))

(defun org-dispatch--project-pane (dir label project)
  "Open a tab named LABEL in DIR in workspace PROJECT and return its root pane.
Create the workspace when it is missing; its first tab then hosts the task."
  (let* ((workspace (seq-some (lambda (ws)
                                (and (string-match-p
                                      (concat "\\`\\(?:\\[[0-9]+\\] \\)?" (regexp-quote project) "\\'")
                                      (or (alist-get 'label ws) ""))
                                     (alist-get 'workspace_id ws)))
                              (org-dispatch--get (org-dispatch--herdr "workspace" "list")
                                                 'result 'workspaces)))
         (pane (org-dispatch--get
                (if workspace
                    (org-dispatch--herdr "tab" "create" "--workspace" workspace "--cwd" dir
                                         "--label" label "--no-focus")
                  (org-dispatch--herdr "workspace" "create" "--cwd" dir
                                       "--label" project "--no-focus"))
                'result 'root_pane)))
    (unless workspace
      (org-dispatch--herdr "tab" "rename" (alist-get 'tab_id pane) label))
    pane))

(defun org-dispatch--session-file (uuid)
  (car (append (file-expand-wildcards
                (format "~/.local/state/pi/sessions/*/*_%s.jsonl" uuid) t)
               (file-expand-wildcards
                (format "~/.pi/agent/sessions/*/*_%s.jsonl" uuid) t))))

(defun org-dispatch--notify (title body)
  (ignore-errors
    (org-dispatch--herdr "notification" "show" title "--body" body "--sound" "request")))

;;; Org

(defun org-dispatch--agenda-files ()
  "Jon's `org-agenda-files', read by loading his Emacs config in batch.
Cache the list, and reuse the last good one when the config fails to load,
so a half-edited config does not stop dispatching."
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
        (progn
          (setq files (nreverse files))
          (make-directory org-dispatch-state-dir t)
          (with-temp-file cache (insert (string-join files "\n"))))
      (org-dispatch--log "could not read org-agenda-files from %s; using %s"
                         org-dispatch-emacs-init
                         (if (file-exists-p cache) "the cached list" org-dispatch-root))
      (setq files (if (file-exists-p cache)
                      (with-temp-buffer
                        (insert-file-contents cache)
                        (split-string (buffer-string) "\n" t))
                    (directory-files-recursively
                     org-dispatch-root "\\.org\\'" nil
                     (lambda (dir) (not (string-prefix-p "." (file-name-nondirectory dir))))))))
    (seq-filter (lambda (file)
                  (and (file-regular-p file)
                       (not (string-search ".sync-conflict-" file))))
                files)))

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
has none of FALLBACK's type."
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
          (t fallback))))

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

(defun org-dispatch--task ()
  "Describe the entry at point."
  (let* ((host (org-dispatch--resolve "HOST" org-dispatch-hosts
                                      (org-dispatch--default "host" (car org-dispatch-hosts))))
         (agent (org-dispatch--resolve "AGENT" org-dispatch-agents
                                       (org-dispatch--default "agent" "pi")))
         (section (org-dispatch--section-bounds "Sessions"))
         (dir (org-entry-get nil "DIR"))
         sessions)
    ;; Only the Sessions section names this run's sessions; LOGBOOK holds past runs.
    (when section
      (save-excursion
        (goto-char (car section))
        (while (re-search-forward
                (format "herdr:%s/%s:\\([0-9a-f-]+\\)"
                        (regexp-quote org-dispatch-host)
                        (regexp-quote (or (plist-get agent :value) "")))
                (cdr section) t)
          (push (match-string 1) sessions))))
    (list :file buffer-file-name
          :id (org-entry-get nil "ID")
          :heading (org-get-heading t t t t)
          :todo (org-get-todo-state)
          :host (plist-get host :value)
          :agent (plist-get agent :value)
          :problem (or (plist-get host :problem) (plist-get agent :problem))
          :fill (append (when (plist-get agent :fill) (list (cons "AGENT" (plist-get agent :value))))
                        (when (plist-get host :fill) (list (cons "HOST" (plist-get host :value)))))
          :scheduled (org-get-scheduled-time (point))
          :repeat (org-get-repeat)
          :depends (split-string (or (org-entry-get nil "DEPENDS") ""))
          :retry (string-to-number (or (org-entry-get nil "RETRY") "0"))
          :june (or (org-entry-get nil "JUNE_REQUEST") (org-entry-get nil "PLAN_REQUEST"))
          :review (not (equal (downcase (or (org-entry-get nil "REVIEW") "yes")) "no"))
          :deploy (equal (downcase (or (org-entry-get nil "DEPLOY") "no")) "yes")
          :branch (org-entry-get nil "BRANCH")
          :model (or (org-entry-get nil "MODEL")
                     (when (equal (plist-get agent :value) "pi") org-dispatch-model))
          :dir (if dir (expand-file-name dir) (org-dispatch--project-dir buffer-file-name))
          :repos (org-dispatch--project-repos buffer-file-name)
          :session (car sessions)
          :dialog (org-dispatch--new-dialog)
          :hash (secure-hash 'sha1 (org-dispatch--subtree-text)))))

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
             (dir (alist-get 'dir task))
             (review (alist-get 'review task 'yes))
             (refs (alist-get 'depends task))
             (existing (gethash id index))
             depends)
        (unless (and (stringp body) (not (string-empty-p (string-trim body)))
                     (not (string-match-p "^\\*[ \t]\\|^[ \t]*:\\(?:PROPERTIES\\|END\\):" body)))
          (error "Task body is Org text without top-level headings or property drawers"))
        (unless (member host org-dispatch-hosts) (error "Unknown host %s" host))
        (unless (and (member agent org-dispatch-agents) (member agent org-dispatch-launchable))
          (error "Unknown agent %s" agent))
        (unless (memq review '(yes t :false)) (error "review must be a boolean"))
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
                    :text (format "* AUTO %s\n:PROPERTIES:\n:ID: %s\n:HOST: %s\n:AGENT: %s\n:PLAN_REQUEST: %s\n:PLAN_HASH: %s\n%s%s%s:END:\n%s\n"
                                  heading id host agent key hash
                                  (if dir (concat ":DIR: " dir "\n") "")
                                  (if (eq review :false) ":REVIEW: no\n" "")
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
  (with-temp-file (org-dispatch--state-file (plist-get state :id))
    (insert (json-serialize state))))

(defun org-dispatch--drop-state (id)
  (ignore-errors (delete-file (org-dispatch--state-file id))))

;;; Prompts

(defun org-dispatch--git-p (dir)
  (eq 0 (call-process "git" nil nil nil "-C" dir "rev-parse" "--git-dir")))

(defun org-dispatch--policy (task)
  (string-join
   (delq nil
         (list
          (if (plist-get task :review)
              "- Jon or an agent he delegates reviews this task. Finish with EVAL, never DONE."
            "- No separate review is required. Finish with DONE once agent-run checks verify the requested work. Use EVAL only for a remaining review that genuinely needs human judgment, eyes, or physical checks; name it explicitly.")
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
          (if (plist-get task :deploy)
              "- Deploying is allowed when the task calls for it."
            "- Do not deploy, activate, or install anything system-wide.")
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

(defun org-dispatch--claim (task pane session)
  "Mark TASK in progress and link SESSION when available, in one edit."
  (let* ((agent (plist-get task :agent))
         (link (format "herdr:%s/%s:%s" org-dispatch-host agent session)))
    (org-dispatch--edit
     (plist-get task :file) (plist-get task :id)
     (lambda ()
       (org-entry-put nil "ID" (plist-get task :id))
       ;; Written once, so tags no longer decide where or how the task runs.
       (pcase-dolist (`(,property . ,value) (plist-get task :fill))
         (unless (org-entry-get nil property) (org-entry-put nil property value)))
       ;; Org resets a repeat to TODO, which is Jon's; keep it AUTO. Also trim
       ;; here: a reviewed repeat is closed in Emacs, not by finish.
       (when (plist-get task :repeat)
         (org-entry-put nil "REPEAT_TO_STATE" "AUTO")
         (org-dispatch--trim-log (plist-get task :id)))
       (org-entry-delete nil "DISPATCH_FINISH")
       (org-entry-delete nil "DISPATCH_HEADLINE")
       (org-todo "PROG")
       (org-toggle-tag "auto" 'on)
       (when session
         (unless (let ((section (org-dispatch--section-bounds "Sessions")))
                   (and section (string-search link (buffer-substring-no-properties
                                                     (car section) (cdr section)))))
           (org-dispatch--append
            "Sessions"
            (format "- [[%s@%s][%s@%s/%s]]" link pane agent org-dispatch-host
                    (format-time-string "%Y-%m-%dT%H%M"))))))
     (plist-get task :heading))))

(defun org-dispatch--prompt (pane text)
  (org-dispatch--herdr "agent" "prompt" pane text "--wait" "--until" "working"
                       "--until" "blocked" "--until" "idle" "--until" "done"
                       "--timeout" "60000"))

(defun org-dispatch--launch (task)
  "Start or resume TASK's agent in Herdr and claim it. Return non-nil on success."
  ;; Eligibility is only a snapshot. Recheck before opening any Herdr tab.
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
             (pane (and resume (org-dispatch--live-pane resume agent)))
             (tab nil)
             (label (truncate-string-to-width (concat "auto · " (plist-get task :heading)) 60))
             (state (list :id id :file (plist-get task :file) :heading (plist-get task :heading)
                          :dir (plist-get task :dir) :agent agent :status "starting"
                          :started (float-time) :nudges 0
                          :repeat (if (plist-get task :repeat) 1 0))))
        (org-dispatch--save-state state)
        (condition-case err
            (progn
              (unless pane
                ;; A project file is named for its project, so this matches Jon's workspaces.
                (let ((created (org-dispatch--project-pane
                                (plist-get task :dir)
                                (truncate-string-to-width (plist-get task :heading) 40)
                                (file-name-base (plist-get task :file)))))
                  (setq pane (alist-get 'pane_id created)
                        tab (alist-get 'tab_id created)))
                (apply #'org-dispatch--herdr "agent" "start"
                       (format "auto-%s-%s"
                               (substring (replace-regexp-in-string "[^0-9a-f]" "" id) 0 8)
                               (format-time-string "%H%M%S"))
                       "--kind" agent "--pane" pane "--timeout" "60000" "--"
                       (append
                        (list (if (equal agent "claude") "--dangerously-skip-permissions" "--no-approve")
                              "--name" label)
                        (when (plist-get task :model) (list "--model" (plist-get task :model)))
                        (when resume
                          (if (equal agent "claude")
                              (list "--resume" resume)
                            (list "--session" (or (org-dispatch--session-file resume) resume)))))))
              (let ((session (org-dispatch--pane-session pane agent)))
                (org-dispatch--claim task pane session)
                (setq state (plist-put state :pane pane))
                (setq state (plist-put state :tab (or tab "")))
                (setq state (plist-put state :session session))
                (setq state (plist-put state :status "running"))
                (org-dispatch--save-state state)
                ;; Claimed: a failed prompt leaves the agent idle, which the watcher nudges.
                (condition-case err
                    (org-dispatch--prompt
                     pane (org-dispatch--render
                           "task" task `(("DIALOG" . ,(org-dispatch--dialog-block task resume)))))
                  (error (org-dispatch--log "prompt failed for %s: %s" id (error-message-string err))))
                (org-dispatch--log "%s %s: %s in %s" (if resume "resumed" "launched")
                                   id (plist-get task :heading) pane)
                t))
          (error
           ;; Trust or login dialogs may block before the agent reports a session.
           ;; Hold the task for Jon instead of opening another blocked tab each tick.
           (if (and pane (equal (org-dispatch--agent-status pane) "blocked"))
               (progn
                 (org-dispatch--claim task pane nil)
                 (org-dispatch--hold
                  state (format "%s is blocked during startup in Herdr pane %s. Inspect it with herdr agent read %s and resolve the prompt before resuming."
                                agent pane pane)))
             (org-dispatch--drop-state id))
           (org-dispatch--log "launch failed for %s: %s"
                              (plist-get task :heading) (error-message-string err))
           nil))))))

;;; Watching

(defun org-dispatch--hold (state reason)
  "Set STATE's task to HOLD with a Dispatcher entry giving REASON."
  (org-dispatch--edit (plist-get state :file) (plist-get state :id)
                      (lambda ()
                        (org-todo "HOLD")
                        (org-dispatch--append "Dialog" (org-dispatch--entry "Dispatcher" reason))))
  (org-dispatch--drop-state (plist-get state :id))
  (org-dispatch--notify (concat "HOLD · " (plist-get state :heading)) reason)
  (org-dispatch--log "held %s: %s" (plist-get state :id) reason))

(defun org-dispatch--todo-state (state)
  "Current TODO keyword of STATE's heading, or nil when it is gone."
  (let ((file (if (file-exists-p (plist-get state :file))
                  (plist-get state :file)
                (org-dispatch--find (plist-get state :id)))))
    (when file
      (setq state (plist-put state :file file))
      (ignore-errors
        (org-dispatch--edit file (plist-get state :id) #'org-get-todo-state)))))

(defun org-dispatch--watch (state)
  (let* ((id (plist-get state :id))
         (pane (plist-get state :pane))
         (todo (org-dispatch--todo-state state))
         (status (and pane (org-dispatch--agent-status pane)))
         (nudges (plist-get state :nudges)))
    (cond
     ((equal (plist-get state :status) "finished")
      ;; Close tabs this dispatcher opened once their work is accepted. Older
      ;; runs recorded a whole workspace instead.
      (unless (member status '("working" "blocked"))
        (when (member todo '("DONE" "AUTO"))
          (let ((tab (or (plist-get state :tab) ""))
                (workspace (or (plist-get state :workspace) "")))
            (cond ((not (string-empty-p tab))
                   (ignore-errors (org-dispatch--herdr "tab" "close" tab)))
                  ((not (string-empty-p workspace))
                   (ignore-errors (org-dispatch--herdr "workspace" "close" workspace))))))
        (org-dispatch--drop-state id)))
     ((not (equal (plist-get state :status) "running"))
      ;; A launch that died part way leaves a "starting" entry behind.
      (when (> (- (float-time) (plist-get state :started)) 600)
        (org-dispatch--drop-state id)))
     ((null todo)
      (org-dispatch--log "dropped %s: heading not found" id)
      (org-dispatch--drop-state id))
     ((not (equal todo "PROG"))
      ;; Jon changed the state while the agent ran.
      (when (member status '("working" "blocked"))
        (ignore-errors (org-dispatch--herdr "agent" "send-keys" pane "esc"))
        (org-dispatch--log "interrupted %s: Jon set %s" id todo))
      (ignore-errors (org-dispatch--edit (plist-get state :file) id #'org-dispatch--untag-auto))
      (org-dispatch--drop-state id))
     ((> (- (float-time) (plist-get state :started)) org-dispatch-time-limit)
      (ignore-errors (org-dispatch--herdr "agent" "send-keys" pane "esc"))
      (org-dispatch--hold state (format "Interrupted after %d minutes without finishing."
                                        (/ org-dispatch-time-limit 60))))
     ((null status)
      (org-dispatch--hold state (format "%s is no longer running in its pane."
                                        (or (plist-get state :agent) "pi"))))
     ((equal status "blocked")
      (when (eq (plist-get state :blocked) 0)
        (org-dispatch--notify (concat "Blocked · " (plist-get state :heading))
                              (format "%s is waiting on an approval prompt."
                                      (or (plist-get state :agent) "pi"))))
      (org-dispatch--save-state (plist-put state :blocked 1)))
     ((member status '("idle" "done"))
      (let* ((idle (plist-get state :idle))
             (since (if (and idle (> idle 0)) idle (float-time))))
        (setq state (plist-put state :idle since))
        (cond
         ((< (- (float-time) since) org-dispatch-nudge-after)
          (org-dispatch--save-state state))
         ((>= nudges org-dispatch-max-nudges)
          (org-dispatch--hold state (format "Still idle without a state change after %d nudge%s."
                                            org-dispatch-max-nudges
                                            (if (= org-dispatch-max-nudges 1) "" "s"))))
         (t
          (setq state (plist-put state :nudges (1+ nudges)))
          (setq state (plist-put state :idle 0))
          (org-dispatch--save-state state)
          (org-dispatch--prompt
           pane (org-dispatch--render
                 "nudge" state `(("NUDGE" . ,(number-to-string (1+ nudges)))
                                 ("MAX" . ,(number-to-string org-dispatch-max-nudges)))))
          (org-dispatch--log "nudged %s (%d of %d)" id (1+ nudges) org-dispatch-max-nudges)))))
     (t (setq state (plist-put state :blocked 0))
        (org-dispatch--save-state (plist-put state :idle 0))))))

;;; Entry points

(defun org-dispatch--pending-file ()
  (expand-file-name "pending.json" org-dispatch-state-dir))

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
         (running (seq-filter (lambda (s) (member (plist-get s :status) '("running" "starting")))
                              states))
         (index (when (seq-some (lambda (task) (plist-get task :depends)) tasks)
                  (org-dispatch--dependency-index)))
         eligible reports)
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
         ((not (member (plist-get task :agent) org-dispatch-launchable))
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
         ((seq-find (lambda (s) (equal (plist-get s :dir) (plist-get task :dir)))
                    (append running eligible)))
         ((>= (+ (length running) (length eligible)) org-dispatch-max-agents))
         (t (push task eligible)))))
    (unless dry-run
      (make-directory org-dispatch-state-dir t)
      (with-temp-file file (insert (json-serialize new))))
    (append (nreverse eligible) (nreverse reports))))

(defun org-dispatch-run ()
  (dolist (state (org-dispatch--states))
    (condition-case err
        (org-dispatch--watch state)
      (error (org-dispatch--log "watch failed for %s: %s"
                                (plist-get state :id) (error-message-string err)))))
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
  "Finish a task: ID STATE [NOTE] [--headline LINE] from the command line."
  (let* ((id (pop command-line-args-left))
         (todo (upcase (or (pop command-line-args-left) "")))
         (flag (member "--headline" command-line-args-left))
         (headline (when flag
                     (unless (and (= (length flag) 2)
                                  (not (string-empty-p (cadr flag)))
                                  (equal (cadr flag) (string-trim (cadr flag)))
                                  (not (string-match-p "[\n\r]" (cadr flag))))
                       (error "--headline needs one non-empty line without surrounding whitespace, after the note"))
                     (cadr flag)))
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
    (unless (member todo '("EVAL" "HOLD" "DONE"))
      (error "STATE must be EVAL, HOLD, or DONE"))
    (when (and (equal todo "HOLD") (string-empty-p note))
      (error "HOLD needs a question for Jon"))
    (setq result
          (org-dispatch--edit
           file id
           (lambda ()
             (let ((task (org-dispatch--task)))
               (when (and (equal todo "DONE") (plist-get task :review))
                 (setq todo "EVAL"))
               (cond
                ((equal todo "HOLD")
                 (org-dispatch--append "Dialog" (org-dispatch--entry "Agent" note)))
                ((and (equal todo "DONE") (plist-get task :repeat))
                 (org-dispatch--remove-section "Dialog")
                 (org-dispatch--log-run id "DONE" (plist-get task :todo) note)))
               (unless (string-empty-p note)
                 (org-entry-put nil "DISPATCH_FINISH" (replace-regexp-in-string "[\n\r]+" " " note)))
               (if headline
                   (org-entry-put nil "DISPATCH_HEADLINE" headline)
                 (org-entry-delete nil "DISPATCH_HEADLINE"))
               (org-todo todo)
               (org-get-todo-state)))))
    (when state
      (org-dispatch--save-state (plist-put state :status "finished")))
    (org-dispatch--notify (format "%s · %s" todo (or (plist-get state :heading) id))
                          (if (string-empty-p note) "Finished." note))
    (princ (format "%s is now %s\n" id result))
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
       (let ((task (org-dispatch--task)))
         (unless (equal (plist-get task :todo) "PROG")
           (error "only a running task can retry; this one is %s" (plist-get task :todo)))
         (when (plist-get task :repeat)
           (error "a repeating task recurs on its own; finish it with DONE"))
         (when (< (plist-get task :retry) 1)
           (error "Jon allowed no more retries; finish with HOLD instead"))
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
