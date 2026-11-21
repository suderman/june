;;; june-agenda.el --- Export Jon's agenda and open tasks as JSON for June  -*- lexical-binding: t; -*-

;; Batch entry point, loaded after org-dispatch.el for its keywords, Calgary
;; time and task helpers:
;;
;;   emacs -Q --batch -l org-dispatch.el -l june-agenda.el -f june-agenda-export LIST [DAYS]
;;
;; LIST is a file naming one agenda file per line (the dispatcher's cache of
;; `org-agenda-files').  The last line printed is one JSON object:
;;
;;   today  "YYYY-MM-DD"
;;   days   [{date, entries: [{task, type, time, extra, date}]}], from today
;;          for DAYS days (7), collected by `org-agenda-get-day-entries', so
;;          overdue items, warning periods and repeaters follow Org's agenda.
;;   tasks  {KEY: task}: every open heading (TODO AUTO PROG EVAL HOLD), every
;;          DONE heading closed in the last 7 days, and any heading an agenda
;;          entry names.  KEY is id:UUID, else FILE::LINE.
;;
;; Read-only: it never saves, creates IDs or touches the dispatcher's state.

;;; Code:

(require 'org)
(require 'org-agenda)
(require 'json)
(require 'seq)
(require 'subr-x)

(defconst june-agenda-open '("TODO" "AUTO" "PROG" "EVAL" "HOLD"))
(defconst june-agenda-closed-days 7
  "DONE headings closed within this many days are exported.")
(defconst june-agenda-dialog-max 20000
  "Characters of a Dialog section exported; longer ones keep their end.")
(defconst june-agenda-herdr
  "herdr:[a-z0-9-]+/[a-z]+:[0-9a-f-]\\{36\\}\\(?:@[A-Za-z0-9:]+\\)?")

(defun june-agenda--files (list)
  "Agenda files named in LIST that exist, without sync conflicts or archives."
  (with-temp-buffer
    (insert-file-contents list)
    (seq-filter (lambda (file)
                  (and (file-regular-p file)
                       (not (string-search ".sync-conflict-" file))
                       (not (equal (file-name-nondirectory file) "archive.org"))))
                (split-string (buffer-string) "\n" t "[ \t]+"))))

(defun june-agenda--key ()
  (let ((id (org-entry-get nil "ID")))
    (if id (concat "id:" id) (format "%s::%d" buffer-file-name (line-number-at-pos)))))

(defun june-agenda--section (title)
  "Text of this entry's child section TITLE, without its heading line."
  (when-let* ((bounds (org-dispatch--section-bounds title)))
    (string-trim
     (buffer-substring-no-properties
      (save-excursion (goto-char (car bounds)) (forward-line 1) (point))
      (cdr bounds)))))

(defun june-agenda--sessions ()
  "herdr: links in this entry's subtree, in order, without repeats."
  (let ((end (save-excursion (org-end-of-subtree t t) (point)))
        links)
    (save-excursion
      (while (re-search-forward june-agenda-herdr end t)
        (cl-pushnew (match-string-no-properties 0) links :test #'equal)))
    (vconcat (nreverse links))))

(defvar-local june-agenda--title 'unset)

(defun june-agenda--file-title ()
  "This file's #+TITLE, read once per buffer."
  (when (eq june-agenda--title 'unset)
    (setq june-agenda--title
          (when-let* ((title (cadr (assoc "TITLE" (org-collect-keywords '("TITLE"))))))
            (substring-no-properties title))))
  june-agenda--title)

(defun june-agenda--closed-recently-p ()
  (when-let* ((closed (org-entry-get nil "CLOSED")))
    (< (- (float-time) (float-time (org-time-string-to-time closed)))
       (* june-agenda-closed-days 86400))))

(defun june-agenda--dependency (index)
  "The dispatcher's verdict on this entry's DEPENDS, as an alist, or nil."
  (let ((depends (split-string (or (org-entry-get nil "DEPENDS") ""))))
    (when (and depends index)
      (let ((result (org-dispatch--dependencies
                     (list :id (org-entry-get nil "ID") :depends depends) index)))
        `((kind . ,(symbol-name (plist-get result :kind)))
          (reason . ,(plist-get result :reason)))))))

(defun june-agenda--task (&optional index)
  "The entry at point, as an alist for JSON."
  (let* ((state (org-get-todo-state))
         (dialog (june-agenda--section "Dialog"))
         (auto (equal state "AUTO"))
         (host (and auto (org-dispatch--resolve
                          "HOST" org-dispatch-hosts
                          (org-dispatch--default "host" (car org-dispatch-hosts)))))
         (agent (and auto (org-dispatch--resolve
                           "AGENT" org-dispatch-agents
                           (org-dispatch--default "agent" "pi")))))
    (when (and dialog (> (length dialog) june-agenda-dialog-max))
      (setq dialog (substring dialog (- (length dialog) june-agenda-dialog-max))))
    `((key . ,(june-agenda--key))
      (id . ,(org-entry-get nil "ID"))
      (file . ,buffer-file-name)
      (line . ,(line-number-at-pos))
      (level . ,(org-current-level))
      (title . ,(substring-no-properties (org-get-heading t t t t)))
      (state . ,state)
      (priority . ,(save-excursion
                     (org-back-to-heading t)
                     (when (and (looking-at org-complex-heading-regexp) (match-string 3))
                       (substring-no-properties (match-string 3) 2 3))))
      (tags . ,(vconcat (mapcar #'substring-no-properties (org-get-tags))))
      (path . ,(vconcat (mapcar #'substring-no-properties (org-get-outline-path))))
      (fileTitle . ,(june-agenda--file-title))
      (category . ,(org-get-category))
      (scheduled . ,(org-entry-get nil "SCHEDULED"))
      (deadline . ,(org-entry-get nil "DEADLINE"))
      (closed . ,(org-entry-get nil "CLOSED"))
      (created . ,(org-entry-get nil "CREATED"))
      (host . ,(if auto (plist-get host :value) (org-entry-get nil "HOST")))
      (agent . ,(if auto (plist-get agent :value) (org-entry-get nil "AGENT")))
      (problem . ,(and auto (or (plist-get host :problem) (plist-get agent :problem))))
      (depends . ,(org-entry-get nil "DEPENDS"))
      (dependency . ,(and auto (june-agenda--dependency index)))
      (review . ,(symbol-name (org-dispatch--review-mode)))
      (reviewParent . ,(org-entry-get nil "REVIEW_PARENT"))
      (devReview . ,(and (org-dispatch--loop) t))
      (reviewPhase . ,(plist-get (org-dispatch--loop) :phase))
      (asked . ,(org-entry-get nil "ASKED"))
      ;; The read revision org-edit's update-task checks, as June's org_read_task gives it.
      (revision . ,(org-dispatch--revision))
      (headline . ,(org-entry-get nil "HEADLINE"))
      (headlineState . ,(org-entry-get nil "HEADLINE_STATE"))
      (headlineAt . ,(org-entry-get nil "HEADLINE_AT"))
      (sessions . ,(june-agenda--sessions))
      (dialog . ,dialog))))

(defun june-agenda--date (absolute)
  (pcase-let ((`(,month ,day ,year) (calendar-gregorian-from-absolute absolute)))
    (format "%04d-%02d-%02d" year month day)))

(defun june-agenda--entry (item tasks)
  "Agenda ITEM, a string with Org's text properties, recorded in TASKS."
  (let ((marker (or (get-text-property 0 'org-hd-marker item) (get-text-property 0 'org-marker item)))
        (time (get-text-property 0 'time-of-day item))
        (extra (get-text-property 0 'extra item))
        (ts (get-text-property 0 'ts-date item))
        key)
    (when (and marker (marker-buffer marker))
      (with-current-buffer (marker-buffer marker)
        (save-excursion
          (goto-char marker)
          (org-back-to-heading t)
          (setq key (june-agenda--key))
          (unless (gethash key tasks) (puthash key (june-agenda--task) tasks))))
      `((task . ,key)
        (type . ,(get-text-property 0 'type item))
        (time . ,(and time (format "%02d:%02d" (/ time 100) (% time 100))))
        (extra . ,(and extra (let ((text (string-trim (substring-no-properties extra))))
                               (unless (string-empty-p text) text))))
        (date . ,(and ts (june-agenda--date ts)))))))

(defun june-agenda--index (files)
  "Dependency index over FILES and their archives, when an AUTO task needs it."
  (when (seq-some (lambda (file)
                    (with-temp-buffer
                      (insert-file-contents file)
                      (and (re-search-forward "^\\*+ AUTO " nil t)
                           (re-search-forward "^[ \t]*:DEPENDS:" nil t))))
                  files)
    (org-dispatch--dependency-index (org-dispatch--lookup-files files))))

(defvar june-agenda--days-cache (make-hash-table :test 'equal)
  "FILE to (STAMP ENTRIES TASKS): its agenda entries for each day of a read, and the task records they name.
They stay good while the file, today and the span stay the same, which STAMP records. One read uses them once;
June's long-running Emacs (org/server/june-org-server.el) reuses them, so a read after an edit recomputes only the
file that changed. Org's day entries are most of a read's time.")

(defun june-agenda--day-entries (file today span tasks)
  "FILE's entries for SPAN days from TODAY, as a vector of lists, from the cache when FILE is unchanged.
Records the tasks they name in TASKS."
  (let* ((attributes (file-attributes file))
         (stamp (list (file-attribute-modification-time attributes) (file-attribute-size attributes) today span))
         (cached (gethash file june-agenda--days-cache)))
    (if (equal (car cached) stamp)
        (progn
          (dolist (task (nth 2 cached))
            (unless (gethash (car task) tasks) (puthash (car task) (cdr task) tasks)))
          (nth 1 cached))
      (let ((days (make-vector span nil)) named)
        (dotimes (n span)
          (let (entries)
            (dolist (item (org-agenda-get-day-entries file (calendar-gregorian-from-absolute (+ today n))
                                                      :deadline :scheduled :timestamp :sexp))
              (when-let* ((entry (june-agenda--entry item tasks)))
                (push entry entries)
                (let ((key (alist-get 'task entry)))
                  (unless (assoc key named) (push (cons key (gethash key tasks)) named)))))
            (aset days n (nreverse entries))))
        (puthash file (list stamp days named) june-agenda--days-cache)
        days))))

(defun june-agenda-export ()
  "Print the agenda for the files listed in the first argument, as JSON."
  (let* ((list (or (pop command-line-args-left) (error "usage: june-agenda-export LIST [DAYS]")))
         (span (string-to-number (or (pop command-line-args-left) "7")))
         (files (june-agenda--files list))
         (tasks (make-hash-table :test 'equal))
         (index (june-agenda--index files))
         (today (calendar-absolute-from-gregorian (calendar-current-date)))
         (org-agenda-files files)
         (org-agenda-skip-scheduled-if-done t)
         (org-agenda-skip-deadline-if-done t)
         (inhibit-message t)
         days)
    (setq command-line-args-left nil)
    (org-agenda-prepare-buffers files)
    (dolist (file files)
      (with-current-buffer (org-get-agenda-file-buffer file)
        (org-with-wide-buffer
         (org-map-entries
          (lambda ()
            (let ((state (org-get-todo-state)))
              (when (or (member state june-agenda-open)
                        (and (equal state "DONE") (june-agenda--closed-recently-p)))
                (let ((task (june-agenda--task index)))
                  (puthash (alist-get 'key task) task tasks)))))))))
    (let ((per-file (mapcar (lambda (file) (june-agenda--day-entries file today span tasks)) files)))
      (dotimes (n span)
        (push `((date . ,(june-agenda--date (+ today n)))
                (entries . ,(vconcat (apply #'append (mapcar (lambda (v) (aref v n)) per-file)))))
              days)))
    (let ((json-encoding-pretty-print nil))
      (princ (json-encode `((today . ,(june-agenda--date today))
                            (days . ,(vconcat (nreverse days)))
                            (tasks . ,tasks))))
      (terpri))))

(provide 'june-agenda)
;;; june-agenda.el ends here
