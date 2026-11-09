;;; content.el --- Task title/scope edits on private fixtures -*- lexical-binding: t; -*-
(require 'ert)
(require 'org-edit)

(defvar test-content-file)
(defvar test-content-key "fixture:edit")
(defconst test-content-original
  "* TODO [#A] Old task :kit:work:\nSCHEDULED: <2026-11-23 Mon> DEADLINE: <2026-11-27 Fri>\n:PROPERTIES:\n:ID: content-task\n:DEPENDS: id:keep\n:REVIEW: yes\n:END:\nHistorical approval note.\n\n** Scope\nOld scope.\n\n** Checklist\n- [X] Keep this.\n\n** Dialog\n- Jon [2026-11-09 Mon 10:00]: Original instruction.\n\n* TODO Neighbor\nUntouched.\n")

(defmacro test-with-content (&rest body)
  (declare (indent 0))
  `(let* ((root (make-temp-file "org-content-fixture-" t))
          (org-dispatch-root root) (org-directory root) (org-dispatch-host "kit")
          (org-dispatch-emacs-init (expand-file-name "no-init.el" root))
          (org-dispatch-state-dir (expand-file-name "state" root))
          (org-id-locations-file (expand-file-name "id-locations" root))
          (org-id-track-globally nil)
          (test-content-file (expand-file-name "tasks.org" root))
          (test-content-key "fixture:edit"))
     (unwind-protect
         (progn (with-temp-file test-content-file (insert test-content-original)) ,@body)
       (delete-directory root t))))

(defun test-content-read ()
  (with-temp-buffer (insert-file-contents test-content-file) (buffer-string)))

(defun test-content-revision ()
  (let (revision)
    (org-edit--at test-content-file "Old task"
      (lambda () (setq revision (secure-hash 'sha256 (encode-coding-string
        (replace-regexp-in-string "\n+\\'" "" (org-dispatch--subtree-text)) 'utf-8)))) t)
    revision))

(defun test-content-update (revision &rest fields)
  (let ((command-line-args-left
         (list test-content-file "Old task"
           (json-serialize (append (list :revision revision :request test-content-key
                                        :note "Jon asked to reflect the approved work.") fields)))))
    (org-edit-update-task)))

(ert-deftest content-updates-title-and-scope-with-history-and-replays-after-rename ()
  (test-with-content
    (let ((revision (test-content-revision)))
      (test-content-update revision :title "Verify access" :scope "Check access.\n- Keep permissions.")
      (let ((after (test-content-read)))
        (should (string-prefix-p "* TODO [#A] Verify access :kit:work:\nSCHEDULED:" after))
        (should (string-search "** Scope\nCheck access.\n- Keep permissions.\n\n** Checklist\n- [X] Keep this." after))
        (should (string-search "Previous content (JSON):" after))
        (should (string-search "Old scope." after))
        (should (string-search "- Jon [2026-11-09 Mon 10:00]: Original instruction." after))
        (should (string-search ":DEPENDS: id:keep\n:REVIEW: yes" after))
        (should (string-suffix-p "* TODO Neighbor\nUntouched.\n" after))
        (test-content-update revision :title "Verify access" :scope "Check access.\n- Keep permissions.")
        (should (equal after (test-content-read)))
        (should-error (test-content-update revision :title "Different request"))
        (should (equal after (test-content-read)))))))

(ert-deftest content-refuses-stale-reads-and-structural-injection-without-writing ()
  (test-with-content
    (should-error (test-content-update (make-string 64 ?0) :title "New"))
    (dolist (title '("" " padded" "TODO Sneak" "[#B] Sneak" "* Sibling" "Sneak :tag:" "two\nlines"))
      (should-error (test-content-update (test-content-revision) :title title)))
    (dolist (scope '("" "** Dialog\nLost" ":PROPERTIES:\n:HOST: cog\n:END:" "SCHEDULED: <2026-11-10 Tue>" "#+TODO: BAD | GOOD"))
      (should-error (test-content-update (test-content-revision) :scope scope)))
    (should (equal test-content-original (test-content-read)))))

(ert-deftest content-refuses-dispatch-review-and-ambiguous-scope ()
  (test-with-content
    (dolist (change '("* AUTO Old task\n" "* PROG Old task\n" "* DONE Old task\n"
                      "* TODO Old task\n:PROPERTIES:\n:DEV_REVIEW: contract\n:END:\n"
                      "* TODO Old task\n:PROPERTIES:\n:REVIEW_PARENT: parent\n:END:\n"
                      "* TODO Old task\n** Scope\nFirst\n** Scope\nSecond\n"
                      "* TODO Old task\n** Scope\nText\n*** Child\nKeep\n"))
      (with-temp-file test-content-file (insert change))
      (should-error (test-content-update (test-content-revision) :title "New" :scope "New scope"))
      (should (equal change (test-content-read))))))

(ert-deftest content-replaces-legacy-scope-and-retains-it-in-dialog ()
  (test-with-content
    (with-temp-file test-content-file
      (insert "* TODO Old task\nSCHEDULED: <2026-11-23 Mon>\nOld historical prose.\n\n** Dialog\n- Jon: Keep this.\n"))
    (test-content-update (test-content-revision) :title "Verify access" :scope "Approved. Verify access next.")
    (let ((after (test-content-read)))
      (should (string-search ":END:\nApproved. Verify access next.\n\n** Dialog" after))
      (should-not (string-search "\nOld historical prose.\n" after))
      (should (string-search "Old historical prose." after))
      (should (string-search "- Jon: Keep this." after))
      (should (string-search "SCHEDULED: <2026-11-23 Mon>" after))
      (should (string-search ":ID:" after)))))

(ert-deftest content-refuses-conflicts-and-protected-files ()
  (test-with-content
    (let ((revision (test-content-revision)))
      (with-temp-file (expand-file-name "tasks.sync-conflict-fixture.org" org-directory))
      (should-error (test-content-update revision :title "New"))
      (delete-file (expand-file-name "tasks.sync-conflict-fixture.org" org-directory))
      (dolist (name '("asana.org" "inbox.org" "archive.org"))
        (let ((test-content-file (expand-file-name name org-directory)))
          (with-temp-file test-content-file (insert test-content-original))
          (should-error (test-content-update revision :title "New"))
          (should (equal test-content-original (test-content-read))))))))

(ert-deftest content-refuses-duplicate-identities-and-concurrent-disk-edits ()
  (test-with-content
    (let ((duplicate (expand-file-name "duplicate.org" org-directory)))
      (with-temp-file duplicate (insert "* TODO Duplicate\n:PROPERTIES:\n:ID: content-task\n:END:\n"))
      (should (string-match-p "duplicate task ID"
                (error-message-string (should-error (test-content-update (test-content-revision) :title "New")))))
      (delete-file duplicate))
    (let ((verify (symbol-function 'verify-visited-file-modtime)))
      (cl-letf (((symbol-function 'verify-visited-file-modtime)
                 (lambda (buffer)
                   (with-temp-buffer
                     (insert test-content-original "Concurrent author's text.\n")
                     (write-region (point-min) (point-max) test-content-file nil 'silent))
                   (funcall verify buffer))))
        (should (string-match-p "changed on disk"
                  (error-message-string (should-error (test-content-update (test-content-revision) :title "New")))))))
    (should (equal (test-content-read) (concat test-content-original "Concurrent author's text.\n")))))

(ert-deftest content-title-only-and-scope-only-preserve-the-other-field ()
  (test-with-content
    (test-content-update (test-content-revision) :scope "New scope only.")
    (should (string-prefix-p "* TODO [#A] Old task :kit:work:" (test-content-read)))
    (let ((test-content-key "fixture:title"))
      (test-content-update (test-content-revision) :title "New title only"))
    (should (string-search "** Scope\nNew scope only.\n\n** Checklist" (test-content-read)))))

(ert-deftest content-refuses-active-receipts-and-workers ()
  (test-with-content
    (dolist (status '("starting" "running" "stopping" "launch-uncertain"))
      (org-dispatch--save-state (list :id "content-task" :status status))
      (let ((error (error-message-string (should-error (test-content-update (test-content-revision) :title "New")))))
        (should (string-match-p "active or uncertain\\|stop is pending\\|ownership is uncertain" error)))
      (should (equal test-content-original (test-content-read))))
    (org-dispatch--drop-state "content-task")
    (org-edit--at test-content-file "Old task"
      (lambda () (org-dispatch--append "Sessions" "- [[herdr:kit/pi:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa][worker]]")) t)
    (let ((before (test-content-read)))
      (cl-letf (((symbol-function 'org-dispatch--herdr)
                 (lambda (&rest _) '((result . ((agents . [((agent . "pi") (agent_status . "working")
                    (agent_session . ((value . "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"))))])))))))
        (should (string-match-p "identity-bound interruption"
                  (error-message-string (should-error (test-content-update (test-content-revision) :title "New"))))))
      (cl-letf (((symbol-function 'org-dispatch--herdr)
                 (lambda (&rest _) '((result . ((agents . [((agent . "pi") (agent_status . "unknown")
                    (agent_session . ((value . "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"))))])))))))
        (should (string-match-p "worker status is unknown"
                  (error-message-string (should-error (test-content-update (test-content-revision) :title "New"))))))
      (should (equal before (test-content-read))))))

(ert-run-tests-batch-and-exit)
