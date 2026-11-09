;;; stop.el --- Isolated dispatcher stop tests -*- lexical-binding: t; -*-
(require 'ert)
(require 'org-edit)

(defvar test-stop-file)
(defvar test-stop-status)
(defvar test-stop-calls)
(defvar test-stop-session "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
(defconst test-stop-id "00000000-0000-0000-0000-000000000099")

(defun test-stop-herdr (&rest args)
  (push args test-stop-calls)
  (pcase args
    (`("agent" "list")
     `((result . ((agents . ,(if (equal test-stop-status "gone") []
                              (vector `((pane_id . "p-exact") (name . "auto-stop-test") (agent . "claude")
                                        (agent_status . ,test-stop-status)
                                        (agent_session . ((value . ,test-stop-session)))))))))))
    (`("agent" "send-keys" "auto-stop-test" "esc")
     ;; HOLD and the durable no-nudge state must precede any key press.
     (should (equal (org-dispatch--edit test-stop-file test-stop-id #'org-get-todo-state) "HOLD"))
     (should (equal (plist-get (car (org-dispatch--states)) :status) "stopping"))
     (setq test-stop-status "idle"))
    (_ (error "unexpected Herdr call %S" args))))

(defmacro test-with-stop (&rest body)
  (declare (indent 0))
  `(let* ((root (make-temp-file "org-stop-test" t))
          (org-dispatch-root root) (org-dispatch-state-dir (expand-file-name "state" root))
          (org-dispatch-emacs-init (expand-file-name "no-init.el" root))
          (test-stop-file (expand-file-name "task.org" root))
          (test-stop-status "working") (test-stop-calls nil)
          (test-stop-session "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"))
     (unwind-protect
         (progn
           (with-temp-file test-stop-file
             (insert "* PROG Task :auto:\n:PROPERTIES:\n:ID: " test-stop-id
                     "\n:HOST: kit\n:AGENT: claude\n:RETRY: 2\n:DEPENDS: id:keep\n:END:\nBody stays.\n\n** Sessions\n- [[herdr:kit/claude:"
                     test-stop-session "@p-exact][old worker]]\n\n** Dialog\n- Jon [2026-11-09 Mon 09:39]: use pi\n"))
           (org-dispatch--save-state
            (list :id test-stop-id :file test-stop-file :heading "Task" :agent "claude"
                  :pane "p-exact" :session test-stop-session :status "running" :dir root
                  :started (float-time) :nudges 0))
           (cl-letf (((symbol-function 'org-dispatch--herdr) #'test-stop-herdr)
                     ((symbol-function 'sleep-for) #'ignore))
             ,@body))
       (delete-directory root t))))

(defun test-stop-revision ()
  (org-dispatch--edit test-stop-file test-stop-id
   (lambda () (secure-hash 'sha256 (encode-coding-string
     (replace-regexp-in-string "\n+\\'" "" (org-dispatch--subtree-text)) 'utf-8)))))

(defun test-stop (&optional revision key)
  (let ((command-line-args-left
         (list test-stop-file (concat "id:" test-stop-id) "--revision" (or revision (test-stop-revision))
               "--request" (or key "test:stop") "--note" "Jon asked to stop Claude and use pi.")))
    (org-edit-stop-task)))

(ert-deftest stop-parks-before-interrupt-and-preserves-history ()
  (test-with-stop
    (let ((revision (test-stop-revision)))
      (test-stop revision)
      (should (equal (plist-get (car (org-dispatch--states)) :status) "stopped"))
      (should (= 1 (seq-count (lambda (args) (member "send-keys" args)) test-stop-calls)))
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
         (should-not (plist-get (org-dispatch--task) :session))))
      (let ((before test-stop-calls))
        (test-stop revision)
        (should (equal test-stop-calls before)))
      (org-dispatch--watch (car (org-dispatch--states)))
      (should (org-dispatch--states)))))

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

(ert-deftest stop-does-not-touch-a-replacement-worker ()
  (test-with-stop
    (let ((test-stop-session "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"))
      (test-stop))
    (should-not (seq-find (lambda (args) (member "send-keys" args)) test-stop-calls))
    (should (equal (plist-get (car (org-dispatch--states)) :status) "stopped"))))

(ert-deftest failed-interrupt-stays-parked-and-cannot-resume-finish-or-retry ()
  (test-with-stop
    (cl-letf (((symbol-function 'org-dispatch--herdr)
               (lambda (&rest args)
                 (if (member "send-keys" args) (error "transport failed")
                   (apply #'test-stop-herdr args)))))
      (should-error (test-stop)))
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

(ert-deftest stop-unknown-missing-identity-and-timeout-stay-unconfirmed ()
  (dolist (failure '(unknown missing-identity malformed-response timeout))
    (test-with-stop
      (let ((clock 0))
        (cl-letf (((symbol-function 'org-dispatch--herdr)
                   (lambda (&rest args)
                     (pcase failure
                       ('malformed-response '((result . nil)))
                       ('timeout (if (member "send-keys" args) nil (apply #'test-stop-herdr args)))
                       (_ (let ((test-stop-status (if (eq failure 'unknown) "unknown" test-stop-status))
                                (test-stop-session (unless (eq failure 'missing-identity) test-stop-session)))
                            (apply #'test-stop-herdr args)))))))
          (if (eq failure 'timeout)
              (cl-letf (((symbol-function 'float-time) (lambda (&rest _) (setq clock (+ clock 5)))))
                (should-error (test-stop)))
            (should-error (test-stop))))
        (should (equal (plist-get (car (org-dispatch--states)) :status) "stopping"))
        (org-dispatch--edit test-stop-file test-stop-id
          (lambda () (should (equal (org-get-todo-state) "HOLD"))
            (should-not (org-entry-get nil "JUNE_STOPPED"))))))))

(ert-deftest stop-pi-path-session-blocked-and-moved-named-worker ()
  (test-with-stop
    (let ((state (car (org-dispatch--states))))
      (org-dispatch--save-state (plist-put state :agent "pi")))
    (org-dispatch--edit test-stop-file test-stop-id
      (lambda ()
        (org-entry-put nil "AGENT" "pi")
        (goto-char (point-min))
        (while (search-forward "herdr:kit/claude:" nil t) (replace-match "herdr:kit/pi:" t t))))
    (setq test-stop-status "blocked")
    (cl-letf (((symbol-function 'org-dispatch--herdr)
               (lambda (&rest args)
                 (let ((response (copy-tree (apply #'test-stop-herdr args) t)))
                   (when (equal args '("agent" "list"))
                     (let ((agent (aref (org-dispatch--get response 'result 'agents) 0)))
                       (setcdr (assq 'agent agent) "pi")
                       (setcdr (assq 'pane_id agent) "p-moved")
                       (setcdr (assq 'value (alist-get 'agent_session agent))
                               (concat "/private/sessions/2026-11-09_" test-stop-session ".jsonl"))))
                   response))))
      (test-stop))
    (should (equal (plist-get (car (org-dispatch--states)) :status) "stopped"))
    (should (member '("agent" "send-keys" "auto-stop-test" "esc") test-stop-calls))))

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
      (org-dispatch--save-state (plist-put (plist-put state :status "running") :pane "p-new")))
    (let ((process-environment (copy-sequence process-environment)))
      (setenv "HERDR_PANE_ID" "p-exact")
      (org-dispatch--edit test-stop-file test-stop-id
        (lambda () (should-error (org-dispatch--check-stopped-task t))))
      (setenv "HERDR_PANE_ID" "p-new")
      (org-dispatch--edit test-stop-file test-stop-id (lambda () (org-dispatch--check-stopped-task t))))))

(ert-deftest stop-final-save-preserves-concurrent-dialog-and-refuses-state-change ()
  (dolist (change '(dialog state))
    (test-with-stop
      (cl-letf (((symbol-function 'org-dispatch--interrupt-session)
                 (lambda (_)
                   (org-dispatch--edit test-stop-file test-stop-id
                     (lambda ()
                       (if (eq change 'state) (org-todo "EVAL")
                         (org-dispatch--append "Dialog" "- Jon: A concurrent instruction.")))))))
        (if (eq change 'state)
            (progn (should-error (test-stop))
                   (should (equal (plist-get (car (org-dispatch--states)) :status) "stopping"))
                   (should (equal (org-dispatch--edit test-stop-file test-stop-id #'org-get-todo-state) "EVAL")))
          (test-stop)
          (org-dispatch--edit test-stop-file test-stop-id
            (lambda () (should (string-search "- Jon: A concurrent instruction." (org-dispatch--subtree-text))))))))))

(ert-run-tests-batch-and-exit)
