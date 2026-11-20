;;; stop.el --- Isolated dispatcher stop tests -*- lexical-binding: t; -*-
(require 'ert)
(require 'org-edit)

(defvar test-stop-file)
(defvar test-stop-status)
(defvar test-stop-calls)
(defvar test-stop-agent "claude")
(defvar test-stop-run "run-1")
(defvar test-stop-after-interrupt "idle" "Status the worker settles to when interrupted.")
(defvar test-stop-kill-works t)
(defvar test-stop-session "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
(defvar test-stop-labels nil "Labels to use instead of the run's own, to fake a changed identity.")
(defconst test-stop-id "00000000-0000-0000-0000-000000000099")

(defun test-stop-record ()
  "The fake worker t-exact, built from the test variables."
  `((address . "t-exact") (state . ,(if (equal test-stop-status "gone") "finished" "live"))
    (status . ,(and (not (member test-stop-status '("gone" "unknown"))) `((state . ,test-stop-status))))
    (turn . 1) (status_ms . 1) (pid . 7)
    (labels . ,(or test-stop-labels
                   `((org.dispatch . "kit") (org.task . ,test-stop-id) (org.run . ,test-stop-run)
                     (org.agent . ,test-stop-agent) (org.session . ,test-stop-session))))))

(defun test-stop-hc (&rest args)
  (push args test-stop-calls)
  (pcase args
    (`("ls" "--all" "--label" ,filter)
     `((terminals . ,(if (equal filter (concat "org.session=" (alist-get 'org.session (alist-get 'labels (test-stop-record)))))
                         (vector `((address . "t-exact") (state . ,(alist-get 'state (test-stop-record)))))
                       []))))
    (`("get" "t-exact") (test-stop-record))
    (`("get" "t-human-shell") '((address . "t-human-shell") (state . "live") (labels)))
    (`("get" "t-new") `((address . "t-new") (state . "live") (status (state . "working"))
                        (labels (org.task . ,test-stop-id) (org.run . "run-2") (org.agent . "claude")
                                (org.session . "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"))))
    (`("get" ,address) (signal 'org-dispatch-hc (list "not_found" (concat "no terminal " address))))
    (`("interrupt" "t-exact") (setq test-stop-status test-stop-after-interrupt) '((outcome . "stopped")))
    (`("kill" "t-exact") (when test-stop-kill-works (setq test-stop-status "gone")) '((reason . "killed")))
    (_ (error "unexpected hc call %S" args))))

(defmacro test-with-stop (&rest body)
  (declare (indent 0))
  `(let* ((root (make-temp-file "org-stop-test" t))
          (org-dispatch-root root) (org-dispatch-state-dir (expand-file-name "state" root))
          (org-dispatch-emacs-init (expand-file-name "no-init.el" root))
          (test-stop-file (expand-file-name "task.org" root))
          (test-stop-status "idle") (test-stop-calls nil) (test-stop-agent "claude")
          (test-stop-after-interrupt "idle") (test-stop-kill-works t) (test-stop-labels nil)
          (process-environment (copy-sequence process-environment))
          (test-stop-session "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"))
     (unwind-protect
         (progn
           ;; Callers count as workers by these too; a test run inside an agent must not inherit them.
           (setenv "HC_TERMINAL_ID" nil)
           (setenv "CLAUDECODE" nil)
           (setenv "PI_SESSION_ID" nil)
           (with-temp-file test-stop-file
             (insert "* PROG Task :auto:\n:PROPERTIES:\n:ID: " test-stop-id
                     "\n:HOST: kit\n:AGENT: claude\n:RETRY: 2\n:DEPENDS: id:keep\n:END:\nBody stays.\n\n** Sessions\n- [[herdr:kit/claude:"
                     test-stop-session "@t-exact][old worker]]\n\n** Dialog\n- Jon [2026-11-09 Mon 09:39]: use pi\n"))
           (org-dispatch--save-state
            (list :id test-stop-id :file test-stop-file :heading "Task" :agent "claude" :host "kit"
                  :terminal "t-exact" :run test-stop-run :session test-stop-session :status "running" :dir root
                  :started (float-time) :nudges 0))
           (cl-letf (((symbol-function 'org-dispatch--hc) #'test-stop-hc)
                     ((symbol-function 'sleep-for) #'ignore))
             ,@body))
       (delete-directory root t))))

(defun test-stop-sent (verb)
  (seq-find (lambda (args) (equal (car args) verb)) test-stop-calls))

(defun test-stop-revision ()
  (org-dispatch--edit test-stop-file test-stop-id
   (lambda () (secure-hash 'sha256 (encode-coding-string
     (replace-regexp-in-string "\n+\\'" "" (org-dispatch--subtree-text)) 'utf-8)))))

(defun test-stop (&optional revision key)
  (let ((command-line-args-left
         (list test-stop-file (concat "id:" test-stop-id) "--revision" (or revision (test-stop-revision))
               "--request" (or key "test:stop") "--note" "Jon asked to stop Claude and use pi.")))
    (org-edit-stop-task)))

(ert-deftest stop-parks-before-confirmation-and-preserves-history ()
  (test-with-stop
    (let ((revision (test-stop-revision)))
      (test-stop revision)
      (should (equal (plist-get (car (org-dispatch--states)) :status) "stopped"))
      ;; A settled worker is left running; nothing is typed, interrupted or killed.
      (should-not (seq-find (lambda (args) (member (car args) '("send" "keys" "interrupt" "kill"))) test-stop-calls))
      (org-dispatch--edit test-stop-file test-stop-id
       (lambda ()
         (should (equal (org-get-todo-state) "HOLD"))
         (should-not (member "auto" (org-get-tags nil t)))
         (should (equal (org-entry-get nil "AGENT") "claude"))
         (should (equal (org-entry-get nil "RETRY") "2"))
         (should (equal (org-entry-get nil "DEPENDS") "id:keep"))
         (should (string-search "Body stays." (org-dispatch--subtree-text)))
         (should (string-search "old worker" (org-dispatch--subtree-text)))
         (should (string-search "- Jon [2026-11-09 Mon 09:39]: use pi" (org-dispatch--subtree-text)))
         (should (string-search "Worker t-exact was not working and was left running." (org-dispatch--subtree-text)))
         (should-not (plist-get (org-dispatch--task) :session))))
      (let ((before test-stop-calls))
        (test-stop revision)
        (should (equal test-stop-calls before)))
      (org-dispatch--watch (car (org-dispatch--states)))
      (should (org-dispatch--states)))))

(ert-deftest stop-interrupts-a-working-worker-and-records-it ()
  (dolist (status '("working" "blocked" "unknown"))
    (test-with-stop
      (setq test-stop-status status)
      (test-stop)
      (should (equal (test-stop-sent "interrupt") '("interrupt" "t-exact")))
      (should-not (test-stop-sent "kill"))
      (should (equal (plist-get (car (org-dispatch--states)) :status) "stopped"))
      (org-dispatch--edit test-stop-file test-stop-id
        (lambda ()
          (should (equal (org-get-todo-state) "HOLD"))
          (should (org-entry-get nil "JUNE_STOPPED"))
          (should (string-search "Worker t-exact stopped its turn at the interrupt." (org-dispatch--subtree-text))))))))

(ert-deftest stop-kills-a-worker-that-ignores-the-interrupt ()
  (test-with-stop
    (setq test-stop-status "working" test-stop-after-interrupt "working")
    (test-stop)
    (should (test-stop-sent "interrupt"))
    (should (equal (test-stop-sent "kill") '("kill" "t-exact")))
    (should (equal (plist-get (car (org-dispatch--states)) :status) "stopped"))
    (org-dispatch--edit test-stop-file test-stop-id
      (lambda () (should (string-search "did not stop at the interrupt and was killed" (org-dispatch--subtree-text)))))))

(ert-deftest stop-confirms-a-worker-that-already-exited ()
  (test-with-stop
    (setq test-stop-status "gone")
    (test-stop)
    (should-not (seq-find (lambda (args) (member (car args) '("interrupt" "kill"))) test-stop-calls))
    (org-dispatch--edit test-stop-file test-stop-id
      (lambda () (should (string-search "Worker t-exact had already exited." (org-dispatch--subtree-text)))))))

(ert-deftest stop-refuses-stale-remote-duplicate-and-unmanaged-tasks ()
  (test-with-stop
    (should-error (test-stop (make-string 64 ?0)))
    (should-not test-stop-calls)
    (org-dispatch--edit test-stop-file test-stop-id (lambda () (org-entry-put nil "HOST" "cog")))
    (should-error (test-stop))
    (should-not test-stop-calls)
    (org-dispatch--edit test-stop-file test-stop-id (lambda () (org-entry-put nil "HOST" "kit")))
    (with-temp-file (expand-file-name "duplicate.org" org-dispatch-root)
      (insert "* TODO Duplicate\n:PROPERTIES:\n:ID: " test-stop-id "\n:END:\n"))
    (should-error (test-stop))
    (delete-file (expand-file-name "duplicate.org" org-dispatch-root))
    (org-dispatch--drop-state test-stop-id)
    (should-error (test-stop))
    (should-not test-stop-calls)))

(ert-deftest stop-never-touches-another-runs-terminal ()
  ;; The run's address now carries another session or run: fail closed, touch nothing.
  (dolist (labels `(((org.task . ,test-stop-id) (org.run . "run-2") (org.agent . "claude")
                     (org.session . "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"))
                    ((org.task . ,test-stop-id) (org.run . "run-2") (org.agent . "claude")
                     (org.session . "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"))
                    nil-labels))
    (test-with-stop
      (setq test-stop-status "working"
            test-stop-labels (if (eq labels 'nil-labels) '((where . "june / 1")) labels))
      (should-error (test-stop))
      (should-not (seq-find (lambda (args) (member (car args) '("interrupt" "kill" "send" "keys"))) test-stop-calls))
      (should (equal (plist-get (car (org-dispatch--states)) :status) "stopping"))
      (org-dispatch--edit test-stop-file test-stop-id
        (lambda () (should (equal (org-get-todo-state) "HOLD"))
          (should-not (org-entry-get nil "JUNE_STOPPED")))))))

(ert-deftest failed-stop-stays-parked-and-cannot-resume-finish-or-retry ()
  (test-with-stop
    (setq test-stop-status "working" test-stop-after-interrupt "working" test-stop-kill-works nil)
    (should-error (test-stop))
    (should (equal (org-dispatch--edit test-stop-file test-stop-id #'org-get-todo-state) "HOLD"))
    (let ((state (car (org-dispatch--states))))
      (should (equal (plist-get state :status) "stopping"))
      (org-dispatch--watch state)
      (should (equal (plist-get (car (org-dispatch--states)) :status) "stopping")))
    (let ((command-line-args-left (list test-stop-file (concat "id:" test-stop-id) "AUTO"
                                       "--expect" "HOLD" "--request" "new" "--host" "kit" "--agent" "pi" "--note" "Jon asked.")))
      (should-error (org-edit-todo)))
    (let ((command-line-args-left (list test-stop-id "EVAL" "late result")))
      (should-error (org-dispatch-finish)))
    (let ((command-line-args-left (list test-stop-id "+1d" "late retry")))
      (should-error (org-dispatch-retry)))
    (setq test-stop-status "idle")
    (test-stop (make-string 64 ?0) "test:new-tool-call")
    (should (equal (plist-get (car (org-dispatch--states)) :status) "stopped"))))

(ert-deftest stopped-task-can-reassign-without-replay-stopping-the-next-run ()
  (test-with-stop
    (test-stop)
    (let ((command-line-args-left (list test-stop-file (concat "id:" test-stop-id) "AUTO"
                                       "--expect" "HOLD" "--request" "new" "--host" "kit" "--agent" "pi" "--note" "Jon asked.")))
      (org-edit-todo))
    (org-dispatch--edit test-stop-file test-stop-id
      (lambda () (should (equal (org-entry-get nil "AGENT") "pi")) (should (equal (org-get-todo-state) "AUTO"))))
    (let ((before test-stop-calls))
      (test-stop (make-string 64 ?0))
      (should (equal before test-stop-calls)))
    (should (equal (org-dispatch--edit test-stop-file test-stop-id #'org-get-todo-state) "AUTO"))))

(ert-deftest stop-unavailable-hc-stays-unconfirmed ()
  (dolist (failure '(core-down ambiguous))
    (test-with-stop
      (cl-letf (((symbol-function 'org-dispatch--hc)
                 (lambda (&rest args)
                   (pcase failure
                     ('core-down (signal 'org-dispatch-hc (list "connection" "core is down")))
                     ('ambiguous (if (equal (car args) "ls")
                                     '((terminals . [((address . "t-exact") (state . "live"))
                                                     ((address . "t-twin") (state . "live"))]))
                                   (apply #'test-stop-hc args)))))))
        (should-error (test-stop)))
      (should (equal (plist-get (car (org-dispatch--states)) :status) "stopping"))
      (org-dispatch--edit test-stop-file test-stop-id
        (lambda () (should (equal (org-get-todo-state) "HOLD"))
          (should-not (org-entry-get nil "JUNE_STOPPED")))))))

(ert-deftest stop-recovers-crash-before-org-save ()
  (test-with-stop
    (let ((state (plist-put (car (org-dispatch--states)) :status "stopping")))
      (org-dispatch--save-state (plist-put state :stop-request "test:interrupted-call")))
    (test-stop nil "test:new-tool-call")
    (should (equal (plist-get (car (org-dispatch--states)) :status) "stopped"))
    (org-dispatch--edit test-stop-file test-stop-id
      (lambda () (should (equal (org-entry-get nil "JUNE_STOPPED") "test:interrupted-call"))))))

(ert-deftest stop-receipt-recovers-state-save-crash-and-rejects-stale-worker ()
  (test-with-stop
    (test-stop)
    (let ((state (car (org-dispatch--states))))
      ;; Org confirmation is durable, but the final local save was interrupted.
      (org-dispatch--save-state (plist-put state :status "stopping"))
      (test-stop (make-string 64 ?0))
      (should (equal (plist-get (car (org-dispatch--states)) :status) "stopped"))
      (org-dispatch--save-state (plist-put (plist-put state :status "running") :terminal "t-new")))
    (let ((process-environment (copy-sequence process-environment)))
      (setenv "HC_TERMINAL_ID" "t-exact")
      (org-dispatch--edit test-stop-file test-stop-id
        (lambda () (should-error (org-dispatch--check-stopped-task t))))
      (setenv "HC_TERMINAL_ID" "t-new")
      (org-dispatch--edit test-stop-file test-stop-id (lambda () (org-dispatch--check-stopped-task t))))))

(ert-deftest stop-final-save-preserves-concurrent-dialog-and-refuses-state-change ()
  (dolist (change '(dialog state))
    (test-with-stop
      (cl-letf (((symbol-function 'org-dispatch--interrupt-session)
                 (lambda (_)
                   (org-dispatch--edit test-stop-file test-stop-id
                     (lambda ()
                       (if (eq change 'state) (org-todo "EVAL")
                         (org-dispatch--append "Dialog" "- Jon: A concurrent instruction."))))
                   "interrupted")))
        (if (eq change 'state)
            (progn (should-error (test-stop))
                   (should (equal (plist-get (car (org-dispatch--states)) :status) "stopping"))
                   (should (equal (org-dispatch--edit test-stop-file test-stop-id #'org-get-todo-state) "EVAL")))
          (test-stop)
          (org-dispatch--edit test-stop-file test-stop-id
            (lambda () (should (string-search "- Jon: A concurrent instruction." (org-dispatch--subtree-text))))))))))

(defun test-stop-todo (state)
  (let ((command-line-args-left (list test-stop-file (concat "id:" test-stop-id) state)))
    (org-edit-todo)))

(ert-deftest stop-repeated-switches-never-reuse-any-stopped-session ()
  (test-with-stop
    (test-stop)
    ;; An older installation left only the singular property. Preserve it too.
    (org-dispatch--edit test-stop-file test-stop-id
      (lambda () (org-entry-delete nil "JUNE_STOP_SESSIONS")))
    (let ((second "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"))
      (org-dispatch--edit test-stop-file test-stop-id
        (lambda ()
          (org-entry-put nil "AGENT" "pi")
          (org-todo "PROG")
          (let ((section (org-dispatch--section-bounds "Sessions")))
            (goto-char (cdr section))
            (insert "- [[herdr:kit/pi:" second "@t-exact][second worker]]\n\n"))))
      (org-dispatch--save-state
        (list :id test-stop-id :file test-stop-file :agent "pi" :host "kit" :terminal "t-exact"
              :run "run-2" :session second :status "running"))
      (let ((test-stop-session second) (test-stop-agent "pi") (test-stop-run "run-2"))
        (test-stop nil "test:second"))
      (dolist (agent '("claude" "pi" "claude"))
        (org-dispatch--edit test-stop-file test-stop-id
          (lambda ()
            (org-entry-put nil "AGENT" agent)
            (should-not (plist-get (org-dispatch--task) :session))))))))

(ert-deftest stop-general-todo-refuses-late-worker-writes-but-allows-human-and-june ()
  (test-with-stop
    (test-stop)
    (let ((process-environment (copy-sequence process-environment)))
      (setenv "HC_TERMINAL_ID" "t-exact")
      (dolist (state '("EVAL" "HOLD" "DONE" "TODO" "PROG" "AUTO"))
        (should-error (test-stop-todo state)))
      ;; A new worker now owns the task. The old terminal cannot overwrite it.
      (let ((state (car (org-dispatch--states))))
        (org-dispatch--save-state (plist-put (plist-put state :status "running") :terminal "t-new")))
      (dolist (state '("EVAL" "HOLD" "DONE" "TODO" "PROG" "AUTO"))
        (should-error (test-stop-todo state)))
      ;; The current worker can still report. Human hc shells and June's
      ;; daemon are not workers and retain state-edit authority too.
      (setenv "HC_TERMINAL_ID" "t-new")
      (test-stop-todo "EVAL")
      (setenv "PI_SESSION_ID" nil)
      (setenv "CLAUDECODE" nil)
      (setenv "HC_TERMINAL_ID" "t-human-shell")
      (test-stop-todo "HOLD")
      (setenv "HC_TERMINAL_ID" nil)
      (test-stop-todo "EVAL")
      (should (equal (org-dispatch--edit test-stop-file test-stop-id #'org-get-todo-state) "EVAL")))))

(ert-deftest stop-crash-before-org-save-rejects-general-worker-state-writes ()
  (test-with-stop
    ;; Local no-nudge state is durable, but the Org receipt was not saved.
    (let ((state (car (org-dispatch--states))))
      (org-dispatch--save-state (plist-put (plist-put state :status "stopping") :stop-request "test:crashed")))
    (setenv "HC_TERMINAL_ID" "t-exact")
    (dolist (state '("EVAL" "HOLD" "DONE" "TODO" "PROG" "AUTO"))
      (should-error (test-stop-todo state)))
    (should (equal (org-dispatch--edit test-stop-file test-stop-id #'org-get-todo-state) "PROG"))
    (setenv "HC_TERMINAL_ID" nil)
    (test-stop nil "test:recover")
    (should (equal (plist-get (car (org-dispatch--states)) :status) "stopped"))))

(ert-deftest a-stopped-worker-running-again-blocks-resume ()
  (test-with-stop
    (test-stop)
    (setq test-stop-status "working")
    (should-error (test-stop-todo "AUTO"))
    (setq test-stop-status "idle")
    (test-stop-todo "AUTO")
    (should (equal (org-dispatch--edit test-stop-file test-stop-id #'org-get-todo-state) "AUTO"))))

(ert-deftest stop-retries-never-send-prompts-and-confirm-only-a-later-result ()
  (test-with-stop
    (setq test-stop-status "working" test-stop-after-interrupt "working" test-stop-kill-works nil)
    (dotimes (attempt 3)
      (should-error (test-stop nil (format "test:retry-%s" attempt)))
      (org-dispatch--watch (car (org-dispatch--states)))
      (should-error (test-stop-todo "AUTO"))
      (let ((process-environment (copy-sequence process-environment)))
        (setenv "HC_TERMINAL_ID" "t-exact")
        (should-error (test-stop-todo "EVAL"))))
    ;; Only stop keys and kills, never a prompt.
    (should-not (seq-find (lambda (args) (member (car args) '("send" "keys"))) test-stop-calls))
    (org-dispatch--edit test-stop-file test-stop-id
      (lambda ()
        (should (equal (org-get-todo-state) "HOLD"))
        (should-not (org-entry-get nil "JUNE_STOPPED"))
        (should (= 1 (how-many "Stop requested; parked" (point) (point-max))))))
    (setq test-stop-status "idle")
    (test-stop nil "test:after-manual-stop")
    (should (equal (plist-get (car (org-dispatch--states)) :status) "stopped"))))

(ert-run-tests-batch-and-exit)
