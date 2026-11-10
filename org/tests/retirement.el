;;; retirement.el --- Name-bound pane retirement tests -*- lexical-binding: t; -*-
;; Herdr is mocked throughout: agent list/get return fixture rows and pane
;; close only records the call. Real close/reopen checks are run separately.
(require 'ert)
(require 'cl-lib)

(defconst retirement-session "01234567-89ab-cdef-0123-456789abcdef")
(defconst retirement-id "abcdef12-0000-4000-8000-000000000001")
(defconst retirement-name "auto-abcdef12-101010")
(defconst retirement-dispatch-source
  (expand-file-name "../dispatch/org-dispatch.el" (file-name-directory load-file-name)))
(defvar retirement-agents nil)
(defvar retirement-agenda nil)
(defvar retirement-calls nil)
(defvar retirement-next nil)
(defvar retirement-final nil "Function returning the agent row for agent get, or nil.")
(defvar retirement-reopenable t)

(defun retirement-agent (&optional status agent name)
  (let ((agent (or agent "pi")))
    ;; Copy: tests edit rows in place, and backquote shares constant cells.
    (copy-tree
     `((pane_id . "probe:p1") (tab_id . "probe:t1") (terminal_id . "probe-terminal")
      (revision . 2) (agent . ,agent) (agent_status . ,(or status "idle"))
      (name . ,(if (eq name 'none) nil (or name retirement-name)))
      (focused) (state_change_seq . 40) (completion_seq . 40)
      (agent_session (agent . ,agent)
                     (value . ,(if (equal agent "pi")
                                   (concat "probe_" retirement-session ".jsonl") retirement-session))))
     t)))

(defun retirement-herdr (&rest args)
  (push args retirement-calls)
  (pcase args
    (`("agent" "list")
     (prog1 `((result (agents . ,retirement-agents)))
       (when retirement-next (funcall retirement-next))))
    (`("agent" "get" ,name)
     (let ((row (if retirement-final (funcall retirement-final)
                  (seq-find (lambda (a) (equal (alist-get 'name a) name)) retirement-agents))))
       (unless row (error "agent_not_found: agent target %s not found" name))
       `((result (agent . ,row)))))
    (`("pane" "close" ,pane)
     (setq retirement-agents (vconcat (seq-remove (lambda (a) (equal (alist-get 'pane_id a) pane)) retirement-agents)))
     '((result (type . "ok"))))
    (_ (error "Unexpected Herdr call: %S" args))))

(defun retirement-task (file todo &optional id agent)
  (make-directory (file-name-directory file) t)
  (with-temp-file file
    (insert (format "* %s Probe\n:PROPERTIES:\n:ID: %s\n:END:\n\n** Sessions\n- [[herdr:kit/%s:%s@probe:p1][probe]]\n"
                    todo (or id retirement-id) (or agent "pi") retirement-session))))

(defun retirement-state ()
  (list :id retirement-id :file (car retirement-agenda) :agent "pi" :session retirement-session
        :pane "probe:p1" :tab "probe:t1" :status "finished"))

(defmacro retirement-fixture (&rest body)
  `(let* ((root (make-temp-file "pane-retirement-probe-" t))
          (org-dispatch-root (expand-file-name "org" root))
          (org-dispatch-state-dir (expand-file-name "state" root))
          (org-dispatch-host "kit")
          (retirement-agenda (list (expand-file-name "work/probe/probe.org" org-dispatch-root)))
          (retirement-agents (vector (retirement-agent)))
          (retirement-calls nil) (retirement-next nil) (retirement-final nil)
          (retirement-reopenable t))
     (unwind-protect
         (cl-letf (((symbol-function 'org-dispatch--herdr) #'retirement-herdr)
                   ((symbol-function 'org-dispatch--reopenable) (lambda (_) retirement-reopenable))
                   ((symbol-function 'org-dispatch--agenda-files) (lambda (&rest _) retirement-agenda)))
           (retirement-task (car retirement-agenda) "DONE")
           ,@body)
       (delete-directory root t))))

(defun retirement-row ()
  (car (org-dispatch--reconcile-panes retirement-agenda (org-dispatch--retire-seen))))

(defun retirement-reason (text)
  (seq-some (lambda (reason) (string-search text reason)) (plist-get (retirement-row) :skip)))

(defun retirement-closes ()
  (seq-filter (lambda (args) (equal (seq-take args 2) '("pane" "close"))) retirement-calls))

(defun retirement-run ()
  "One enabled dispatcher run; return the closed pane IDs."
  (mapcar (lambda (row) (plist-get row :pane)) (org-dispatch--retire-panes retirement-agenda)))

(ert-deftest retirement-finished-slots-never-close-tabs-or-workspaces ()
  (retirement-fixture
   (dolist (status '("idle" "done" "working" "blocked" "unknown"))
     (setq retirement-agents (vector (retirement-agent status)))
     (let ((state (retirement-state)))
       (org-dispatch--save-state state)
       (cl-letf (((symbol-function 'org-dispatch--agent-status) (lambda (_) status)))
         (org-dispatch--watch state))
       (should (eq (and (org-dispatch--states) t) (and (member status '("working" "blocked")) t)))
       (should (= 1 (length (org-dispatch--pane-receipts))))))
   (should-not (retirement-closes))
   (should-not (seq-find (lambda (args) (equal (car args) "tab")) retirement-calls))
   (dolist (state (org-dispatch--states)) (org-dispatch--drop-state (plist-get state :id)))
   (setq retirement-agents (vector (retirement-agent)))
   (should (plist-get (retirement-row) :eligible))
   (should-not (plist-get (retirement-row) :close))))

(ert-deftest retirement-external-state-change-never-sends-escape ()
  (retirement-fixture
   (let ((state (plist-put (retirement-state) :status "running")))
     (org-dispatch--save-state state)
     (cl-letf (((symbol-function 'org-dispatch--agent-status) (lambda (_) "working")))
       (org-dispatch--watch state))
     (should-not (seq-some (lambda (args) (member (cadr args) '("close" "send-keys")))
                           retirement-calls)))))

(ert-deftest retirement-closes-only-after-two-unchanged-runs-and-repeats-safely ()
  (retirement-fixture
   (should-not (retirement-run))
   ;; A damaged observation file only restarts the wait.
   (with-temp-file (org-dispatch--retire-file) (insert "{not json"))
   (should-not (org-dispatch--retire-seen))
   (should-not (retirement-run))
   (should (equal (retirement-run) '("probe:p1")))
   (should (equal (mapcar #'caddr (retirement-closes)) '("probe:p1")))
   ;; The close was preceded by a name-bound read of the same occupant.
   (should (equal (cadr (member '("pane" "close" "probe:p1") retirement-calls))
                  (list "agent" "get" retirement-name)))
   ;; Repeated runs after the pane is gone do nothing and keep history.
   (let ((before (with-temp-buffer (insert-file-contents (car retirement-agenda)) (buffer-string))))
     (should-not (retirement-run))
     (should-not (retirement-run))
     (should (= 1 (length (retirement-closes))))
     (should (equal before (with-temp-buffer (insert-file-contents (car retirement-agenda)) (buffer-string)))))))

(ert-deftest retirement-any-change-between-runs-restarts-the-wait ()
  (retirement-fixture
   (dolist (change '((state_change_seq . 41) (completion_seq . 41) (revision . 3)
                     (terminal_id . "replacement-terminal") (focused . t)))
     (setq retirement-agents (vector (retirement-agent)))
     (org-dispatch--retire-save nil)
     (should-not (retirement-run))
     (setf (alist-get (car change) (aref retirement-agents 0)) (cdr change))
     (should-not (retirement-run))
     (unless (eq (car change) 'focused)
       ;; A new stable observation is needed before closing.
       (should (equal (retirement-run) '("probe:p1")))))
   (should (= 4 (length (retirement-closes))))))

(ert-deftest retirement-final-check-keeps-panes-that-changed-or-lost-their-name ()
  (retirement-fixture
   (should-not (retirement-run))
   ;; Input arrived after the inventory: the final read sees a new turn.
   (let ((retirement-final (lambda () (let ((row (copy-tree (aref retirement-agents 0))))
                                        (setf (alist-get 'agent_status row) "working")
                                        (setf (alist-get 'state_change_seq row) 41)
                                        row))))
     (should-not (retirement-run)))
   (should-not (retirement-closes))
   ;; The occupant exited or was replaced: Herdr cleared the name.
   (should-not (retirement-run))
   (let ((retirement-final (lambda () nil)))
     (should-not (retirement-run)))
   (should-not (retirement-closes))))

(ert-deftest retirement-resume-and-restart-recovery ()
  (retirement-fixture
   (should-not (retirement-run))
   ;; Resumed before the second run: not DONE, and the saved look is dropped.
   (retirement-task (car retirement-agenda) "AUTO")
   (should-not (retirement-run))
   (should (seq-empty-p (org-dispatch--retire-seen)))
   (retirement-task (car retirement-agenda) "DONE")
   (should-not (retirement-run))
   ;; A fresh Emacs process, as after a dispatcher restart, completes the wait.
   (with-temp-buffer
     (should
      (zerop
       (call-process
        "emacs" nil t nil "-Q" "--batch" "-l" retirement-dispatch-source
        "--eval"
        (prin1-to-string
         `(let ((org-dispatch-root ,org-dispatch-root)
                (org-dispatch-state-dir ,org-dispatch-state-dir)
                (org-dispatch-host "kit"))
            (cl-letf (((symbol-function 'org-dispatch--herdr)
                       (lambda (&rest _) '((result (agents . ,retirement-agents)))))
                      ((symbol-function 'org-dispatch--reopenable) (lambda (_) t)))
              (princ (json-serialize
                      (vconcat (mapcar (lambda (row) (org-plist-delete row :observation))
                                       (org-dispatch--reconcile-panes ',retirement-agenda
                                                                      (org-dispatch--retire-seen))))))))))))
     (goto-char (point-min))
     (should (eq t (gethash "close" (aref (json-parse-buffer) 0)))))
   ;; Herdr restart: the same pane comes back without its name and is skipped.
   (setq retirement-agents (vector (retirement-agent nil nil 'none)))
   (should (retirement-reason "no dispatcher agent name"))
   (should-not (retirement-run))
   (should-not (retirement-closes))))

(ert-deftest retirement-archive-gaps-duplicates-and-immediate-archive ()
  (retirement-fixture
   (let* ((file (car retirement-agenda))
          (archive (expand-file-name "archive.org" (file-name-directory file)))
          (text (with-temp-buffer (insert-file-contents file) (buffer-string)))
          (state (plist-put (retirement-state) :status "running")))
     (org-dispatch--save-state state)
     ;; The heading left the original file and has not reached the archive.
     (with-temp-file file (insert "#+TITLE: Probe\n"))
     (should-not (org-dispatch--todo-state state))
     (org-dispatch--watch state)
     (should (org-dispatch--states))
     (should (retirement-reason "no matching task"))
     ;; DONE then immediately archived: found in the sibling archive.
     (with-temp-file archive (insert text))
     (should (equal (org-dispatch--todo-state state) "DONE"))
     (org-dispatch--watch state)
     (should-not (org-dispatch--states))
     (should (plist-get (retirement-row) :eligible))
     (should-not (retirement-run))
     (should (equal (retirement-run) '("probe:p1")))
     (should (equal text (with-temp-buffer (insert-file-contents archive) (buffer-string))))
     ;; Copy-before-delete archive ordering is never treated as one task.
     (setq retirement-agents (vector (retirement-agent)))
     (with-temp-file file (insert text))
     (should-not (org-dispatch--todo-state state))
     (should (retirement-reason "duplicate task ID")))))

(ert-deftest retirement-keeps-every-unaccepted-and-repeating-state ()
  (retirement-fixture
   (dolist (todo '("EVAL" "HOLD" "AUTO" "TODO" "PROG"))
     (retirement-task (car retirement-agenda) todo)
     (should-not (plist-get (retirement-row) :eligible))
     (should (retirement-reason (concat "task is " todo))))
   (retirement-task (car retirement-agenda) "DONE")
   (org-dispatch--edit (car retirement-agenda) retirement-id
                       (lambda () (org-schedule nil "<2030-01-01 Tue +1d>")))
   (should (retirement-reason "future runs"))))

(ert-deftest retirement-agent-states-and-exact-session-formats ()
  (retirement-fixture
   (dolist (agent '("pi" "claude"))
     (retirement-task (car retirement-agenda) "DONE" nil agent)
     (dolist (status '("idle" "done" "working" "blocked" "unknown"))
       (setq retirement-agents (vector (retirement-agent status agent)))
       (should (eq (plist-get (retirement-row) :eligible)
                   (and (member status '("idle" "done")) t)))))
   (setq retirement-agents (vector (retirement-agent)))
   (setf (alist-get 'value (alist-get 'agent_session (aref retirement-agents 0)))
         (concat "prefix" retirement-session "suffix"))
   (should (retirement-reason "missing agent session identity"))))

(ert-deftest retirement-requires-the-dispatcher-name-for-this-task ()
  (retirement-fixture
   (dolist (name '(none "auto-abcdef12" "reviewer" "auto-ABCDEF12-101010" "xauto-abcdef12-101010"))
     (setq retirement-agents (vector (retirement-agent nil nil name)))
     (should (retirement-reason "no dispatcher agent name")))
   (setq retirement-agents (vector (retirement-agent nil nil "auto-99999999-101010")))
   (should (retirement-reason "different task"))
   (setq retirement-agents (vector (retirement-agent)))
   (setf (alist-get 'focused (aref retirement-agents 0)) t)
   (should (retirement-reason "focused"))
   (setq retirement-agents (vector (retirement-agent)))
   (let ((retirement-reopenable nil))
     (should (retirement-reason "cannot be reopened")))))

(ert-deftest retirement-shared-reused-receipt-review-and-active-sessions ()
  (retirement-fixture
   (should (plist-get (retirement-row) :eligible))
   (let ((shared (expand-file-name "shared.org" org-dispatch-root)))
     (retirement-task shared "DONE" "fedcba98-0000-4000-8000-000000000002")
     (let ((retirement-agenda (append retirement-agenda (list shared))))
       (should (retirement-reason "shared by multiple task"))))
   (setq retirement-agents (vector (retirement-agent)
                                   (let ((other (retirement-agent)))
                                     (setf (alist-get 'pane_id other) "probe:p9")
                                     other)))
   (should (retirement-reason "multiple live panes"))
   (setq retirement-agents (vector (retirement-agent)))
   ;; A receipt for this pane naming another task blocks it.
   (org-dispatch--remember-pane (list :id "fedcba98-0000-4000-8000-000000000002" :agent "pi"
                                      :session retirement-session :pane "probe:p1" :tab "probe:t1"))
   (should (retirement-reason "receipt names a different"))
   (delete-directory (expand-file-name "panes" org-dispatch-state-dir) t)
   (org-dispatch--save-state (plist-put (retirement-state) :status "running"))
   (should (retirement-reason "active dispatcher run"))
   (org-dispatch--drop-state retirement-id)
   (org-dispatch--edit (car retirement-agenda) retirement-id
                       (lambda () (org-entry-put nil "DEV_REVIEW" "review-id")))
   (should (retirement-reason "review workflow"))))

(ert-deftest retirement-missing-id-conflicts-and-parent-archives ()
  (retirement-fixture
   (org-dispatch--edit (car retirement-agenda) retirement-id
                       (lambda () (org-entry-delete nil "ID")))
   (should (retirement-reason "no stable ID"))
   (retirement-task (car retirement-agenda) "DONE")
   (let ((conflict (concat (file-name-sans-extension (car retirement-agenda)) ".sync-conflict-probe.org")))
     (copy-file (car retirement-agenda) conflict)
     (should (retirement-reason "conflict copy"))
     (delete-file conflict))
   (let ((archive (expand-file-name "archive/2026/probe.org" org-dispatch-root)))
     (make-directory (file-name-directory archive) t)
     (rename-file (car retirement-agenda) archive)
     (with-temp-file (car retirement-agenda) (insert "#+TITLE: Probe\n"))
     (should (plist-get (retirement-row) :eligible)))))

(ert-deftest retirement-changes-during-one-inventory-block-the-pane ()
  (retirement-fixture
   (dolist (field '(revision terminal_id agent_status agent_session name state_change_seq))
     (setq retirement-agents (vector (retirement-agent)))
     (let ((retirement-next
            (lambda ()
              (setq retirement-agents (copy-tree retirement-agents t))
              (setf (alist-get field (aref retirement-agents 0))
                    (pcase field
                      ('revision 3) ('terminal_id "replacement-terminal")
                      ('agent_status "working") ('agent_session nil) ('name nil)
                      ('state_change_seq 41))))))
       (let ((row (retirement-row)))
         (should (seq-some (lambda (reason) (string-search "changed during inventory" reason))
                           (plist-get row :skip)))
         (should-not (plist-get row :eligible)))))
   (setq retirement-agents (vector (retirement-agent)))
   ;; Resumed between the two Org reads of one inventory.
   (let* ((lists 0)
          (retirement-next (lambda ()
                             (when (= (setq lists (1+ lists)) 2)
                               (retirement-task (car retirement-agenda) "AUTO")))))
     (should (seq-some (lambda (reason) (string-search "Org records" reason))
                       (plist-get (retirement-row) :skip))))))

(ert-deftest retirement-legacy-finished-receipts-are-preserved-before-release ()
  (retirement-fixture
   ;; Model a receipt written by the installed dispatcher before this change.
   (make-directory org-dispatch-state-dir t)
   (with-temp-file (org-dispatch--state-file retirement-id)
     (insert (json-serialize (retirement-state))))
   (should-not (org-dispatch--pane-receipts))
   (org-dispatch--watch (car (org-dispatch--states)))
   (should (= 1 (length (org-dispatch--pane-receipts))))
   (should-not (org-dispatch--states))))

(ert-deftest retirement-is-off-unless-enabled ()
  (retirement-fixture
   (dolist (config '(nil "{}" "{\"dispatch\":{\"retire\":false}}" "{\"dispatch\":{\"retire\":\"yes\"}}"
                         "{\"dispatch\":{\"retire\":true}}"))
     (let ((org-dispatch-config (make-temp-file "dispatch-config"))
           (org-dispatch--defaults nil))
       (if config (with-temp-file org-dispatch-config (insert config)) (delete-file org-dispatch-config))
       (should (eq (org-dispatch--retire-enabled) (equal config "{\"dispatch\":{\"retire\":true}}")))
       (when (file-exists-p org-dispatch-config) (delete-file org-dispatch-config))))
   (cl-letf (((symbol-function 'org-dispatch--retire-enabled) #'ignore)
             ((symbol-function 'org-dispatch--tasks) #'ignore))
     (org-dispatch-run)
     (org-dispatch-run))
   (should-not retirement-calls)
   (should-not (file-exists-p (org-dispatch--retire-file)))
   (cl-letf (((symbol-function 'org-dispatch--retire-enabled) (lambda () t))
             ((symbol-function 'org-dispatch--tasks) #'ignore))
     (org-dispatch-run)
     (org-dispatch-run))
   (should (= 1 (length (retirement-closes))))))

(ert-deftest retirement-errors-and-read-only-cli ()
  (retirement-fixture
   (let ((before (directory-files org-dispatch-root t)))
     (let ((command-line-args-left '("--dry-run")))
       (with-temp-buffer
         (let ((standard-output (current-buffer))) (org-dispatch-reconcile))
         (goto-char (point-min))
         (let ((rows (json-parse-buffer)))
           (should (vectorp rows))
           (should (eq t (gethash "eligible" (aref rows 0))))
           (should (eq :false (gethash "close" (aref rows 0)))))))
     (should (equal before (directory-files org-dispatch-root t)))
     (should-not (file-exists-p org-dispatch-state-dir))
     (should-not (retirement-closes)))
   (let ((command-line-args-left nil)) (should-error (org-dispatch-reconcile)))
   (let ((retirement-agents nil)) (should-error (retirement-row)))
   (cl-letf (((symbol-function 'org-dispatch--herdr) (lambda (&rest _) (error "probe unavailable"))))
     (should-error (retirement-row))
     (should-error (retirement-run)))
   ;; A failed close is logged and leaves the pane for a later run.
   (should-not (retirement-run))
   (cl-letf (((symbol-function 'org-dispatch--herdr)
              (lambda (&rest args)
                (if (equal (seq-take args 2) '("pane" "close")) (error "pane_not_found")
                  (apply #'retirement-herdr args)))))
     (should-not (retirement-run)))
   (should (file-exists-p (car retirement-agenda)))))

(ert-run-tests-batch-and-exit)
