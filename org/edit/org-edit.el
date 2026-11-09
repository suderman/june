;;; org-edit.el --- Let Org make agents' state and date changes  -*- lexical-binding: t; -*-

;; Batch entry points, run through the org-edit wrapper:
;;   org-edit-todo      FILE HEADING STATE [--expect STATE] [--headline LINE]
;;                      [--request KEY --host HOST [--agent AGENT] [--depends REFS] --note TEXT]
;;   org-edit-remove-dependencies FILE id:UUID --expect STATE --revision HASH --remove REFS --request KEY --note TEXT
;;   org-edit-schedule  FILE HEADING WHEN
;;   org-edit-deadline  FILE HEADING WHEN
;;   org-edit-date      WHEN
;;   org-edit-update-task FILE HEADING JSON
;;
;; Task content updates use a read revision and preserve old wording in Dialog.
;; States and dates go through Org, so CLOSED,
;; repeaters, LOGBOOK entries, and weekdays come out as Emacs makes them.
;; HEADING is a title without keyword, priority, or tags, an outline path
;; such as "Hockey / Practice", or id:UUID.
;; Loading org-dispatch.el shares its TODO keywords and settings.

(require 'org-dispatch)
(require 'org-id)

;; Jon's Emacs logs a repeating task's completion; the dispatcher keeps its own run log.
(setq org-log-repeat 'time
      backtrace-on-error-noninteractive nil)

(defconst org-edit--cookie-re "\\`\\(?:[.+]?\\+\\|--?\\)[0-9]+[hdwmy]\\'"
  "A repeater or warning, such as +1w, .+1d, or -2d.")

(defconst org-edit--date-re
  (concat "\\`\\(?:[0-9]\\{4\\}-[0-9]\\{2\\}-[0-9]\\{2\\}\\|[+-][0-9]+[dwmy]\\|today\\|tomorrow"
          "\\|mon\\(?:day\\)?\\|tue\\(?:sday\\)?\\|wed\\(?:nesday\\)?\\|thu\\(?:rsday\\)?"
          "\\|fri\\(?:day\\)?\\|sat\\(?:urday\\)?\\|sun\\(?:day\\)?\\)\\'")
  "Date words org-edit accepts. `org-read-date' reads anything else as today.")

(defconst org-edit--time-re
  "\\`\\([0-9]\\{1,2\\}:[0-5][0-9]\\)\\(?:-\\([0-9]\\{1,2\\}:[0-5][0-9]\\)\\)?\\'")

(defun org-edit--args (n usage)
  "Pop N command-line arguments, or fail with USAGE."
  (let ((args (seq-take command-line-args-left n)))
    (setq command-line-args-left nil)
    (unless (and (= (length args) n) (not (member "" args)))
      (error "usage: org-edit %s" usage))
    args))

(defun org-edit--stamp (when)
  "The active timestamp for WHEN: one date word, an optional time or
range, and optional repeater and warning cookies."
  (let (date time end cookies)
    (dolist (word (split-string (downcase when)))
      (cond
       ;; +3d is the date until there is one, then a repeater.
       ((and date (string-match-p org-edit--cookie-re word)) (push word cookies))
       ((string-match org-edit--time-re word)
        (when time (error "two times in %S" when))
        (setq time (match-string 1 word) end (match-string 2 word)))
       ((string-match-p org-edit--date-re word)
        (when date (error "two dates in %S" when))
        (setq date word))
       (t (error "not a date, time, or cookie: %S (use YYYY-MM-DD, +3d, fri, 14:00, +1w)" word))))
    (unless date (error "no date in %S" when))
    (let ((day (org-read-date nil t (if (equal date "tomorrow") "+1d" date)))
          (pad (lambda (hm) (if (= (length hm) 4) (concat "0" hm) hm))))
      ;; org-read-date rolls 2026-02-30 into March and clamps years past 2037; refuse rather than move the date.
      (when (and (string-match-p "\\`[0-9]\\{4\\}-" date)
                 (not (equal (format-time-string "%F" day) date)))
        (error "no such date %s; Org would read it as %s" date (format-time-string "%F" day)))
      (format "<%s%s%s%s>"
              (format-time-string "%F %a" day)
              (if time (concat " " (funcall pad time)) "")
              (if end (concat "-" (funcall pad end)) "")
              (mapconcat (lambda (c) (concat " " c)) (nreverse cookies) "")))))

(defun org-edit--path ()
  "Titles from the top-level ancestor down to the heading at point."
  (save-excursion
    (let ((path (list (org-get-heading t t t t))))
      (while (org-up-heading-safe)
        (push (org-get-heading t t t t) path))
      path)))

(defun org-edit--ends-with-p (list suffix)
  "Non-nil when LIST ends with the elements of SUFFIX."
  (let ((n (- (length list) (length suffix))))
    (and (>= n 0) (equal (nthcdr n list) suffix))))

(defun org-edit--headings (heading)
  "Positions of the headings HEADING names in the current buffer.
HEADING is a title, an outline path such as \"Hockey / Practice\" matched
from its end, or id:UUID. A title containing \" / \" still matches whole."
  (if (string-prefix-p "id:" heading)
      (let ((position (org-find-property "ID" (substring heading 3))))
        (and position (list position)))
    (let ((parts (split-string heading " / "))
          titles paths)
      (org-map-entries
       (lambda ()
         (let ((path (org-edit--path)))
           (when (equal (car (last path)) heading)
             (push (point) titles))
           (when (and (cdr parts) (org-edit--ends-with-p path parts))
             (push (point) paths)))))
      (nreverse (or titles paths)))))


(defun org-edit--at (file heading function &optional quiet)
  "Call FUNCTION at the one heading HEADING names in FILE and save.
Print the heading unless QUIET is non-nil."
  (setq file (expand-file-name file))
  (unless (file-regular-p file) (error "no file %s" file))
  (when (string-search ".sync-conflict-" file)
    (error "%s is a Syncthing conflict copy" file))
  (when (file-equal-p file (expand-file-name "asana.org" org-directory))
    (error "asana.org is rebuilt from Asana; never edit it"))
  (let ((buffer (find-file-noselect file t)))
    (unwind-protect
        (with-current-buffer buffer
          (org-mode)
          (let ((found (org-edit--headings heading)))
            (cond
             ((null found) (error "no heading %S in %s" heading file))
             ((cdr found)
              (error "%d headings %S in %s; give a path such as \"Parent / %s\", or its id:"
                     (length found) heading file (car (last (split-string heading " / "))))))
            (goto-char (car found))
            (funcall function)
            ;; Org writes LOGBOOK entries after the command; batch has no command loop.
            (when (memq #'org-add-log-note post-command-hook)
              (org-add-log-note))
            (when (buffer-modified-p)
              (unless (verify-visited-file-modtime buffer)
                (error "%s changed on disk; read it again before retrying" file))
              (save-buffer))
            (unless quiet
              (goto-char (car found))
              (org-back-to-heading t)
              (princ (buffer-substring-no-properties
                      (point) (save-excursion (forward-line 1)
                                              (when (looking-at-p org-planning-line-re)
                                                (forward-line 1))
                                              (point)))))))
      (kill-buffer buffer))))

;; Before the save, the task at point gains REFS: the graph must resolve with no
;; missing, duplicate, or circular IDs, as `org-dispatch plan' requires.
(defun org-edit--depends (refs)
  "The heading's DEPENDS plus REFS, after checking the resulting graph."
  (let* ((id (org-entry-get nil "ID"))
         (all (delete-dups (append (split-string (or (org-entry-get nil "DEPENDS") "")) refs)))
         (index (org-dispatch--dependency-index)))
    (when (and id (member (concat "id:" id) all))
      (error "a task cannot depend on itself"))
    (when (and id (plist-get (gethash id index) :duplicate))
      (error "duplicate ID %s; fix it before adding dependencies" id))
    ;; A task without an ID yet cannot be anyone's prerequisite, so it closes no cycle.
    (let ((self (or id "org-edit:new-task")))
      (puthash self (list :id self :heading (org-get-heading t t t t) :depends all) index)
      (org-dispatch--validate-graph (list self) index))
    all))

(defun org-edit--worker-p ()
  "Whether this caller has worker context, not a plain human Herdr shell."
  (when-let* ((pane (getenv "HERDR_PANE_ID")))
    (or (getenv "PI_SESSION_ID") (getenv "CLAUDECODE")
        (let ((result (org-dispatch--get (org-dispatch--herdr "agent" "list") 'result)))
          (unless (vectorp (alist-get 'agents result))
            (error "Herdr did not identify the caller; refusing state write"))
          (seq-some (lambda (agent) (equal pane (alist-get 'pane_id agent)))
                    (alist-get 'agents result))))))

(defun org-edit-todo ()
  "Set FILE HEADING to STATE, optionally checking --expect STATE.
For EVAL, DONE or HOLD, --headline LINE binds a fresh worker report to this write.
June uses --request KEY --host HOST --note TEXT to resume a task once, --agent
AGENT to change who runs it, and --depends \"id:A id:B\" to add prerequisites in
the same save, so the dispatcher never sees the task AUTO without them.
Coding workers must not set AUTO; that permission lives in instructions."
  (let* ((args command-line-args-left)
         (file (pop args)) (heading (pop args)) (state (upcase (or (pop args) "")))
         expected request host agent note depends headline result)
    (setq command-line-args-left nil)
    (unless (and file heading (not (string-empty-p state)))
      (error "usage: org-edit todo FILE HEADING STATE [--expect STATE] [--headline LINE] [--request KEY --host HOST [--agent AGENT] [--depends REFS] --note TEXT]"))
    (while args
      (let ((flag (pop args)) (value (pop args)))
        (unless (and value (not (string-empty-p value))) (error "missing value for %s" flag))
        (pcase flag
          ("--expect" (setq expected (upcase value)))
          ("--request" (setq request value))
          ("--host" (setq host value))
          ("--agent" (setq agent value))
          ("--note" (setq note value))
          ("--depends" (setq depends (split-string value)))
          ("--headline" (setq headline (org-dispatch--validate-headline value)))
          (_ (error "unknown option %s" flag)))))
    (when (and headline (not (member state '("EVAL" "DONE" "HOLD"))))
      (error "--headline is only for EVAL, DONE, or HOLD"))
    (when (or request host agent note depends)
      (unless (and (equal state "AUTO") request host note (member expected '("TODO" "EVAL" "HOLD")))
        (error "resuming needs AUTO, --expect TODO|EVAL|HOLD, --request, --host, and --note"))
      (unless (member host org-dispatch-hosts) (error "unknown dispatcher host %s" host))
      (when (and agent (not (member agent org-dispatch-launchable))) (error "unknown agent %s" agent))
      (when (or (string-match-p "[\n\r]" request) (string-match-p "[\n\r]" note))
        (error "request and note must each be one line"))
      (dolist (ref depends)
        (unless (string-match-p "\\`id:[[:alnum:]][[:alnum:]-]*\\'" ref)
          (error "--depends takes id:UUID references, not %s" ref))))
    (org-edit--at
     file heading
     (lambda ()
       ;; A replay never grants AUTO a second time, even after the worker finishes.
       (let ((replay (and request (equal request (org-entry-get nil "JUNE_REQUEST")))))
         (unless replay
           (when (and expected (not (equal expected (org-get-todo-state))))
             (error "expected %s, found %s; read the task again" expected (org-get-todo-state)))
           ;; Keywords are buffer-local, and a file may set its own.
           (unless (member state org-todo-keywords-1)
             (error "STATE is one of %s" (string-join org-todo-keywords-1 " ")))
           (when (and (or (org-entry-get nil "DEV_REVIEW") (org-entry-get nil "REVIEW_PARENT"))
                      (member state '("AUTO" "DONE")))
             (error "task has a review contract; use org-edit review for fixes or acceptance, ask Jon to change scope"))
           (when depends (setq depends (org-edit--depends depends)))
           ;; Protect general state writes too, without treating human Herdr
           ;; shells or June's daemon as workers. This is a cooperative guard.
           (cond ((org-edit--worker-p)
                  (org-dispatch--check-stopped-task t))
                 ((equal state "AUTO") (org-dispatch--check-stopped-task)))
           (when request
             (org-id-get-create)
             ;; The drawer decides where and how it runs; tags are left as they are.
             (if agent
                 (org-entry-put nil "AGENT" agent)
               (unless (org-entry-get nil "AGENT")
                 (org-entry-put nil "AGENT" (org-dispatch--default "agent" "pi"))))
             (org-entry-put nil "HOST" host)
             (org-entry-put nil "JUNE_REQUEST" request)
             (org-entry-put nil "REVIEW" "yes")
             (org-entry-put nil "DEPLOY" "no")
             (when depends (org-entry-put nil "DEPENDS" (string-join depends " ")))
             (org-dispatch--append "Dialog" (org-dispatch--entry "June" note)))
           (org-dispatch--headline headline state)
           (org-todo state))
         (when request
           (setq result `((id . ,(org-entry-get nil "ID"))
                          (title . ,(org-get-heading t t t t))
                          (host . ,host)
                          (depends . ,(vconcat (split-string (or (org-entry-get nil "DEPENDS") ""))))
                          (written . ,(if replay :false t)))))))
     request)
    (when request (princ (concat (json-serialize result) "\n")))))

(defun org-edit-stop-task ()
  "Park a dispatcher task and confirm its exact session settled or exited.
The wrapper holds the launch lock. A failed stop stays parked and cannot resume."
  (let* ((args command-line-args-left)
         (file (pop args)) (heading (pop args))
         revision request note state replay confirmed result
         (create-lockfiles t) (file-precious-flag t))
    (setq command-line-args-left nil)
    (unless (and file heading (string-match-p "\\`id:[[:alnum:]][[:alnum:]-]*\\'" heading))
      (error "stop-task needs FILE and id:UUID"))
    (while args
      (let ((flag (pop args)) (value (pop args)))
        (pcase flag
          ("--revision" (setq revision value))
          ("--request" (setq request value))
          ("--note" (setq note value))
          (_ (error "unknown option %s" flag)))))
    (unless (and revision (string-match-p "\\`[0-9a-f]\\{64\\}\\'" revision)
                 request (not (string-empty-p request)) note (not (string-empty-p (string-trim note)))
                 (not (string-match-p "[\n\r]" (concat request note))))
      (error "stop-task needs --revision SHA256, --request KEY and one-line --note"))
    (when (directory-files (file-name-directory (expand-file-name file)) nil
                           (concat "\\`" (regexp-quote (file-name-base file)) "\\.sync-conflict-.*\\.org\\'"))
      (error "resolve the file's Syncthing conflict copies first"))
    (org-edit--at
     file heading
     (lambda ()
       (let* ((task (org-dispatch--task)) (id (plist-get task :id))
              (node (gethash id (org-dispatch--dependency-index)))
              (state-file (org-dispatch--state-file id)))
         (unless (and node (not (plist-get node :duplicate))
                      (member (file-truename file) (mapcar #'file-truename (org-dispatch--agenda-files))))
           (error "stop-task needs a unique task ID in a live agenda file"))
         (when (or (plist-get task :problem) (not (equal (plist-get task :host) org-dispatch-host)))
           (error "stop-task must run on the task's dispatcher host"))
         (setq state (and (file-exists-p state-file)
                          (with-temp-buffer (insert-file-contents state-file)
                                            (json-parse-buffer :object-type 'plist))))
         ;; A new tool call may recover the same pending stop after an error.
         ;; HOLD with a receipt is also a no-op, never a second interruption.
         (cond
          ((and (equal (plist-get state :status) "stopping") (plist-get state :stop-request))
           (setq request (plist-get state :stop-request)))
          ((and (equal (org-get-todo-state) "HOLD") (org-entry-get nil "JUNE_STOP_REQUEST")
                (equal (org-entry-get nil "JUNE_STOP_REQUEST") (org-entry-get nil "JUNE_STOPPED")))
           (setq request (org-entry-get nil "JUNE_STOP_REQUEST"))))
         (setq replay (equal request (org-entry-get nil "JUNE_STOP_REQUEST"))
               confirmed (and replay (equal request (org-entry-get nil "JUNE_STOPPED"))))
         (unless confirmed
           (unless (and state (equal (plist-get state :id) id)
                        (equal (plist-get state :file) (plist-get task :file))
                        (plist-get state :session) (plist-get state :pane)
                        (or replay (equal (plist-get state :session) (plist-get task :session)))
                        (equal (plist-get state :agent) (plist-get task :agent))
                        (or (equal (plist-get state :status) "running")
                            (and (equal (plist-get state :status) "stopping")
                                 (equal (plist-get state :stop-request) request))))
             (error "no matching dispatcher run to stop; inspect the task and worker"))
           (unless replay
             (unless (equal (org-get-todo-state) "PROG") (error "only a PROG dispatcher task can stop"))
             (unless (equal revision (secure-hash 'sha256 (encode-coding-string
                                      (replace-regexp-in-string "\n+\\'" "" (org-dispatch--subtree-text)) 'utf-8)))
               (error "task revision changed; read the task and Dialog again"))
             ;; Durable suppression precedes HOLD and any input. Recovery uses the same request.
             (setq state (plist-put state :stop-request request))
             (org-dispatch--save-state (plist-put state :status "stopping"))
             (org-entry-put nil "JUNE_STOP_REQUEST" request)
             (org-entry-put nil "JUNE_STOP_SESSIONS"
               (string-join (delete-dups (delq nil
                 (append (split-string (or (org-entry-get nil "JUNE_STOP_SESSIONS") ""))
                         (list (org-entry-get nil "JUNE_STOP_SESSION") (plist-get state :session))))) " "))
             (org-entry-put nil "JUNE_STOP_SESSION" (plist-get state :session))
             (org-dispatch--headline nil "HOLD")
             (org-todo "HOLD")
             (org-dispatch--append "Dialog" (org-dispatch--entry
               "June" (concat "Stop requested; parked at HOLD before checking the worker. " note))))
           (unless (equal (org-get-todo-state) "HOLD")
             (error "stop pending but task is not HOLD; inspect before continuing")))
         (setq result `((id . ,id) (title . ,(org-get-heading t t t t))
                        (state . ,(org-get-todo-state)) (replay . ,(if replay t :false)))))) t)
    ;; Recover a crash after the Org receipt but before the local state save.
    (when confirmed
      (let ((state-file (org-dispatch--state-file (substring heading 3))))
        (when (file-exists-p state-file)
          (let ((old (with-temp-buffer (insert-file-contents state-file)
                                      (json-parse-buffer :object-type 'plist))))
            (when (and (equal (plist-get old :stop-request) request)
                       (equal (plist-get old :status) "stopping"))
              (org-dispatch--save-state (plist-put old :status "stopped")))))))
    (unless confirmed
      (org-dispatch--interrupt-session state)
      ;; Re-read after waiting; never overwrite a concurrent worker or editor save.
      (org-edit--at
       file heading
       (lambda ()
         (unless (and (equal request (org-entry-get nil "JUNE_STOP_REQUEST"))
                      (equal (org-get-todo-state) "HOLD"))
           (error "task changed during interruption; stop remains unconfirmed"))
         (org-entry-put nil "JUNE_STOPPED" request)
         (org-dispatch--append "Dialog" (org-dispatch--entry
           "June" "Worker observed settled or exited. Task remains HOLD; reassignment needs a separate authorized resume."))) t)
      (org-dispatch--save-state (plist-put state :status "stopped")))
    (princ (concat (json-serialize (append result '((stopped . t)))) "\n"))))

(defun org-edit-remove-dependencies ()
  "Remove selected edges on this host, pausing AUTO before a separate resume.
The wrapper holds the dispatcher's lock. Compare the whole task revision,
keep Dialog append-only, and never change prose or launch a worker here."
  (let* ((args command-line-args-left)
         (file (pop args)) (heading (pop args))
         expected revision refs request note result
         ;; Cooperate with interactive Emacs and replace the file atomically.
         (create-lockfiles t) (file-precious-flag t))
    (setq command-line-args-left nil)
    (unless (and file heading (string-match-p "\\`id:[[:alnum:]][[:alnum:]-]*\\'" heading))
      (error "remove-dependencies needs FILE and id:UUID"))
    (while args
      (let ((flag (pop args)) (value (pop args)))
        (unless (and value (not (string-empty-p value))) (error "missing value for %s" flag))
        (pcase flag
          ("--expect" (setq expected value))
          ("--revision" (setq revision value))
          ("--remove" (setq refs (delete-dups (split-string value))))
          ("--request" (setq request value))
          ("--note" (setq note value))
          (_ (error "unknown option %s" flag)))))
    (unless (and (member expected '("TODO" "EVAL" "HOLD" "AUTO"))
                 revision (string-match-p "\\`[0-9a-f]\\{64\\}\\'" revision)
                 refs request note (not (string-empty-p (string-trim note)))
                 (not (string-match-p "[\n\r]" (concat request note))))
      (error "need --expect TODO|EVAL|HOLD|AUTO, --revision SHA256, --remove REFS, --request KEY and one-line --note"))
    (dolist (ref refs)
      (unless (string-match-p "\\`id:[[:alnum:]][[:alnum:]-]*\\'" ref)
        (error "--remove takes id:UUID references, not %s" ref)))
    (when (directory-files (file-name-directory (expand-file-name file)) nil
                           (concat "\\`" (regexp-quote (file-name-base file)) "\\.sync-conflict-.*\\.org\\'"))
      (error "resolve the file's Syncthing conflict copies first"))
    (org-edit--at
     file heading
     (lambda ()
       (let* ((id (org-entry-get nil "ID"))
              (replay (equal request (org-entry-get nil "JUNE_DEPENDENCY_EDIT")))
              (task (org-dispatch--task))
              (old (plist-get task :depends))
              (remaining (seq-remove (lambda (ref) (member ref refs)) old)))
         (unless replay
           (unless (equal expected (org-get-todo-state))
             (error "expected %s, found %s; read the task again" expected (org-get-todo-state)))
           (unless (equal revision (secure-hash 'sha256 (encode-coding-string
                                  (replace-regexp-in-string "\n+\\'" "" (org-dispatch--subtree-text)) 'utf-8)))
             (error "task revision changed; read the task and Dialog again"))
           ;; A remote dispatcher cannot be locked by this process.
           (when (or (plist-get task :problem) (not (equal (plist-get task :host) org-dispatch-host)))
             (error "dependency removal must run on the task's dispatcher host"))
           (let ((state-file (org-dispatch--state-file id)))
             (when (file-exists-p state-file)
               (let ((state (with-temp-buffer (insert-file-contents state-file)
                                             (json-parse-buffer :object-type 'plist))))
                 (when (member (plist-get state :status) '("starting" "running"))
                   (error "task still has an active dispatcher run; wait for it to finish")))))
           ;; Recheck every local linked session under the launch lock, including historical runs.
           ;; June checks remote sessions before invoking us.
           (let ((end (save-excursion (org-end-of-subtree t t) (point))) sessions)
             (save-excursion
               (while (re-search-forward (format "herdr:%s/[^: \n]+:\\([0-9a-f-]+\\)"
                                                (regexp-quote org-dispatch-host)) end t)
                 (push (match-string 1) sessions)))
             (when sessions
               (let ((response (org-dispatch--herdr "agent" "list")))
                 (unless (assq 'agents (org-dispatch--get response 'result))
                   (error "Herdr did not return agent status; dependency removal refused"))
                 (seq-doseq (agent (org-dispatch--get response 'result 'agents))
                   (when (and (seq-some (lambda (session) (string-search session
                                          (or (org-dispatch--get agent 'agent_session 'value) ""))) sessions)
                              (member (org-dispatch--get agent 'agent_status) '("working" "blocked")))
                     (error "task still has an active agent; wait for it to finish"))))))
           (let* ((index (org-dispatch--dependency-index)) (node (gethash id index)))
             (unless node (error "task ID %s is missing from the agenda" id))
             (when (plist-get node :duplicate) (error "duplicate task ID %s" id))
             (dolist (ref refs)
               (unless (member ref old) (error "dependency edge %s is absent; read the task again" ref)))
             ;; An explicitly removed dangling ID is repairable. Every remaining edge must still resolve.
             (puthash id (list :id id :depends remaining) index)
             (org-dispatch--validate-graph (list id) index))
           (if remaining (org-entry-put nil "DEPENDS" (string-join remaining " "))
             (org-entry-delete nil "DEPENDS"))
           (org-entry-put nil "JUNE_DEPENDENCY_EDIT" request)
           (when (equal expected "AUTO")
             (org-dispatch--headline nil "HOLD")
             (org-todo "HOLD"))
           (org-dispatch--append "Dialog" (org-dispatch--entry
             "June" (format "Removed DEPENDS edges %s. %s%s Other instructions remain in force."
                            (string-join refs " ") note
                            (if (equal expected "AUTO")
                                " Paused AUTO at HOLD; re-read scope and Dialog before explicitly resuming." "")))))
         (setq result `((id . ,id) (title . ,(org-get-heading t t t t))
                        (state . ,(org-get-todo-state))
                        (depends . ,(vconcat (split-string (or (org-entry-get nil "DEPENDS") ""))))
                        (written . ,(if replay :false t))))))
     t)
    (princ (concat (json-serialize result) "\n"))))

(defun org-edit-update-task ()
  "Update a task's title and/or Scope, keeping state, planning and history.
SPEC is JSON with revision, request, note and optional title and scope.
The wrapper holds the launch lock. Replays find the receipt even after a rename."
  (pcase-let* ((`(,file ,heading ,json) (org-edit--args 3 "update-task FILE HEADING JSON"))
               (spec (json-parse-string json :object-type 'plist :null-object nil :false-object :false))
               (revision (plist-get spec :revision)) (request (plist-get spec :request))
               (note (plist-get spec :note)) (title (plist-get spec :title))
               (scope (plist-get spec :scope))
               (fingerprint (secure-hash 'sha256 (json-serialize
                             (list :title title :scope scope :note note))))
               (receipt (json-serialize (list :request request :hash fingerprint)))
               (create-lockfiles t) (file-precious-flag t)
               (agenda nil) (replay-selector nil) (result nil))
    (cl-loop for (key _value) on spec by #'cddr do
             (unless (memq key '(:revision :request :note :title :scope))
               (error "unknown update-task field %s" key)))
    (unless (and (stringp revision) (string-match-p "\\`[0-9a-f]\\{64\\}\\'" revision)
                 (stringp request) (not (string-empty-p request))
                 (stringp note) (not (string-empty-p (string-trim note)))
                 (not (string-match-p "[\n\r]" (concat request note)))
                 (or (plist-member spec :title) (plist-member spec :scope)))
      (error "update-task needs revision SHA256, request, one-line note and title and/or scope"))
    (when (plist-member spec :title)
      (unless (and (stringp title) (not (string-empty-p title)) (equal title (string-trim title))
                   (not (string-match-p "[[:cntrl:]]" title))
                   (not (string-match-p "\\`\\(?:\\*+\\|\\[#[^]]+\\]\\|TODO\\|AUTO\\|PROG\\|EVAL\\|HOLD\\|DONE\\)\\(?:[ \t]\\|\\'\\)" title))
                   (not (string-match-p "[ \t]+:[[:alnum:]_@#%:]+:\\'" title)))
        (error "title must be one line without keyword, priority, stars or tags")))
    (when (plist-member spec :scope)
      (unless (and (stringp scope) (not (string-empty-p (string-trim scope)))
                   (not (string-match-p "\r" scope))
                   (not (string-match-p "^\\*+[ \t]\\|^[ \t]*:[[:alnum:]_@#%]+:[ \t]*$\\|^[ \t]*\\(?:SCHEDULED\\|DEADLINE\\|CLOSED\\):\\|^[ \t]*#\\+" scope)))
        (error "scope must be prose or lists, without headings, drawers, planning or directives"))
      (setq scope (string-trim scope)))
    (setq file (file-truename file))
    (when (or (member (file-name-nondirectory file) '("asana.org" "inbox.org" "archive.org"))
              (string-match-p "/archive/\\|\\.sync-conflict-" file)
              (not (file-in-directory-p file (org-dispatch--org-root))))
      (error "not a writable live Org file: %s" file))
    (setq agenda (mapcar #'file-truename (org-dispatch--agenda-files)))
    (unless (member file agenda)
      (error "not an agenda file: %s" file))
    (when (directory-files (file-name-directory file) nil
                           (concat "\\`" (regexp-quote (file-name-base file)) "\\.sync-conflict-.*\\.org\\'"))
      (error "resolve the file's Syncthing conflict copies first"))
    ;; A title is not a stable selector after renaming. Locate this request's
    ;; receipt before resolving the original selector, without writing anything.
    (with-temp-buffer
      (insert-file-contents file)
      (org-mode)
      (org-map-entries
       (lambda ()
         (when-let* ((old (org-entry-get nil "JUNE_TASK_EDIT")))
           (when (equal request (plist-get (json-parse-string old :object-type 'plist) :request))
             (when replay-selector (error "duplicate task edit receipt"))
             (unless (equal old receipt) (error "request key reused with different content"))
             (setq replay-selector (concat "id:" (org-entry-get nil "ID"))))))))
    (org-edit--at
     file (or replay-selector heading)
     (lambda ()
       (let ((replay (equal receipt (org-entry-get nil "JUNE_TASK_EDIT"))))
         (unless replay
           (unless (equal revision (secure-hash 'sha256 (encode-coding-string
                    (replace-regexp-in-string "\n+\\'" "" (org-dispatch--subtree-text)) 'utf-8)))
             (error "task revision changed; read the whole task and Dialog again"))
           (unless (member (org-get-todo-state) '(nil "TODO" "HOLD" "EVAL"))
             (error "only plain, TODO, HOLD or EVAL tasks can be updated; never active or queued work"))
           (when (or (org-entry-get nil "DEV_REVIEW") (org-entry-get nil "REVIEW_PARENT"))
             (error "task has a review contract; ask Jon before changing scope"))
           (when-let* ((host (org-entry-get nil "HOST")))
             (unless (equal host org-dispatch-host) (error "update on the task's dispatcher host")))
           (when-let* ((id (org-entry-get nil "ID")))
             (let ((matches 0))
               (dolist (path agenda)
                 (with-temp-buffer
                   (insert-file-contents path)
                   (org-mode)
                   (org-map-entries (lambda () (when (equal id (org-entry-get nil "ID")) (cl-incf matches))))))
               (unless (= matches 1) (error "duplicate task ID")))
             (org-dispatch--check-stopped-task)
             (let ((state-file (org-dispatch--state-file id)))
               (when (file-exists-p state-file)
                 (let ((state (with-temp-buffer (insert-file-contents state-file)
                                               (json-parse-buffer :object-type 'plist))))
                   (unless (member (plist-get state :status) '("finished" "stopped"))
                     (error "task has active or uncertain dispatcher state; inspect before editing"))))))
           ;; Check every linked session, including links outside Sessions.
           ;; This confirms settlement/exit only; it sends no terminal input.
           (let ((text (org-dispatch--subtree-text)) (offset 0))
             (while (string-match "herdr:\\([^/]+\\)/\\([^:]+\\):\\([0-9a-f-]\\{36\\}\\)" text offset)
               (let ((host (match-string 1 text)) (agent (match-string 2 text)) (session (match-string 3 text)))
                 (setq offset (match-end 0))
                 (unless (equal host org-dispatch-host) (error "remote session needs its host's coordinator"))
                 (org-dispatch--interrupt-session (list :session session :agent agent)))))
           (let ((old-title (org-get-heading t t t t)) old-scope
                 (start (point-marker)) (sections 0))
             (when scope
               (save-excursion
                 (let ((end (save-excursion (org-end-of-subtree t t) (point)))
                       (stars (org-dispatch--section-stars)))
                   (while (re-search-forward (format "^%s Scope[ \t]*$" (regexp-quote stars)) end t)
                     (cl-incf sections))))
               (when (> sections 1) (error "multiple Scope sections; reconcile them first"))
               (let ((section (org-dispatch--section-bounds "Scope")))
                 (save-excursion
                   (if section
                       (progn (goto-char (car section)) (forward-line 1))
                     ;; Legacy manual tasks keep their scope directly under the
                     ;; task. Preserve metadata and all child sections.
                     (org-end-of-meta-data t))
                   (let ((end (if section (cdr section)
                                (save-excursion (outline-next-heading) (point)))))
                     (setq old-scope (buffer-substring-no-properties (point) end))
                     (when (string-match-p "^\\*+[ \t]\\|^[ \t]*:[[:alnum:]_@#%]+:[ \t]*$\\|^[ \t]*\\(?:SCHEDULED\\|DEADLINE\\|CLOSED\\):\\|^[ \t]*#\\+" old-scope)
                       (error "Scope contains structure; reconcile it before replacing prose"))
                     (delete-region (point) end)
                     (insert scope "\n" (if (eobp) "" "\n"))))))
             (goto-char start)
             (when title (org-edit-headline title))
             (org-id-get-create)
             (org-entry-put nil "JUNE_TASK_EDIT" receipt)
             (org-dispatch--append "Dialog" (org-dispatch--entry "June"
               (concat note " Previous content (JSON): "
                       (json-serialize (append (when title (list :title old-title))
                                               (when scope (list :scope old-scope)))))))
             (set-marker start nil)))
         (setq result `((id . ,(org-entry-get nil "ID")) (title . ,(org-get-heading t t t t))
                        (state . ,(org-get-todo-state)) (written . ,(if replay :false t)))))) t)
    (princ (concat (json-serialize result) "\n"))))

(defun org-edit--planning (keyword usage)
  "Set or remove the KEYWORD planning date: FILE HEADING WHEN, or none."
  (pcase-let ((`(,file ,heading ,when) (org-edit--args 3 usage)))
    (org-edit--at file heading
                  (lambda ()
                    (if (equal (downcase when) "none")
                        (org-add-planning-info nil nil (intern (downcase keyword)))
                      ;; A string keeps the time and cookies. Not org-entry-put: in Org 9.8
                      ;; it writes DEADLINE after the next heading when this one has no body.
                      (funcall (if (equal keyword "SCHEDULED") #'org-schedule #'org-deadline)
                               nil (org-edit--stamp when)))))))

(defun org-edit-schedule ()
  (org-edit--planning "SCHEDULED" "schedule FILE HEADING WHEN|none"))

(defun org-edit-deadline ()
  (org-edit--planning "DEADLINE" "deadline FILE HEADING WHEN|none"))

(defun org-edit-date ()
  "Print the active timestamp for WHEN."
  (princ (concat (org-edit--stamp (car (org-edit--args 1 "date WHEN"))) "\n")))

(provide 'org-edit)
;;; org-edit.el ends here
