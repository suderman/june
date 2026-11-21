;;; org-review.el --- Bounded review handoffs in existing Org tasks -*- lexical-binding: t; -*-

;; Org is the record, and org-dispatch still owns launching and session recovery.
;; All edits happen under org-edit's launch lock, in one agenda file/save.
;;
;; A development task in a loop keeps its live state in plain properties
;; (REVIEW_PHASE, REVIEW_ROUND, REVIEW_COMMIT, REVIEW_TASK, REVIEW_AGENT, and
;; REVIEW_ACCEPTED while human checks are confirmed) and its contract, with the
;; repository, branch, developer and host it pins, in its "Review contract"
;; section, which people read. An accepted loop removes the properties; its
;; Reviews, Verdict and Dialog sections are the history. A review task records
;; REVIEW_VERDICT, with its note in its Verdict section; once consumed it keeps
;; only REVIEW_PARENT, REVIEW_COMMIT and REVIEW_VERDICT of its review state.
;; Older tasks kept all of this as JSON in DEV_REVIEW and REVIEW_RESULT, which
;; are still read.
(require 'org-edit)
(require 'json)

(defvar org-review-author "June"
  "Who coordinates the loop, as Dialog and queued reviews name them.
The dispatcher binds it to \"Dispatcher\" for standing agent reviews.")

(defconst org-review-unattended-agents '("pi")
  "Agents that can review unattended. Claude Code stops at its workspace trust
prompt in every new snapshot, since it trusts only that exact repository root,
and the dispatcher never answers a prompt.")

(defun org-review--escalate ()
  "Leave the development task with Jon: EVAL with ASKED, never HOLD,
which means waiting on something outside."
  (org-entry-put nil "ASKED" (org-dispatch--stamp))
  (unless (equal (org-get-todo-state) "EVAL") (org-todo "EVAL")))

(defun org-review--json (value)
  (let ((json-encoding-pretty-print nil) (json-false :false) (json-null nil))
    (json-encode value)))

(defun org-review--legacy (property)
  "PROPERTY as the JSON older loops wrote, or nil."
  (when-let* ((text (org-entry-get nil property)))
    (json-parse-string text :object-type 'plist :array-type 'list :null-object nil :false-object :false)))

(defconst org-review--live
  '("REVIEW_PHASE" "REVIEW_ROUND" "REVIEW_COMMIT" "REVIEW_TASK" "REVIEW_AGENT" "REVIEW_ACCEPTED")
  "The development task's live loop properties, removed once it is accepted.")

(defconst org-review--contract-lines
  '((:authorization . "Authorized fixes, at most three exact-revision reviews:")
    (:permissions . "Permissions for every handoff:")
    (:checks . "Agent checks:")
    (:human . "Human checks:")
    (:source . "Source:"))
  "The Review contract section's lines, by the loop field each holds.")

(defun org-review--section-text (title)
  "The body of this entry's child section TITLE, or nil."
  (when-let* ((bounds (org-dispatch--section-bounds title)))
    (buffer-substring-no-properties
     (save-excursion (goto-char (car bounds)) (forward-line 1) (point)) (cdr bounds))))

(defun org-review--contract ()
  "The Review contract section as loop fields."
  (let ((text (or (org-review--section-text "Review contract")
                  (error "the task has no Review contract section; ask Jon")))
        contract)
    (pcase-dolist (`(,key . ,prefix) org-review--contract-lines)
      (unless (string-match (concat "^- " (regexp-quote prefix) " \\(.+\\)$") text)
        (error "the Review contract has no \"%s\" line; ask Jon" prefix))
      (setq contract (plist-put contract key (match-string 1 text))))
    (let ((source (plist-get contract :source)) (human (plist-get contract :human)))
      (unless (string-match "\\`=\\(.+\\)=, branch =\\(.+\\)=; developer \\([^ ]+\\) on \\([^ ]+\\)\\'" source)
        (error "the Review contract's Source line is malformed; ask Jon"))
      (list :repo (match-string 1 source) :branch (match-string 2 source)
            :developer (match-string 3 source) :host (match-string 4 source)
            :authorization (plist-get contract :authorization)
            :permissions (plist-get contract :permissions)
            :checks (plist-get contract :checks)
            :human (unless (equal human "none") (split-string human "; " t))))))

(defun org-review--loop ()
  "This development task's loop, or nil: live properties and its contract."
  (cond
   ((org-entry-get nil "REVIEW_PHASE")
    (let* ((round (string-to-number (or (org-entry-get nil "REVIEW_ROUND") "0")))
           (commit (org-entry-get nil "REVIEW_COMMIT")))
      (append (list :phase (org-entry-get nil "REVIEW_PHASE") :round round :commit commit
                    :review (org-entry-get nil "REVIEW_TASK") :agent (org-entry-get nil "REVIEW_AGENT")
                    :accepted (split-string (or (org-entry-get nil "REVIEW_ACCEPTED") "") "; " t)
                    :snapshot (and commit (> round 0)
                                   (org-review--snapshot-path round commit (org-entry-get nil "ID"))))
              (org-review--contract))))
   ((org-entry-get nil "DEV_REVIEW") (org-review--legacy "DEV_REVIEW"))))

(defun org-review--save (loop)
  "Write LOOP's live fields as properties; an older JSON record goes."
  (org-entry-put nil "REVIEW_PHASE" (plist-get loop :phase))
  (org-entry-put nil "REVIEW_ROUND" (number-to-string (plist-get loop :round)))
  (org-entry-put nil "REVIEW_COMMIT" (plist-get loop :commit))
  (org-entry-put nil "REVIEW_TASK" (plist-get loop :review))
  (org-entry-put nil "REVIEW_AGENT" (plist-get loop :agent))
  (if (plist-get loop :accepted)
      (org-entry-put nil "REVIEW_ACCEPTED" (string-join (plist-get loop :accepted) "; "))
    (org-entry-delete nil "REVIEW_ACCEPTED"))
  (org-entry-delete nil "DEV_REVIEW"))

(defun org-review--clear ()
  "Remove an accepted loop's live state; its sections keep the history."
  (dolist (property (cons "DEV_REVIEW" org-review--live))
    (org-entry-delete nil property)))

(defun org-review--finished-p ()
  "Whether this task's loop was accepted and cleared, for a replay."
  (and (equal (org-get-todo-state) "DONE")
       (not (org-review--loop))
       (org-dispatch--section-bounds "Reviews")
       t))

(defun org-review--result ()
  "This review task's recorded verdict, or nil: (:commit :verdict :note)."
  (if-let* ((verdict (org-entry-get nil "REVIEW_VERDICT")))
      (let* ((commit (org-entry-get nil "REVIEW_COMMIT"))
             (text (or (org-review--section-text "Verdict") ""))
             (note (and (string-match (format "^=%s=: %s\\. \\(.*\\)$" (regexp-quote commit) (regexp-quote verdict)) text)
                        (match-string 1 text))))
        (list :commit commit :verdict verdict :note note))
    (org-review--legacy "REVIEW_RESULT")))

(defun org-review--git (dir &rest args)
  (let ((default-directory (file-name-as-directory dir)))
    (with-temp-buffer
      (unless (eq 0 (apply #'call-process "git" nil t nil args))
        (error "git %s: %s" (car args) (string-trim (buffer-string))))
      (string-trim (buffer-string)))))

(defun org-review--clean (dir commit)
  (unless (and (equal (org-review--git dir "rev-parse" "HEAD") commit)
               (string-empty-p (org-review--git dir "status" "--porcelain" "--untracked-files=all")))
    (error "revision changed or worktree dirty: %s; review the new exact commit" dir)))

(defun org-review--source (loop commit)
  (org-review--clean (plist-get loop :repo) commit)
  (unless (equal (org-review--git (plist-get loop :repo) "symbolic-ref" "--short" "HEAD")
                 (plist-get loop :branch))
    (error "development branch changed; ask Jon before continuing")))

(defun org-review--at (id)
  (goto-char (or (org-find-property "ID" id) (error "missing linked task %s" id))))

(defun org-review--settled ()
  "Refuse active/unknown linked workers; never send terminal input."
  (when-let* ((section (org-dispatch--section-bounds "Sessions")))
    (let ((text (buffer-substring-no-properties (car section) (cdr section))) (start 0))
      (while (string-match "herdr:\\([^/]+\\)/\\([^:]+\\):\\([0-9a-f-]\\{36\\}\\)" text start)
        (let ((host (match-string 1 text)) (agent (match-string 2 text)) (session (match-string 3 text)))
          (setq start (match-end 0))
          (unless (equal host org-dispatch-host) (error "remote session needs its host's coordinator"))
          (org-dispatch--confirm-settled (list :session session :agent agent)))))))

(defun org-review--check-revision (revision)
  (unless (equal revision (secure-hash 'sha256 (encode-coding-string
                            (replace-regexp-in-string "\n+\\'" "" (org-dispatch--subtree-text)) 'utf-8)))
    (error "task revision changed; read the whole task and Dialog again")))

(defun org-review--text (spec key)
  (let ((value (plist-get spec key)))
    (unless (and (stringp value) (not (string-empty-p (string-trim value)))
                 (not (string-match-p "[\n\r]" value)))
      (error "%s needs one non-empty line" key))
    value))

(defun org-review--snapshot-path (round commit id)
  "Where ROUND's private clone of COMMIT lives, for task ID in this file."
  (let ((relative (file-relative-name buffer-file-name (org-dispatch--org-root))))
    (unless (string-match "\\`work/\\([^/]+\\)/\\([^/]+\\)/[^/]+\\.org\\'" relative)
      (error "review loops need a work/<domain>/<project>/<project>.org file"))
    (expand-file-name
     (format "~/.local/state/org-work/%s/%s/review-loop/%s/%d-%s/"
             (match-string 1 relative) (match-string 2 relative) id round commit))))

(defun org-review--snapshot (loop commit round id)
  "A private clone, never a linked Git worktree or a source remote."
  (let* ((dir (org-review--snapshot-path round commit id))
         (source (plist-get loop :repo)))
    (make-directory (file-name-directory (directory-file-name dir)) t)
    (set-file-modes (file-name-directory (directory-file-name dir)) #o700)
    ;; A crash during clone leaves only this private, deterministic path. Do not
    ;; delete or reset it automatically; inspect a partial/dirty snapshot instead.
    (if (file-exists-p dir)
        (progn
          (unless (and (equal (org-review--git dir "rev-parse" "--show-toplevel") (directory-file-name dir))
                       (string-empty-p (org-review--git dir "remote")))
            (error "partial or unexpected review clone; inspect %s" dir))
          (org-review--clean dir commit))
      (org-review--git source "clone" "--no-local" "--no-checkout" "--" source dir)
      (org-review--git dir "remote" "remove" "origin")
      (org-review--git dir "-c" "core.hooksPath=/dev/null" "checkout" "--detach" commit)
      (org-review--clean dir commit))
    dir))

(defun org-review--start (spec)
  (let* ((task (org-dispatch--task)) (id (plist-get task :id))
         (commit (org-review--text spec :commit))
         (loop (org-review--loop))
         (round (1+ (or (plist-get loop :round) 0)))
         (developer (plist-get task :agent)) (host (plist-get task :host)))
    (unless (string-match-p "\\`[0-9a-f]\\{40\\}\\'" commit) (error "commit needs the full Git SHA"))
    ;; A replay after any later phase is a no-op, not a second review or resume.
    (if (and loop (equal commit (plist-get loop :commit)))
        loop
      (org-review--check-revision (plist-get spec :revision))
      (unless (and (equal (org-get-todo-state) "EVAL") (not (plist-get task :repeat)))
        (error "start needs a one-off EVAL development task"))
      (when (and loop (not (member (plist-get loop :phase) '("fixes" "human"))))
        (error "finish the current review before starting another revision"))
      (when (> round 3) (error "three review rounds used; ask Jon for a new decision"))
      (org-dispatch--check-stopped-task)
      (org-review--settled)
      (unless loop
        (let* ((repo (file-truename (org-review--git (plist-get task :dir) "rev-parse" "--show-toplevel")))
               (branch (org-review--git repo "symbolic-ref" "--short" "HEAD"))
               (human (plist-get spec :human)))
          (unless (and (plist-member spec :human) (listp human) (seq-every-p (lambda (s) (and (stringp s) (not (string-empty-p s))
                                                                                (not (string-match-p "[\n\r;]" s)))) human))
            (error "human must list specific checks, each one line without semicolons, or be empty"))
          (setq loop (list :repo repo :branch branch :developer developer :host host
                           :authorization (org-review--text spec :authorization)
                           :permissions (org-review--text spec :permissions)
                           :checks (org-review--text spec :checks) :human (delete-dups human)
                           :agent (org-review--text spec :agent)))
          (unless (member (plist-get loop :agent) org-dispatch-launchable) (error "reviewer agent unavailable"))
          (unless (member (plist-get loop :agent) org-review-unattended-agents)
            (error "%s cannot review unattended: it stops at its workspace trust prompt in each new review snapshot; use %s"
                   (plist-get loop :agent) (string-join org-review-unattended-agents " or ")))
          (org-dispatch--append "Review contract"
            (format "- Authorized fixes, at most three exact-revision reviews: %s\n- Permissions for every handoff: %s\n- Agent checks: %s\n- Human checks: %s\n- Source: =%s=, branch =%s=; developer %s on %s"
                    (plist-get loop :authorization) (plist-get loop :permissions) (plist-get loop :checks)
                    (if human (string-join (delete-dups human) "; ") "none")
                    repo branch developer host))))
      (unless (and (equal host (plist-get loop :host)) (equal developer (plist-get loop :developer))
                   (equal (file-truename (org-review--git (plist-get task :dir) "rev-parse" "--show-toplevel"))
                          (plist-get loop :repo)))
        (error "assignment changed; ask Jon before continuing"))
      (org-review--source loop commit)
      (let* ((review (org-id-new)) (title (format "Review %s, round %d" (plist-get task :heading) round))
             (snapshot (org-review--snapshot loop commit round id))
             (parent (point-marker)))
        (setq loop (plist-put loop :round round)
              loop (plist-put loop :review review)
              loop (plist-put loop :commit commit)
              loop (plist-put loop :snapshot snapshot)
              loop (plist-put loop :accepted nil)
              loop (plist-put loop :phase "review"))
        (org-review--save loop)
        (org-dispatch--append "Reviews" (format "- [[id:%s][Round %d]]: =%s=, reviewer %s, snapshot =%s:%s=." review round commit (plist-get loop :agent) host snapshot))
        ;; A separate ordinary dispatcher task, with no inherited Sessions.
        (goto-char (point-max))
        (unless (bolp) (insert "\n"))
        (unless (save-excursion (forward-line -1) (looking-at-p "^$")) (insert "\n"))
        (insert (format "* AUTO %s\n:PROPERTIES:\n:ID: %s\n:HOST: %s\n:AGENT: %s\n:DIR: %s\n:JUNE_REQUEST: review-%s\n:DEPLOY: no\n:REVIEW_PARENT: %s\n:REVIEW_COMMIT: %s\n:END:\nQueued by %s: Independent exact-revision review of [[id:%s][the development task]].\n\n** Scope\nReview commit =%s= in this private snapshot only. Read the whole development task and Dialog for requirements, but do not modify its source checkout. This is a fresh reviewer session. Find and test defects; do not implement fixes, commit, push, activate, deploy, start services or commission work. Local verification and remote reads are allowed only within the contract below.\n\nPermissions: %s\n\nAgent checks: %s\n\nHuman checks remain with Jon: %s\n\nRecord exact commands, results, findings and what was tested with fakes versus for real in Outcome. Then run =org-edit review verdict %s id:%s '{\"commit\":\"%s\",\"verdict\":\"pass|fixes|blocked\",\"note\":\"specific findings and evidence\"}'=, choosing one verdict, and finish EVAL through org-dispatch. pass means all agent checks passed, never human acceptance. fixes means in-scope corrections for the original developer. blocked means missing permission, out-of-scope findings or an untestable requirement needing Jon. Never silently waive a required check.\n" title review host (plist-get loop :agent) snapshot review id commit org-review-author id commit (plist-get loop :permissions) (plist-get loop :checks)
                        (if (plist-get loop :human) (string-join (plist-get loop :human) "; ") "none")
                        (shell-quote-argument buffer-file-name) review commit))
        (goto-char parent)
        (set-marker parent nil)
        loop))))

(defun org-review--verdict (spec)
  (let* ((parent (org-entry-get nil "REVIEW_PARENT"))
         (commit (org-entry-get nil "REVIEW_COMMIT"))
         (verdict (plist-get spec :verdict))
         (note (org-review--text spec :note))
         (result (list :commit commit :verdict verdict :note note)))
    (unless (and parent (equal commit (plist-get spec :commit))
                 (member verdict '("pass" "fixes" "blocked")))
      (error "verdict needs a linked review, its exact commit and pass|fixes|blocked"))
    (if-let* ((old (org-review--result)))
        (unless (equal old result) (error "verdict is immutable; send corrections to Jon"))
      (org-dispatch--check-stopped-task t)
      (let* ((file (org-dispatch--state-file (org-entry-get nil "ID")))
             (state (and (file-exists-p file)
                         (with-temp-buffer (insert-file-contents file) (json-parse-buffer :object-type 'plist)))))
        (unless (and (equal (plist-get state :status) "running")
                     (equal (plist-get state :terminal) (getenv "HC_TERMINAL_ID"))
                     (plist-get state :session)
                     (equal (plist-get state :session) (plist-get (org-dispatch--task) :session)))
          (error "verdict must come from the current dispatcher reviewer terminal/session"))
        (let ((live (org-dispatch--stop-terminal state)))
          (unless (and live (equal (alist-get 'address live) (plist-get state :terminal)))
            (error "reviewer session exited or moved; inspect before recording a verdict"))))
      (unless (equal (org-get-todo-state) "PROG") (error "only the running reviewer may record a verdict"))
      (org-review--clean (plist-get (org-dispatch--task) :dir) commit)
      (let ((sessions (org-dispatch--section-bounds "Sessions"))
            (review-id (org-entry-get nil "ID"))
            (reviewer (plist-get (org-dispatch--task) :session)))
        (unless (and sessions reviewer) (error "reviewer has no dispatcher session identity"))
        (save-excursion
          (org-review--at parent)
          (let* ((loop (org-review--loop))
                 (section (org-dispatch--section-bounds "Sessions")))
            (unless (and loop (equal review-id (plist-get loop :review))
                         (equal commit (plist-get loop :commit))
                         (equal (plist-get loop :phase) "review"))
              (error "review no longer current"))
            (when (and section (string-search reviewer (buffer-substring-no-properties (car section) (cdr section))))
              (error "developer cannot review their own revision")))))
      (org-entry-put nil "REVIEW_VERDICT" verdict)
      (org-dispatch--append "Verdict" (format "=%s=: %s. %s" commit verdict note)))
    result))

(defun org-review--advance (spec)
  (let* ((loop (or (org-review--loop) (error "task has no review contract")))
         (id (org-entry-get nil "ID")) (parent (point-marker))
         (commit (plist-get loop :commit)) result)
    (unless (equal commit (plist-get spec :commit)) (error "stale review commit"))
    (if (not (equal (plist-get loop :phase) "review"))
        loop
      (org-review--check-revision (plist-get spec :revision))
      (unless (equal (org-get-todo-state) "EVAL") (error "development task must remain EVAL"))
      (let ((task (org-dispatch--task)))
        (unless (and (equal (plist-get task :agent) (plist-get loop :developer))
                     (equal (plist-get task :host) (plist-get loop :host))
                     (equal (file-truename (org-review--git (plist-get task :dir) "rev-parse" "--show-toplevel"))
                            (plist-get loop :repo)))
          (error "development assignment/directory changed; ask Jon")))
      (org-dispatch--check-stopped-task)
      (org-review--settled)
      (org-review--source loop commit)
      (save-excursion
        (org-review--at (plist-get loop :review))
        (unless (and (equal (org-entry-get nil "REVIEW_PARENT") id)
                     (equal (org-get-todo-state) "EVAL"))
          (error "linked reviewer is not ready at EVAL"))
        (org-review--settled)
        (setq result (or (org-review--result) (error "reviewer recorded no verdict")))
        (unless (equal (plist-get result :commit) commit) (error "reviewer verdict is stale"))
        (org-todo "DONE")
        ;; Only a running review needs these, and its finish note repeats the
        ;; Verdict section; the link, commit, verdict and headline stay.
        (dolist (property '("DIR" "JUNE_REQUEST" "DEPLOY" "REVIEW" "REVIEW_RESULT" "DISPATCH_FINISH"))
          (org-entry-delete nil property))
        (org-entry-put nil "REVIEW_VERDICT" (plist-get result :verdict)))
      (goto-char parent)
      (pcase (plist-get result :verdict)
        ("pass"
         (setq loop (plist-put loop :phase (if (plist-get loop :human) "human" "accepted")))
         (unless (plist-get loop :human) (org-todo "DONE")))
        ("fixes"
         (if (>= (plist-get loop :round) 3)
             (progn (setq loop (plist-put loop :phase "escalated")) (org-review--escalate))
           (setq loop (plist-put loop :phase "fixes"))
           ;; Same development task and assignment, including its original Sessions.
           ;; No general-purpose resume or fresh scope is granted by a verdict.
           (org-entry-put nil "JUNE_REQUEST" (concat "review-fixes-" (plist-get loop :review)))
           (org-entry-put nil "DEPLOY" "no")
           (org-dispatch--headline nil nil)
           (org-todo "AUTO")))
        ("blocked" (setq loop (plist-put loop :phase "escalated")) (org-review--escalate))
        (_ (error "invalid review verdict")))
      (if (equal (plist-get loop :phase) "accepted") (org-review--clear) (org-review--save loop))
      (org-dispatch--append "Dialog" (org-dispatch--entry org-review-author
        (format "Review [[id:%s][round %d]] of %s: %s. %s Phase: %s. %s Permissions remain: %s No activation or deployment is authorized by review approval."
                (plist-get loop :review) (plist-get loop :round) commit (plist-get result :verdict)
                (plist-get result :note) (plist-get loop :phase)
                (pcase (plist-get loop :phase)
                  ("fixes" "Original developer: address only these in-scope findings, read the full linked Outcome, verify, publish only if already permitted, and finish EVAL for a new exact revision review.")
                  ("human" "Agent checks accepted; Jon's listed human checks are still required for this exact commit.")
                  ("escalated" "Jon's decision is needed. Do not restart the loop or commission more work without it.")
                  (_ "Agent checks accepted; no human checks remain in this contract."))
                (plist-get loop :permissions))))
      (set-marker parent nil)
      loop)))

(defun org-review--human (spec)
  (let* ((loop (or (org-review--loop) (error "no review contract")))
         (commit (plist-get spec :commit)) (checks (plist-get spec :checks))
         (note (org-review--text spec :note)))
    (unless (and (equal commit (plist-get loop :commit))
                 (member (plist-get loop :phase) '("human" "accepted")))
      (error "human acceptance needs the current agent-approved commit"))
    (org-dispatch--check-stopped-task)
    (org-review--settled)
    (let ((task (org-dispatch--task)))
      (unless (and (equal (plist-get task :agent) (plist-get loop :developer))
                   (equal (plist-get task :host) (plist-get loop :host))
                   (equal (file-truename (org-review--git (plist-get task :dir) "rev-parse" "--show-toplevel"))
                          (plist-get loop :repo)))
        (error "development assignment changed; ask Jon")))
    (org-review--source loop commit)
    (unless (and (listp checks) checks (seq-every-p (lambda (check) (member check (plist-get loop :human))) checks))
      (error "checks must name the required human checks Jon explicitly accepted"))
    (when (not (seq-every-p (lambda (check) (member check (plist-get loop :accepted))) checks))
      (org-review--check-revision (plist-get spec :revision))
      (unless (equal (org-get-todo-state) "EVAL") (error "human acceptance needs EVAL"))
      (setq loop (plist-put loop :accepted (delete-dups (append (plist-get loop :accepted) checks))))
      (when (seq-every-p (lambda (check) (member check (plist-get loop :accepted))) (plist-get loop :human))
        (setq loop (plist-put loop :phase "accepted"))
        (org-todo "DONE"))
      (if (equal (plist-get loop :phase) "accepted") (org-review--clear) (org-review--save loop))
      (org-dispatch--append "Dialog" (org-dispatch--entry "June"
        (format "Jon accepted these human checks for %s: %s. %s" commit (string-join checks "; ") note))))
    loop))

(defun org-edit-review ()
  "Run review ACTION FILE id:UUID JSON.
June coordinates start/advance/human; the reviewer records verdict."
  (let* ((args (org-edit--args 4 "review start|verdict|advance|human FILE id:UUID JSON"))
         (action (nth 0 args)) (file (nth 1 args)) (heading (nth 2 args))
         (spec (json-parse-string (nth 3 args) :object-type 'plist :array-type 'list :null-object nil))
         (create-lockfiles t) (file-precious-flag t) result)
    (unless (and (string-match-p "\\`id:[[:alnum:]][[:alnum:]-]*\\'" heading)
                 (member action '("start" "verdict" "advance" "human")))
      (error "review needs an action and id:UUID"))
    (when (and (not (equal action "verdict")) (org-edit--worker-p))
      (error "review coordination belongs to June or Jon, not a coding worker"))
    (when (directory-files (file-name-directory (expand-file-name file)) nil
                          (concat "\\`" (regexp-quote (file-name-base file)) "\\.sync-conflict-.*\\.org\\'"))
      (error "resolve the file's Syncthing conflict copies first"))
    (org-edit--at file heading
      (lambda ()
        (let* ((task (org-dispatch--task))
               (node (gethash (plist-get task :id) (org-dispatch--dependency-index))))
          (unless (and node (not (plist-get node :duplicate))
                       (member (file-truename file) (mapcar #'file-truename (org-dispatch--agenda-files)))
                       (not (plist-get task :problem)) (equal (plist-get task :host) org-dispatch-host))
            (error "review needs a unique live agenda task on this dispatcher host")))
        (setq result (pcase action
                       ;; An accepted loop's state is gone; a replay reports the outcome.
                       ((guard (and (not (equal action "verdict")) (org-review--finished-p)))
                        (list :phase "accepted"))
                       ("start" (org-review--start spec))
                       ("verdict" (org-review--verdict spec))
                       ("advance" (org-review--advance spec))
                       ("human" (org-review--human spec))))
        (setq result (list :id (substring heading 3) :state (org-get-todo-state) :review result))) t)
    (princ (concat (org-review--json result) "\n"))))

(provide 'org-review)
;;; org-review.el ends here
