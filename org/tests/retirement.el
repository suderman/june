;;; retirement.el --- Label-bound worker retirement tests -*- lexical-binding: t; -*-
;; hc is mocked throughout: ls and get return fixture terminals, and kill and
;; rm only record the call. Real kill and reopen checks are run separately.
(require 'ert)
(require 'cl-lib)

(defconst retirement-session "01234567-89ab-cdef-0123-456789abcdef")
(defconst retirement-id "abcdef12-0000-4000-8000-000000000001")
(defvar retirement-workers nil "Fake live dispatcher terminals.")
(defvar retirement-agenda nil)
(defvar retirement-calls nil)
(defvar retirement-next nil "Function run after each ls, to change the world mid-inventory.")
(defvar retirement-final nil "Function returning the terminal for the final get, or nil.")
(defvar retirement-gets 0 "gets so far; the final check is the third in a one-worker run.")
(defvar retirement-reopenable t)

(defun retirement-worker (&optional status agent labels)
  ;; Copy: tests edit records in place, and backquote shares constant cells.
  (copy-tree
   `((address . "t7") (state . "live") (pid . 70) (turn . 4) (status_ms . 40)
     (status . ,(and (not (equal status "unknown")) `((state . ,(or status "idle")))))
     (labels . ,(or labels
                    `((org.dispatch . "kit") (org.task . ,retirement-id) (org.run . "run-1")
                      (org.agent . ,(or agent "pi")) (org.session . ,retirement-session)))))
   t))

(defun retirement-hc (&rest args)
  (push args retirement-calls)
  (pcase args
    (`("ls" "--label" "org.dispatch=kit")
     (prog1 `((terminals . ,(vconcat (mapcar (lambda (w) `((address . ,(alist-get 'address w)) (state . "live")))
                                             retirement-workers))))
       (when retirement-next (funcall retirement-next))))
    (`("get" ,address)
     (or (if (and retirement-final (> (cl-incf retirement-gets) 2)) (funcall retirement-final)
           (seq-find (lambda (w) (equal (alist-get 'address w) address)) retirement-workers))
         (signal 'org-dispatch-hc (list "not_found" address))))
    (`("kill" ,address)
     (setq retirement-workers (seq-remove (lambda (w) (equal (alist-get 'address w) address)) retirement-workers))
     '((reason . "killed")))
    (`("rm" ,_) nil)
    (_ (error "Unexpected hc call: %S" args))))

(defun retirement-task (file todo &optional id agent)
  (make-directory (file-name-directory file) t)
  (with-temp-file file
    (insert (format "* %s Probe\n:PROPERTIES:\n:ID: %s\n:END:\n\n** Sessions\n- [[herdr:kit/%s:%s@t7][probe]]\n"
                    todo (or id retirement-id) (or agent "pi") retirement-session))))

(defun retirement-state ()
  (list :id retirement-id :file (car retirement-agenda) :agent "pi" :session retirement-session
        :host "kit" :terminal "t7" :run "run-1" :status "finished"))

(defmacro retirement-fixture (&rest body)
  `(let* ((root (make-temp-file "worker-retirement-probe-" t))
          (org-dispatch-root (expand-file-name "org" root))
          (org-dispatch-state-dir (expand-file-name "state" root))
          (org-dispatch-host "kit")
          (retirement-agenda (list (expand-file-name "work/probe/probe.org" org-dispatch-root)))
          (retirement-workers (list (retirement-worker)))
          (retirement-calls nil) (retirement-next nil) (retirement-final nil)
          (retirement-reopenable t))
     (unwind-protect
         (cl-letf (((symbol-function 'org-dispatch--hc) #'retirement-hc)
                   ((symbol-function 'org-dispatch--reopenable) (lambda (_) retirement-reopenable))
                   ((symbol-function 'org-dispatch--agenda-files) (lambda (&rest _) retirement-agenda)))
           (retirement-task (car retirement-agenda) "DONE")
           ,@body)
       (delete-directory root t))))

(defun retirement-row ()
  (car (org-dispatch--reconcile-panes retirement-agenda (org-dispatch--retire-seen))))

(defun retirement-reason (text)
  (seq-some (lambda (reason) (string-search text reason)) (plist-get (retirement-row) :skip)))

(defun retirement-kills ()
  (seq-filter (lambda (args) (equal (car args) "kill")) retirement-calls))

(defun retirement-run ()
  "One enabled dispatcher run; return the retired terminal addresses."
  (mapcar (lambda (row) (plist-get row :terminal)) (org-dispatch--retire-panes retirement-agenda)))

(ert-deftest retirement-finished-slots-never-kill-from-the-watcher ()
  (retirement-fixture
   (dolist (status '("idle" "done" "working" "blocked" "unknown"))
     (setq retirement-workers (list (retirement-worker status)))
     (let ((state (retirement-state)))
       (org-dispatch--save-state state)
       (org-dispatch--watch state)
       (should (eq (and (org-dispatch--states) t) (and (member status '("working" "blocked")) t)))))
   (should-not (retirement-kills))
   (dolist (state (org-dispatch--states)) (org-dispatch--drop-state (plist-get state :id)))
   (setq retirement-workers (list (retirement-worker)))
   (should (plist-get (retirement-row) :eligible))
   (should-not (plist-get (retirement-row) :close))))

(ert-deftest retirement-external-state-change-never-interrupts ()
  (retirement-fixture
   (setq retirement-workers (list (retirement-worker "working")))
   (let ((state (plist-put (retirement-state) :status "running")))
     (org-dispatch--save-state state)
     (org-dispatch--watch state)
     (should-not (seq-some (lambda (args) (member (car args) '("kill" "interrupt" "send"))) retirement-calls)))))

(ert-deftest retirement-kills-only-after-two-unchanged-runs-and-repeats-safely ()
  (retirement-fixture
   (should-not (retirement-run))
   ;; A damaged observation file only restarts the wait.
   (with-temp-file (org-dispatch--retire-file) (insert "{not json"))
   (should-not (org-dispatch--retire-seen))
   (should-not (retirement-run))
   (should (equal (retirement-run) '("t7")))
   (should (equal (mapcar #'cadr (retirement-kills)) '("t7")))
   ;; The kill follows one last read of that terminal, and the record is removed after.
   (should (equal (cadr (member '("kill" "t7") retirement-calls)) '("get" "t7")))
   (should (member '("rm" "t7") retirement-calls))
   ;; Repeated runs after the worker is gone do nothing and keep history.
   (let ((before (with-temp-buffer (insert-file-contents (car retirement-agenda)) (buffer-string))))
     (should-not (retirement-run))
     (should-not (retirement-run))
     (should (= 1 (length (retirement-kills))))
     (should (equal before (with-temp-buffer (insert-file-contents (car retirement-agenda)) (buffer-string)))))))

(ert-deftest retirement-any-change-between-runs-restarts-the-wait ()
  (retirement-fixture
   (dolist (change '((turn . 5) (status_ms . 41) (pid . 71) (status (state . "done"))))
     (setq retirement-workers (list (retirement-worker)))
     (should-not (retirement-run))
     (setf (alist-get (car change) (car retirement-workers)) (cdr change))
     (should-not (retirement-run))
     (should (equal (retirement-run) '("t7"))))
   (should (= 4 (length (retirement-kills))))))

(ert-deftest retirement-final-check-keeps-workers-that-changed-or-vanished ()
  (retirement-fixture
   (should-not (retirement-run))
   (let ((retirement-gets 0)
         (retirement-final (lambda () (let ((w (copy-tree (car retirement-workers) t)))
                                        (setf (alist-get 'turn w) 9) w))))
     (should-not (retirement-run)))
   (should-not (retirement-kills))
   (should-not (retirement-run))
   (let ((retirement-gets 0) (retirement-final (lambda () nil)))
     (should-not (retirement-run)))
   (should-not (retirement-kills))))

(ert-deftest retirement-resume-and-dry-run-reporting ()
  (retirement-fixture
   (should-not (retirement-run))
   ;; Resumed: never retire, and forget the earlier observation.
   (retirement-task (car retirement-agenda) "AUTO")
   (should-not (retirement-run))
   (should-not (org-dispatch--retire-seen))
   (retirement-task (car retirement-agenda) "DONE")
   (should-not (retirement-run))
   ;; The dry run reports the same verdict without killing anything.
   (let* ((command-line-args-left (list "--dry-run"))
          (out (with-output-to-string (org-dispatch-reconcile)))
          (row (aref (json-parse-string out) 0)))
     (should (eq t (gethash "close" row)))
     (should (equal (gethash "terminal" row) "t7"))
     (should (equal (gethash "run" row) "run-1")))
   (should-not (retirement-kills))
   ;; A terminal without dispatcher labels is never a candidate.
   (setq retirement-workers (list (retirement-worker nil nil '((org.dispatch . "kit") (where . "june / 1")))))
   (should (retirement-reason "missing dispatcher identity labels"))
   (should-not (retirement-run))
   (should-not (retirement-kills))))

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
     (should (retirement-reason "no task with this worker's ID"))
     ;; DONE then immediately archived: found in the sibling archive.
     (with-temp-file archive (insert text))
     (should (equal (org-dispatch--todo-state state) "DONE"))
     (org-dispatch--watch state)
     (should-not (org-dispatch--states))
     (should (plist-get (retirement-row) :eligible))
     (should-not (retirement-run))
     (should (equal (retirement-run) '("t7")))
     (should (equal text (with-temp-buffer (insert-file-contents archive) (buffer-string))))
     ;; Copy-before-delete archive ordering is never treated as one task.
     (setq retirement-workers (list (retirement-worker)))
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

(ert-deftest retirement-agent-states-and-session-links ()
  (retirement-fixture
   (dolist (agent '("pi" "claude"))
     (retirement-task (car retirement-agenda) "DONE" nil agent)
     (dolist (status '("idle" "done" "working" "blocked" "unknown"))
       (setq retirement-workers (list (retirement-worker status agent)))
       (should (eq (plist-get (retirement-row) :eligible)
                   (and (member status '("idle" "done")) t)))))
   ;; The worker's agent must match the Org link's.
   (retirement-task (car retirement-agenda) "DONE" nil "claude")
   (setq retirement-workers (list (retirement-worker nil "pi")))
   (should (retirement-reason "task does not link this session"))))

(ert-deftest retirement-requires-this-tasks-labels-and-a-reopenable-session ()
  (retirement-fixture
   (setq retirement-workers
         (list (retirement-worker nil nil `((org.dispatch . "kit") (org.task . "99999999-0000-4000-8000-000000000001")
                                            (org.run . "run-1") (org.agent . "pi") (org.session . ,retirement-session)))))
   (should (retirement-reason "no task with this worker's ID"))
   (should (retirement-reason "session shared by another task record"))
   (setq retirement-workers (list (retirement-worker)))
   (let ((retirement-reopenable nil))
     (should (retirement-reason "cannot be reopened")))))

(ert-deftest retirement-shared-review-and-active-sessions ()
  (retirement-fixture
   ;; Another task links the same session.
   (with-temp-file (car retirement-agenda)
     (insert (format "* DONE Probe\n:PROPERTIES:\n:ID: %s\n:END:\n** Sessions\n- [[herdr:kit/pi:%s@t7][probe]]\n* DONE Other\n:PROPERTIES:\n:ID: other\n:END:\n- [[herdr:kit/pi:%s@t7][same]]\n"
                     retirement-id retirement-session retirement-session)))
   (should (retirement-reason "shared by another task"))
   (retirement-task (car retirement-agenda) "DONE")
   ;; Two live workers on one session.
   (let ((twin (retirement-worker)))
     (setf (alist-get 'address twin) "t8")
     (setq retirement-workers (list (retirement-worker) twin)))
   (should (retirement-reason "multiple live terminals"))
   (setq retirement-workers (list (retirement-worker)))
   ;; A running dispatcher state for this terminal.
   (org-dispatch--save-state (plist-put (retirement-state) :status "running"))
   (should (retirement-reason "active dispatcher run"))
   (org-dispatch--drop-state retirement-id)
   (org-dispatch--edit (car retirement-agenda) retirement-id (lambda () (org-entry-put nil "DEV_REVIEW" "{}")))
   (should (retirement-reason "review workflow"))))

(ert-deftest retirement-conflict-copies-block ()
  (retirement-fixture
   (let ((conflict (concat (file-name-sans-extension (car retirement-agenda)) ".sync-conflict-20261109-000000-ABC.org")))
     (with-temp-file conflict (insert "* DONE Probe\n"))
     (should (retirement-reason "conflict copy")))))

(ert-deftest retirement-changes-during-one-inventory-block-the-worker ()
  (retirement-fixture
   ;; The worker's turn moves between the two lists of one inventory.
   (let ((retirement-next (let ((n 0))
                            (lambda () (when (= (cl-incf n) 2)
                                         (setf (alist-get 'turn (car retirement-workers)) 5))))))
     (should (seq-some (lambda (reason) (string-search "changed during inventory" reason))
                       (plist-get (retirement-row) :skip))))
   ;; Resumed between the two Org reads of one inventory.
   (let ((retirement-next (let ((n 0))
                            (lambda () (when (= (cl-incf n) 2)
                                         (retirement-task (car retirement-agenda) "AUTO"))))))
     (should (seq-some (lambda (reason) (string-search "Org records" reason))
                       (plist-get (retirement-row) :skip))))))

(ert-deftest retirement-is-off-unless-enabled ()
  (retirement-fixture
   (let ((org-dispatch--defaults (make-hash-table :test 'equal)))
     (should-not (org-dispatch--retire-enabled))
     (puthash "retire" t org-dispatch--defaults)
     (should (org-dispatch--retire-enabled)))))

(ert-deftest retirement-errors-keep-the-worker ()
  (retirement-fixture
   (should-not (retirement-run))
   (cl-letf (((symbol-function 'org-dispatch--hc)
              (lambda (&rest args) (if (equal (car args) "kill") (error "kill failed")
                                     (apply #'retirement-hc args)))))
     (should-not (retirement-run)))
   (should (= 1 (length retirement-workers)))
   (cl-letf (((symbol-function 'org-dispatch--hc) (lambda (&rest _) (error "core unavailable"))))
     (should-error (org-dispatch--reconcile-panes retirement-agenda)))))

(ert-run-tests-batch-and-exit)
