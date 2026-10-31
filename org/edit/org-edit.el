;;; org-edit.el --- Let Org make agents' state and date changes  -*- lexical-binding: t; -*-

;; Batch entry points, run through the org-edit wrapper:
;;   org-edit-todo      FILE HEADING STATE [--expect STATE] [--request KEY --host HOST [--agent AGENT] --note TEXT]
;;   org-edit-schedule  FILE HEADING WHEN
;;   org-edit-deadline  FILE HEADING WHEN
;;   org-edit-date      WHEN
;;
;; Agents write content as text. States and dates go through Org, so CLOSED,
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

(defun org-edit-todo ()
  "Set FILE HEADING to STATE, optionally checking --expect STATE.
June uses --request KEY --host HOST --note TEXT to resume a task once, and --agent
AGENT to change who runs it.
Coding workers must not set AUTO; that permission lives in instructions."
  (let* ((args command-line-args-left)
         (file (pop args)) (heading (pop args)) (state (upcase (or (pop args) "")))
         expected request host agent note result)
    (setq command-line-args-left nil)
    (unless (and file heading (not (string-empty-p state)))
      (error "usage: org-edit todo FILE HEADING STATE [--expect STATE] [--request KEY --host HOST [--agent AGENT] --note TEXT]"))
    (while args
      (let ((flag (pop args)) (value (pop args)))
        (unless (and value (not (string-empty-p value))) (error "missing value for %s" flag))
        (pcase flag
          ("--expect" (setq expected (upcase value)))
          ("--request" (setq request value))
          ("--host" (setq host value))
          ("--agent" (setq agent value))
          ("--note" (setq note value))
          (_ (error "unknown option %s" flag)))))
    (when (or request host agent note)
      (unless (and (equal state "AUTO") request host note (member expected '("TODO" "EVAL" "HOLD")))
        (error "resuming needs AUTO, --expect TODO|EVAL|HOLD, --request, --host, and --note"))
      (unless (member host org-dispatch-hosts) (error "unknown dispatcher host %s" host))
      (when (and agent (not (member agent org-dispatch-launchable))) (error "unknown agent %s" agent))
      (when (or (string-match-p "[\n\r]" request) (string-match-p "[\n\r]" note))
        (error "request and note must each be one line")))
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
             (org-dispatch--append "Dialog" (org-dispatch--entry "June" note)))
           (org-todo state))
         (when request
           (setq result `((id . ,(org-entry-get nil "ID"))
                          (title . ,(org-get-heading t t t t))
                          (host . ,host)
                          (written . ,(if replay :false t)))))))
     request)
    (when request (princ (concat (json-serialize result) "\n")))))

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
