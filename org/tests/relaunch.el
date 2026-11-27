;;; relaunch.el --- One worker per task, whatever the Org file says -*- lexical-binding: t; -*-
;; A sync conflict can put a claimed heading back to AUTO while its worker runs (Jon, 2026-11-26: null launched
;; twice). hc is mocked: ls and get answer from fixture terminals, and run only records the call.
(require 'ert)
(require 'cl-lib)

(defconst relaunch-id "abcdef12-0000-4000-8000-0000000000aa")
(defconst relaunch-session "01234567-89ab-cdef-0123-4567890000aa")
(defvar relaunch-workers nil "Fake live terminals.")
(defvar relaunch-agenda nil)
(defvar relaunch-calls nil)

(defun relaunch-worker (&optional status run)
  (copy-tree
   `((address . "t7") (state . "live") (status . ((state . ,(or status "working"))))
     (labels . ((org.dispatch . "kit") (org.task . ,relaunch-id) (org.run . ,(or run "run-1"))
                (org.agent . "pi") (org.session . ,relaunch-session))))
   t))

(defun relaunch-hc (&rest args)
  (push args relaunch-calls)
  (pcase args
    (`("ls" "--label" ,(pred (string-prefix-p "org.task=")))
     `((terminals . ,(vconcat (mapcar (lambda (w) `((address . ,(alist-get 'address w)) (state . "live")
                                                    (status . ,(alist-get 'state (alist-get 'status w)))))
                                      relaunch-workers)))))
    (`("get" ,address)
     (or (seq-find (lambda (w) (equal (alist-get 'address w) address)) relaunch-workers)
         (signal 'org-dispatch-hc (list "not_found" address))))
    (`("run" . ,_) '((address . "t8")))
    (_ (error "Unexpected hc call: %S" args))))

(defun relaunch-file (todo)
  (let ((file (car relaunch-agenda)))
    (make-directory (file-name-directory file) t)
    (with-temp-file file
      (insert (format "* %s Probe :kit:\n:PROPERTIES:\n:ID: %s\n:HOST: kit\n:AGENT: pi\n:END:\n" todo relaunch-id)))))

(defun relaunch-state (&optional status)
  (list :id relaunch-id :file (car relaunch-agenda) :heading "Probe" :agent "pi" :session relaunch-session
        :host "kit" :terminal "t7" :run "run-1" :status (or status "running") :started (float-time)))

(defun relaunch-heading ()
  (with-temp-buffer (insert-file-contents (car relaunch-agenda)) (buffer-string)))

(defun relaunch-calls-to (command)
  (seq-filter (lambda (args) (equal (car args) command)) relaunch-calls))

(defmacro relaunch-fixture (&rest body)
  `(let* ((root (make-temp-file "relaunch-probe-" t))
          (org-dispatch-root (expand-file-name "org" root))
          (org-dispatch-state-dir (expand-file-name "state" root))
          (org-dispatch-host "kit")
          (relaunch-agenda (list (expand-file-name "work/probe/probe.org" org-dispatch-root)))
          (relaunch-workers (list (relaunch-worker)))
          (relaunch-calls nil))
     (unwind-protect
         (cl-letf (((symbol-function 'org-dispatch--hc) #'relaunch-hc)
                   ((symbol-function 'org-dispatch--agenda-files) (lambda (&rest _) relaunch-agenda)))
           ,@body)
       (delete-directory root t))))

(ert-deftest relaunch-auto-with-a-live-worker-is-claimed-again ()
  (dolist (status '("working" "blocked" "idle"))
    (relaunch-fixture
     (setq relaunch-workers (list (relaunch-worker status)))
     (relaunch-file "AUTO")
     (let ((state (relaunch-state)))
       (org-dispatch--save-state state)
       (org-dispatch--watch state))
     (should (string-match-p "^\\* PROG Probe" (relaunch-heading)))
     (should (equal (mapcar (lambda (s) (plist-get s :status)) (org-dispatch--states)) '("running")))
     (should-not (seq-some (lambda (args) (member (car args) '("kill" "interrupt" "send" "run"))) relaunch-calls)))))

(ert-deftest relaunch-auto-with-the-worker-gone-ends-the-run ()
  (relaunch-fixture
   (setq relaunch-workers nil)
   (relaunch-file "AUTO")
   (let ((state (relaunch-state)))
     (org-dispatch--save-state state)
     (org-dispatch--watch state))
   (should (string-match-p "^\\* AUTO Probe" (relaunch-heading)))
   (should-not (org-dispatch--states))))

(ert-deftest relaunch-another-runs-terminal-is-not-this-runs-worker ()
  (relaunch-fixture
   (setq relaunch-workers (list (relaunch-worker "working" "run-other")))
   (relaunch-file "AUTO")
   (let ((state (relaunch-state)))
     (org-dispatch--save-state state)
     (org-dispatch--watch state))
   (should (string-match-p "^\\* AUTO Probe" (relaunch-heading)))))

(ert-deftest relaunch-finished-and-retried-runs-stay-auto ()
  ;; finish and retry mark the run finished before a repeat or retry leaves the heading at AUTO.
  (relaunch-fixture
   (relaunch-file "AUTO")
   (let ((state (relaunch-state "finished")))
     (org-dispatch--save-state state)
     (org-dispatch--watch state))
   (should (string-match-p "^\\* AUTO Probe" (relaunch-heading)))))

(ert-deftest relaunch-busy-workers-are-only-the-working-and-blocked ()
  (relaunch-fixture
   (dolist (case '(("working" . ("t7")) ("blocked" . ("t7")) ("idle" . nil) ("done" . nil)))
     (setq relaunch-workers (list (relaunch-worker (car case))))
     (should (equal (org-dispatch--busy-workers relaunch-id) (cdr case))))))

(ert-deftest relaunch-launch-holds-beside-a-busy-worker ()
  (relaunch-fixture
   (relaunch-file "AUTO")
   (let ((task (org-dispatch--edit (car relaunch-agenda) relaunch-id #'org-dispatch--task "Probe")))
     (should-not (org-dispatch--launch task))
     (should-not (relaunch-calls-to "run"))
     (should (string-match-p "^\\* AUTO Probe" (relaunch-heading)))
     ;; An unreachable core holds it too.
     (cl-letf (((symbol-function 'org-dispatch--hc)
                (lambda (&rest _) (signal 'org-dispatch-hc (list "failed" "hc ls: core unavailable")))))
       (should-not (org-dispatch--launch task))))))

(ert-run-tests-batch-and-exit)
