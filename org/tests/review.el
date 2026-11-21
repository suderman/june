;;; review.el --- Private Git and Org review-loop fixtures -*- lexical-binding: t; -*-
(require 'ert)
(require 'org-review)

(defvar test-review-file)
(defvar test-review-repo)
(defvar test-review-commit)
(defvar test-review-workers)

(defun test-review-worker (session status &optional address labels)
  "A fake live hc terminal running pi SESSION with STATUS (nil for none)."
  `((address . ,(or address "t-worker")) (state . "live")
    (status . ,(and status `((state . ,status))))
    (labels . ,(append labels `((org.agent . "pi") (org.session . ,session))))))

(defun test-review-hc (&rest args)
  "Answer only reads; any terminal input is a test failure."
  (pcase args
    (`("ls" "--all" "--label" ,filter)
     `((terminals . ,(vconcat (mapcar (lambda (worker) `((address . ,(alist-get 'address worker)) (state . "live")))
                                      (seq-filter (lambda (worker)
                                                    (equal filter (concat "org.session="
                                                                          (alist-get 'org.session (alist-get 'labels worker)))))
                                                  test-review-workers))))))
    (`("get" ,address)
     (or (seq-find (lambda (worker) (equal (alist-get 'address worker) address)) test-review-workers)
         (signal 'org-dispatch-hc (list "not_found" address))))
    (_ (error "unexpected hc input %S" args))))
(defconst test-review-id "00000000-0000-0000-0000-000000000001")
(defconst test-review-developer "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
(defconst test-review-reviewer "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")

(defmacro test-with-review (&rest body)
  (declare (indent 0))
  `(let* ((root (make-temp-file "org-review-test" t))
          (default-directory root)
          (org-dispatch-root (expand-file-name "org" root))
          (org-dispatch-state-dir (expand-file-name "state" root))
          (org-dispatch-emacs-init (expand-file-name "no-init" root))
          (test-review-file (expand-file-name "work/studio/app/app.org" org-dispatch-root))
          (test-review-repo (expand-file-name "source" root))
          (test-review-workers nil)
          (process-environment (copy-sequence process-environment)))
     (unwind-protect
         (progn
           (setenv "HOME" root)
           (setenv "HC_TERMINAL_ID" nil)
           (setenv "PI_SESSION_ID" nil)
           (setenv "CLAUDECODE" nil)
           (make-directory (file-name-directory test-review-file) t)
           (make-directory test-review-repo)
           (org-review--git test-review-repo "init" "-b" "main")
           (org-review--git test-review-repo "config" "user.name" "Review fixture")
           (org-review--git test-review-repo "config" "user.email" "fixture@example.invalid")
           (with-temp-file (expand-file-name "code.txt" test-review-repo) (insert "first\n"))
           (org-review--git test-review-repo "add" ".")
           (org-review--git test-review-repo "commit" "-m" "fixture")
           (let ((test-review-commit (org-review--git test-review-repo "rev-parse" "HEAD")))
             (with-temp-file test-review-file
               (insert "#+TITLE: App\n\n* EVAL Build app\n:PROPERTIES:\n:ID: " test-review-id
                       "\n:HOST: kit\n:AGENT: pi\n:DIR: " test-review-repo "\n:REVIEW: yes\n:DEPLOY: no\n:END:\nOriginal scope stays.\n\n** Outcome\nImplementation and checks.\n\n** Sessions\n- [[herdr:kit/pi:"
                       test-review-developer "@t-developer][original developer]]\n\n** Dialog\n- Jon [2026-11-09 Mon 12:00]: Fix in scope, no deployment.\n"))
             (cl-letf (((symbol-function 'org-dispatch--hc) #'test-review-hc)
                       ((symbol-function 'sleep-for) #'ignore))
               ,@body)))
       (dolist (buffer (buffer-list))
         (when-let* ((file (buffer-file-name buffer)))
           (when (file-in-directory-p file root)
             (with-current-buffer buffer (set-buffer-modified-p nil))
             (kill-buffer buffer))))
       (delete-directory root t))))

(defun test-review-at (id fn)
  (org-dispatch--edit test-review-file id fn))

(defun test-review-revision (&optional id)
  (test-review-at (or id test-review-id)
    (lambda () (secure-hash 'sha256 (encode-coding-string
      (replace-regexp-in-string "\n+\\'" "" (org-dispatch--subtree-text)) 'utf-8)))))

(defun test-review-loop ()
  (test-review-at test-review-id (lambda () (org-review--read "DEV_REVIEW"))))

(defun test-review-state (&optional id)
  (test-review-at (or id test-review-id) #'org-get-todo-state))

(defun test-review-command (action spec &optional id)
  (let ((command-line-args-left (list action test-review-file (concat "id:" (or id test-review-id))
                                     (org-review--json spec))))
    (org-edit-review)))

(defun test-review-start (&optional human)
  (test-review-command "start" (list :revision (test-review-revision) :commit test-review-commit
    :authorization "Jon delegated in-scope fixes and independent review."
    :permissions "Local checks allowed; commits/pushes already authorized for developer only; no remote writes, activation, services or deployment."
    :checks "Independent agent tests code and failure paths." :human human :agent "pi")))

(defun test-review-report (verdict &optional session)
  (let* ((loop (test-review-loop)) (id (plist-get loop :review))
         (agent (plist-get loop :agent))
         (session (or session test-review-reviewer)))
    (test-review-at id (lambda ()
      (org-todo "PROG")
      (org-dispatch--append "Sessions" (format "- [[herdr:kit/%s:%s@t-review][reviewer]]" agent session))))
    (org-dispatch--save-state (list :id id :file test-review-file :status "running" :agent agent :host "kit"
                                   :session session :terminal "t-review" :run "review-run"
                                   :started (float-time) :nudges 0
                                   :dir (plist-get loop :snapshot)))
    (let ((process-environment (copy-sequence process-environment))
          (test-review-workers (list (test-review-worker session "working" "t-review"
                                                         `((org.agent . ,agent) (org.task . ,id) (org.run . "review-run"))))))
      (setenv "HC_TERMINAL_ID" "t-review")
      (setenv "PI_SESSION_ID" session)
      (test-review-command "verdict" (list :commit test-review-commit :verdict verdict :note "Independent fixture findings and checks.") id))
    (test-review-at id (lambda () (org-todo "EVAL")))
    (org-dispatch--save-state (list :id id :file test-review-file :status "finished" :agent agent
                                   :session session :terminal "t-review" :run "review-run"
                                   :started (float-time) :nudges 0))))

(defun test-review-advance ()
  (test-review-command "advance" (list :revision (test-review-revision) :commit test-review-commit)))

(defun test-review-new-commit ()
  (with-temp-file (expand-file-name "code.txt" test-review-repo) (insert (org-id-new)))
  (org-review--git test-review-repo "add" ".")
  (org-review--git test-review-repo "commit" "-m" "fixture revision")
  (setq test-review-commit (org-review--git test-review-repo "rev-parse" "HEAD")))

(ert-deftest review-fixes-return-original-developer-and-new-exact-review ()
  (test-with-review
    (test-review-start)
    (let* ((first (test-review-loop)) (snapshot (plist-get first :snapshot)))
      (should (equal (test-review-state) "EVAL"))
      (should (equal (test-review-state (plist-get first :review)) "AUTO"))
      (should-not (equal snapshot test-review-repo))
      (should (string-empty-p (org-review--git snapshot "remote")))
      (test-review-report "fixes")
      (test-review-advance)
      (should (equal (test-review-state) "AUTO"))
      (test-review-at test-review-id (lambda ()
        (should (equal (plist-get (org-dispatch--task) :session) test-review-developer))
        (should (equal (org-entry-get nil "AGENT") "pi"))
        (should (equal (org-entry-get nil "DEPLOY") "no"))
        (should (string-search "Original scope stays." (org-dispatch--subtree-text)))
        (should (string-search "Independent fixture findings" (org-dispatch--subtree-text)))))
      (test-review-new-commit)
      (test-review-at test-review-id (lambda () (org-todo "EVAL")))
      (test-review-start)
      (let ((second (test-review-loop)))
        (should (= 2 (plist-get second :round)))
        (should-not (equal (plist-get first :review) (plist-get second :review)))
        (should-not (equal snapshot (plist-get second :snapshot)))
        (should (equal (plist-get second :permissions) (plist-get first :permissions)))
        (test-review-at (plist-get second :review) (lambda () (should-not (plist-get (org-dispatch--task) :session))))
        (test-review-report "pass")
        (test-review-advance)
        (should (equal (test-review-state) "DONE"))
        (should (equal (test-review-state (plist-get second :review)) "DONE"))))))

(ert-deftest review-mixed-human-acceptance-is-exact-partial-and-replay-safe ()
  (test-with-review
    (test-review-start '("Phone camera action" "Reboot and reconnect"))
    (test-review-report "pass")
    (test-review-advance)
    (should (equal (test-review-state) "EVAL"))
    (test-review-command "human" (list :revision (test-review-revision) :commit test-review-commit
      :checks '("Phone camera action") :note "Jon confirmed the camera action."))
    (should (equal (test-review-state) "EVAL"))
    (let ((before (test-review-revision)))
      (test-review-command "human" (list :revision "stale replay" :commit test-review-commit
        :checks '("Phone camera action") :note "Jon confirmed the camera action."))
      (should (equal before (test-review-revision))))
    (test-review-command "human" (list :revision (test-review-revision) :commit test-review-commit
      :checks '("Reboot and reconnect") :note "Jon confirmed reboot behavior."))
    (should (equal (test-review-state) "DONE"))))

(ert-deftest review-stale-source-and-branch-and-dirty-tree-refuse-approval ()
  (test-with-review
    (test-review-start)
    (test-review-report "pass")
    (let ((before (test-review-revision)) (original test-review-commit))
      (with-temp-file (expand-file-name "untracked" test-review-repo) (insert "dirty"))
      (should-error (test-review-advance))
      (delete-file (expand-file-name "untracked" test-review-repo))
      (org-review--git test-review-repo "checkout" "-b" "other")
      (should-error (test-review-advance))
      (org-review--git test-review-repo "checkout" "main")
      (test-review-new-commit)
      (let ((test-review-commit original)) (should-error (test-review-advance)))
      (should-error (test-review-advance))
      (should (equal before (test-review-revision)))
      (should (equal (test-review-state) "EVAL")))))

(ert-deftest review-human-approval-does-not-survive-a-new-revision ()
  (test-with-review
    (test-review-start '("Visual taste" "Phone"))
    (test-review-report "pass")
    (test-review-advance)
    (test-review-command "human" (list :revision (test-review-revision) :commit test-review-commit
      :checks '("Visual taste") :note "Jon accepted taste."))
    (let ((old test-review-commit))
      (test-review-new-commit)
      (should-error (test-review-command "human" (list :revision (test-review-revision) :commit old
        :checks '("Phone") :note "Jon checked old commit.")))
      (test-review-start)
      (should-not (plist-get (test-review-loop) :accepted))
      (test-review-report "pass")
      (test-review-advance)
      (should (equal (test-review-state) "EVAL")))))

(ert-deftest review-three-unsuccessful-rounds-escalate-without-new-work ()
  (test-with-review
    (dotimes (round 3)
      (when (> round 0)
        (test-review-new-commit)
        (test-review-at test-review-id (lambda () (org-todo "EVAL"))))
      (test-review-start)
      (test-review-report "fixes")
      (test-review-advance))
    (should (equal (test-review-state) "EVAL"))
    (should (test-review-at test-review-id (lambda () (org-entry-get nil "ASKED"))))
    (should (equal (plist-get (test-review-loop) :phase) "escalated"))
    (test-review-new-commit)
    (should-error (test-review-start))
    (test-review-at test-review-id (lambda () (org-todo "EVAL")))
    (should-error (test-review-start))
    (should (= 3 (plist-get (test-review-loop) :round)))))

(ert-deftest review-duplicate-events-and-restart-between-save-and-follow-do-not-requeue ()
  (test-with-review
    (test-review-start)
    (let ((before (test-review-revision)) (first (test-review-loop)))
      (test-review-start)
      (should (equal before (test-review-revision)))
      (should (equal first (test-review-loop)))
      (test-review-report "fixes")
      (test-review-advance)
      (setq before (test-review-revision))
      (test-review-start)
      (test-review-advance)
      (should (equal before (test-review-revision)))
      (test-review-at test-review-id (lambda () (org-todo "EVAL")))
      (setq before (test-review-revision))
      (test-review-advance)
      (should (equal before (test-review-revision)))
      (should (equal (test-review-state) "EVAL")))))

(ert-deftest review-crash-after-snapshot-before-org-save-recovers-without-reset ()
  (test-with-review
    (let ((snapshot-fn (symbol-function 'org-review--snapshot)) snapshot)
      (cl-letf (((symbol-function 'org-review--snapshot)
                 (lambda (&rest args) (setq snapshot (apply snapshot-fn args)) (error "fixture crash before save"))))
        (should-error (test-review-start)))
      (should-not (test-review-loop))
      (should (file-directory-p snapshot))
      (test-review-start)
      (should (equal snapshot (plist-get (test-review-loop) :snapshot))))))

(ert-deftest review-dirty-or-partial-snapshots-never-reset-or-touch-source ()
  (test-with-review
    (let ((snapshot-fn (symbol-function 'org-review--snapshot)) snapshot)
      (cl-letf (((symbol-function 'org-review--snapshot)
                 (lambda (&rest args) (setq snapshot (apply snapshot-fn args)) (error "fixture crash"))))
        (should-error (test-review-start)))
      (with-temp-file (expand-file-name "code.txt" snapshot) (insert "reviewer changed snapshot"))
      (should-error (test-review-start))
      (should (string-empty-p (org-review--git test-review-repo "status" "--porcelain")))
      (should (equal (with-temp-buffer (insert-file-contents (expand-file-name "code.txt" snapshot)) (buffer-string))
                     "reviewer changed snapshot")))))

(ert-deftest review-active-and-unknown-workers-block-handoffs-with-no-input ()
  (test-with-review
    (setq test-review-workers (list (test-review-worker test-review-developer "working")))
    (should-error (test-review-start))
    (should-not (test-review-loop))
    ;; A live terminal that reports no status is unknown, never settled.
    (setq test-review-workers (list (test-review-worker test-review-developer nil)))
    (should-error (test-review-start))
    (setq test-review-workers nil)
    (test-review-start)
    (test-review-report "pass")
    (setq test-review-workers (list (test-review-worker test-review-reviewer "blocked")))
    (should-error (test-review-advance))
    (should (equal (test-review-state) "EVAL"))))

(ert-deftest review-developer-cannot-self-review-and-verdict-needs-current-owner ()
  (test-with-review
    (test-review-start)
    (should-error (test-review-report "pass" test-review-developer))
    (let* ((id (plist-get (test-review-loop) :review))
           (spec (list :commit test-review-commit :verdict "pass" :note "fake verdict")))
      (should-error (test-review-command "verdict" spec id))
      (test-review-at id (lambda () (should-not (org-review--read "REVIEW_RESULT")))))))

(ert-deftest review-verdict-is-immutable-and-does-not-waive-human-or-scope ()
  (test-with-review
    (test-review-start '("Human check"))
    (test-review-report "blocked")
    (let ((id (plist-get (test-review-loop) :review)))
      (should-error (test-review-command "verdict" (list :commit test-review-commit :verdict "pass" :note "changed mind") id)))
    (test-review-advance)
    (should (equal (test-review-state) "EVAL"))
    (should (test-review-at test-review-id (lambda () (org-entry-get nil "ASKED"))))
    (should-error (test-review-command "human" (list :revision (test-review-revision) :commit test-review-commit
      :checks '("Human check") :note "Jon checked it.")))
    (dolist (state '("AUTO" "DONE"))
      (let ((command-line-args-left (list test-review-file (concat "id:" test-review-id) state)))
        (should-error (org-edit-todo))))))

(ert-deftest review-dispatch-keeps-snapshots-separate-and-serializes-source-aliases ()
  (test-with-review
    (test-review-start)
    (let* ((snapshot (plist-get (test-review-loop) :snapshot))
           (alias (expand-file-name "source-alias" default-directory))
           (source-task (list :id "source" :host "kit" :agent "pi" :june t :dir test-review-repo :hash "a"))
           (review-task (list :id "review" :host "kit" :agent "pi" :june t :dir snapshot :hash "b"))
           (org-dispatch-max-agents 10))
      (make-symbolic-link test-review-repo alias)
      (should (= 2 (length (org-dispatch--eligible (list source-task review-task) nil t))))
      (should (= 1 (length (org-dispatch--eligible (list source-task (plist-put (copy-sequence source-task) :dir alias)) nil t))))
      (should-not (org-dispatch--eligible (list source-task) (list (list :id "other" :status "running" :dir alias)) t)))))

(ert-deftest review-generic-complete-and-resume-cannot-strand-or-reassign-a-linked-review ()
  (test-with-review
    (test-review-start)
    (test-review-report "pass")
    (let ((id (plist-get (test-review-loop) :review)))
      (let ((command-line-args-left (list test-review-file (concat "id:" id) "DONE" "--expect" "EVAL")))
        (should-error (org-edit-todo)))
      (let ((command-line-args-left (list test-review-file (concat "id:" id) "AUTO" "--expect" "EVAL"
                                        "--request" "bypass" "--host" "kit" "--agent" "claude" "--note" "Bypass attempt.")))
        (should-error (org-edit-todo)))
      (should (equal (test-review-state id) "EVAL"))
      (test-review-at id (lambda () (should (equal (org-entry-get nil "AGENT") "pi")))))
    (test-review-advance)
    (should (equal (test-review-state) "DONE"))))

(ert-deftest review-dispatch-serializes-subdirectories-of-one-git-worktree ()
  (test-with-review
    (let* ((subdir (expand-file-name "src" test-review-repo))
           (org-dispatch-max-agents 10)
           (one (list :id "one" :host "kit" :agent "pi" :june t :dir test-review-repo :hash "a"))
           (two (list :id "two" :host "kit" :agent "pi" :june t :dir subdir :hash "b")))
      (make-directory subdir)
      (should (= 1 (length (org-dispatch--eligible (list one two) nil t))))
      (should-not (org-dispatch--eligible (list two) (list (list :id "one" :status "running" :dir test-review-repo)) t)))))

(ert-deftest review-next-round-refuses-changed-repository-before-consuming-round ()
  (test-with-review
    (test-review-start)
    (test-review-report "fixes")
    (test-review-advance)
    (test-review-new-commit)
    (let ((other (expand-file-name "other-source" default-directory)))
      (org-review--git test-review-repo "clone" "--no-local" test-review-repo other)
      (test-review-at test-review-id (lambda () (org-entry-put nil "DIR" other) (org-todo "EVAL")))
      (let ((before (test-review-revision)))
        (should-error (test-review-start))
        (should (equal before (test-review-revision)))
        (should (= 1 (plist-get (test-review-loop) :round)))))))

(ert-deftest review-partial-startup-parks-and-reserves-without-another-launch ()
  (test-with-review
    (test-review-start)
    (let* ((loop (test-review-loop)) (id (plist-get loop :review))
           (org-dispatch-max-agents 10) launches
           (state (list :id id :file test-review-file :heading "Review" :dir (plist-get loop :snapshot)
                        :agent "pi" :status "starting" :started (- (float-time) 601) :nudges 0)))
      (org-dispatch--save-state state)
      (cl-letf (((symbol-function 'org-dispatch--launch) (lambda (task) (push task launches)))
                ((symbol-function 'org-dispatch--notify) #'ignore))
        (org-dispatch-run)
        (org-dispatch-run))
      (should-not launches)
      (should (equal (test-review-state id) "HOLD"))
      (should (equal (plist-get (car (org-dispatch--states)) :status) "launch-uncertain"))
      (let ((command-line-args-left (list test-review-file (concat "id:" id) "AUTO")))
        (should-error (org-edit-todo)))
      (let ((alias (list :id "other" :host "kit" :agent "pi" :june t :dir (plist-get loop :snapshot) :hash "x")))
        (should-not (org-dispatch--eligible (list alias) (org-dispatch--states) t))))))

(ert-deftest review-launch-error-keeps-its-receipt-and-never-retries ()
  (test-with-review
    (test-review-start)
    (let* ((id (plist-get (test-review-loop) :review))
           (task (test-review-at id #'org-dispatch--task)) starts)
      (cl-letf (((symbol-function 'org-dispatch--command) (lambda (_) nil))
                ((symbol-function 'org-dispatch--hc)
                 (lambda (&rest args)
                   (pcase (car args)
                     ("ls" '((terminals . [])))
                     ("run" (push args starts)
                      (signal 'org-dispatch-hc (list "connection" "fixture transport lost after startup")))
                     (_ (error "unexpected hc input %S" args)))))
                ((symbol-function 'org-dispatch--notify) #'ignore))
        (should-not (org-dispatch--launch task))
        (let ((state (car (org-dispatch--states))))
          (should (equal (plist-get state :status) "launch-uncertain"))
          ;; The run and session chosen before launch stay on record for inspection.
          (should (plist-get state :run))
          (should (plist-get state :session)))
        (should (equal (test-review-state id) "HOLD"))
        (org-dispatch-run)
        (should (= 1 (length starts)))))))

(ert-deftest review-uncertain-startup-recovers-crash-before-org-hold-save ()
  (test-with-review
    (test-review-start)
    (let* ((loop (test-review-loop)) (id (plist-get loop :review))
           (state (list :id id :file test-review-file :heading "Review" :dir (plist-get loop :snapshot)
                        :agent "pi" :status "starting" :review-loop 1 :started (- (float-time) 601) :nudges 0)))
      (cl-letf (((symbol-function 'org-dispatch--edit) (lambda (&rest _) (error "fixture crash before HOLD save"))))
        (should-error (org-dispatch--uncertain-launch state "Fixture uncertain startup.")))
      (should (equal (test-review-state id) "AUTO"))
      (cl-letf (((symbol-function 'org-dispatch--notify) #'ignore))
        (org-dispatch--watch (car (org-dispatch--states))))
      (should (equal (test-review-state id) "HOLD"))
      ;; HOLD for its recovery checks, but marked as Jon's to inspect.
      (should (test-review-at id (lambda () (org-entry-get nil "ASKED"))))
      (should (equal (plist-get (car (org-dispatch--states)) :status) "launch-uncertain")))))

(ert-deftest review-contract-needs-explicit-human-list-and-fresh-read-and-no-worker-coordinator ()
  (test-with-review
    (let ((spec (list :revision (test-review-revision) :commit test-review-commit
                      :authorization "Jon delegated fixes." :permissions "Local checks only." :checks "Test." :agent "pi")))
      (should-error (test-review-command "start" spec))
      (setq spec (plist-put spec :human nil))
      (setq spec (plist-put spec :revision "stale"))
      (should-error (test-review-command "start" spec)))
    (let ((process-environment (copy-sequence process-environment)))
      (setenv "HC_TERMINAL_ID" "t-developer")
      (setenv "PI_SESSION_ID" test-review-developer)
      (should-error (test-review-start)))
    (should-not (test-review-loop))))

(ert-deftest review-generic-worker-finish-cannot-waive-contract ()
  (test-with-review
    (test-review-start '("Human required"))
    (test-review-at test-review-id (lambda () (org-entry-put nil "REVIEW" "no") (org-todo "PROG")))
    (let ((command-line-args-left (list test-review-id "DONE" "generic worker finish")))
      (org-dispatch-finish))
    (should (equal (test-review-state) "EVAL"))))

;;; Standing agent review: the dispatcher runs the loop when REVIEW is agent.

(defun test-review-standing (&optional extra)
  "Make the development task's REVIEW agent, with EXTRA drawer lines."
  (test-review-at test-review-id
    (lambda ()
      (org-entry-put nil "REVIEW" "agent")
      (dolist (pair extra) (org-entry-put nil (car pair) (cdr pair))))))

(defun test-review-settle (id)
  "The watch drops a run's receipt once its worker settles."
  (org-dispatch--drop-state id))

(defun test-review-asked ()
  (test-review-at test-review-id (lambda () (org-entry-get nil "ASKED"))))

(defun test-review-text ()
  (with-temp-buffer (insert-file-contents test-review-file) (buffer-string)))

(ert-deftest standing-review-starts-once-returns-fixes-and-asks-without-a-new-commit ()
  (test-with-review
    (test-review-standing)
    (org-dispatch--agent-reviews (list test-review-file))
    (let* ((loop (test-review-loop)) (review (plist-get loop :review)))
      (should (equal (plist-get loop :phase) "review"))
      ;; pi reviews by default, since Claude stops at its trust prompt in a new snapshot.
      (should (equal (plist-get loop :agent) "pi"))
      (should (string-match-p "Standing agent review" (plist-get loop :authorization)))
      (should (equal (test-review-state review) "AUTO"))
      (should (string-search "Queued by Dispatcher" (test-review-text)))
      ;; A second run finds the review under way and adds nothing.
      (org-dispatch--agent-reviews (list test-review-file))
      (should (equal (test-review-loop) loop))
      (test-review-report "fixes")
      ;; A run still holding its slot is not settled.
      (org-dispatch--agent-reviews (list test-review-file))
      (should (equal (test-review-state review) "EVAL"))
      (test-review-settle review)
      (org-dispatch--agent-reviews (list test-review-file))
      (should (equal (test-review-state review) "DONE"))
      (should (equal (test-review-state) "AUTO"))
      (should (equal (plist-get (test-review-loop) :phase) "fixes"))
      (should (string-match-p "^- Dispatcher .*Review \\[\\[id:" (test-review-text)))
      ;; The developer finishes again without committing anything new: Jon is asked, once.
      (test-review-at test-review-id (lambda () (org-todo "EVAL")))
      (org-dispatch--agent-reviews (list test-review-file))
      (should (equal (test-review-state) "EVAL"))
      (should (test-review-asked))
      (should (string-search "Agent review stopped: the fixes for round 1 finished without a new commit" (test-review-text)))
      (let ((text (test-review-text)))
        (org-dispatch--agent-reviews (list test-review-file))
        (should (equal (test-review-text) text)))
      ;; Jon resumes it; leaving EVAL clears the question, and a new commit starts round 2.
      (test-review-at test-review-id (lambda () (org-todo "AUTO")))
      (should-not (test-review-asked))
      (test-review-new-commit)
      (test-review-at test-review-id (lambda () (org-todo "EVAL")))
      (org-dispatch--agent-reviews (list test-review-file))
      (should (= 2 (plist-get (test-review-loop) :round)))
      (should (equal (plist-get (test-review-loop) :commit) test-review-commit)))))

(ert-deftest standing-review-pass-closes-or-leaves-the-named-human-checks ()
  (test-with-review
    (test-review-standing '(("REVIEWER" . "pi") ("REVIEW_HUMAN" . "Phone check; Look at the colours")))
    (org-dispatch--agent-reviews (list test-review-file))
    (should (equal (plist-get (test-review-loop) :agent) "pi"))
    (should (equal (plist-get (test-review-loop) :human) '("Phone check" "Look at the colours")))
    (test-review-report "pass")
    (test-review-settle (plist-get (test-review-loop) :review))
    (org-dispatch--agent-reviews (list test-review-file))
    (should (equal (test-review-state) "EVAL"))
    (should (equal (plist-get (test-review-loop) :phase) "human"))
    ;; Ready for Jon's checks, not a question.
    (should-not (test-review-asked)))
  (test-with-review
    (test-review-standing)
    (org-dispatch--agent-reviews (list test-review-file))
    (test-review-report "pass")
    (test-review-settle (plist-get (test-review-loop) :review))
    (org-dispatch--agent-reviews (list test-review-file))
    (should (equal (test-review-state) "DONE"))))

(ert-deftest standing-review-follows-the-project-default-and-leaves-other-tasks-alone ()
  (test-with-review
    ;; REVIEW yes is Jon's to review.
    (org-dispatch--agent-reviews (list test-review-file))
    (should-not (test-review-loop))
    (test-review-at test-review-id (lambda () (org-entry-delete nil "REVIEW") (org-entry-put nil "HOST" "cog")))
    (with-temp-file test-review-file
      (insert "#+PROPERTY: REVIEW agent\n")
      (insert (with-temp-buffer (insert-file-contents test-review-file) (buffer-string))))
    ;; Another host's task waits for its own dispatcher.
    (org-dispatch--agent-reviews (list test-review-file))
    (should-not (test-review-loop))
    (test-review-at test-review-id (lambda () (org-entry-put nil "HOST" "kit")))
    ;; A run still holding its slot is not settled.
    (org-dispatch--save-state (list :id test-review-id :status "finished"))
    (org-dispatch--agent-reviews (list test-review-file))
    (should-not (test-review-loop))
    (test-review-settle test-review-id)
    ;; A question for Jon is his.
    (test-review-at test-review-id (lambda () (org-entry-put nil "ASKED" "[2026-11-20 Fri 12:00]")))
    (org-dispatch--agent-reviews (list test-review-file))
    (should-not (test-review-loop))
    (test-review-at test-review-id (lambda () (org-entry-delete nil "ASKED")))
    ;; The file's #+PROPERTY makes it standing.
    (org-dispatch--agent-reviews (list test-review-file))
    (should (equal (plist-get (test-review-loop) :phase) "review"))))

(ert-deftest standing-review-refuses-a-reviewer-that-cannot-run-unattended ()
  (test-with-review
    (test-review-standing '(("REVIEWER" . "claude")))
    (org-dispatch--agent-reviews (list test-review-file))
    (should-not (test-review-loop))
    (should-not (string-match-p "^\\* AUTO Review" (test-review-text)))
    (should (test-review-asked))
    (should (string-search "claude cannot review unattended" (test-review-text))))
  (test-with-review
    ;; June's own loop refuses it too, before writing anything.
    (should-error (test-review-command "start" (list :revision (test-review-revision) :commit test-review-commit
      :authorization "Jon delegated." :permissions "Local only." :checks "Agent checks." :human nil :agent "claude")))
    (should-not (test-review-loop))))

(ert-deftest standing-review-refusals-ask-jon-and-write-nothing-else ()
  (test-with-review
    (test-review-standing)
    (with-temp-file (expand-file-name "code.txt" test-review-repo) (insert "uncommitted\n"))
    (let ((before (test-review-text)))
      (org-dispatch--agent-reviews (list test-review-file))
      (should-not (test-review-loop))
      (should (equal (test-review-state) "EVAL"))
      (should (test-review-asked))
      (should (string-search "Agent review stopped: revision changed or worktree dirty" (test-review-text)))
      (should-not (string-match-p "^\\* AUTO Review" (test-review-text)))
      (should (equal (replace-regexp-in-string "^:ASKED:.*\n\\|^- Dispatcher .*\n" "" (test-review-text)) before)))))

(ert-run-tests-batch-and-exit)
