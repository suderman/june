;;; june-org-server.el --- One long-running Emacs for June's Org edits and agenda  -*- lexical-binding: t; -*-

;; June's daemon starts this once (src/org-worker.ts) instead of a batch Emacs per edit and per agenda read, which
;; spends most of its time starting Emacs, loading Org and reading every agenda file again. It reads one request a line
;; on stdin and answers one line on stdout, both base64 of UTF-8 JSON so no locale or newline can break the framing:
;;
;;   {"id": 1, "op": "edit", "args": ["todo", FILE, HEADING, "PROG", "--expect", "TODO"]}
;;   {"id": 2, "op": "agenda", "args": [LIST-FILE]}
;;   {"id": 3, "op": "ping"}
;;
;; and answers {"id": 1, "ok": true, "out": TEXT} or {"id": 1, "ok": false, "error": MESSAGE}.
;;
;; An edit is org-edit's own command, as the org-edit wrapper runs it; the daemon holds the dispatcher's lock around
;; it, as the wrapper does. Agenda buffers stay open between reads, which is what makes a read fast; before each request
;; any buffer whose file changed on disk, was deleted, or holds unsaved changes is closed, so nothing stale is read or
;; written and Emacs never stops to ask whether to reread a file.

;;; Code:

(require 'org-edit)
(require 'june-agenda)

(defun june-org-server--fresh ()
  "Close every file buffer that no longer matches its file, and forget cached settings."
  (dolist (buffer (buffer-list))
    (let ((file (buffer-file-name buffer)))
      (when (and file
                 (or (not (file-exists-p file))
                     (buffer-modified-p buffer)
                     (not (verify-visited-file-modtime buffer))))
        (with-current-buffer buffer (set-buffer-modified-p nil))
        (kill-buffer buffer))))
  ;; June's config may change while this runs; org-dispatch reads it again when asked.
  (setq org-dispatch--defaults nil))

(defun june-org-server--run (op args)
  "Run OP with ARGS, as the org-edit wrapper or the agenda export would, and return what it printed."
  (with-output-to-string
    (let ((command-line-args-left args))
      (pcase op
        ("ping" (princ "pong"))
        ("edit"
         (let ((command (pop command-line-args-left)))
           (unless (member command '("todo" "schedule" "deadline" "date" "update-task" "reschedule-task" "reply"))
             (error "not a board edit: %s" command))
           (funcall (intern (concat "org-edit-" command)))))
        ("agenda"
         (june-agenda-export)
         ;; Agenda items hold markers into the buffers, which slow every later change to them.
         (org-agenda-reset-markers))
        (_ (error "unknown op %s" op))))))

(defun june-org-server--answer (answer)
  "Write ANSWER, an alist, as one line of base64 JSON."
  (princ (base64-encode-string (encode-coding-string (json-serialize answer) 'utf-8) t))
  (terpri))

(defun june-org-serve ()
  "Answer requests on stdin until it closes."
  (let ((line nil))
    (while (setq line (condition-case nil (read-from-minibuffer "") (end-of-file nil)))
      (let* ((request (ignore-errors
                        (json-parse-string (decode-coding-string (base64-decode-string line) 'utf-8)
                                           :object-type 'alist :array-type 'list)))
             (id (alist-get 'id request)))
        (if (null request)
            (june-org-server--answer '((id . :null) (ok . :false) (error . "unreadable request")))
          (condition-case err
              (progn
                (june-org-server--fresh)
                (june-org-server--answer
                 `((id . ,id) (ok . t)
                   (out . ,(june-org-server--run (alist-get 'op request) (alist-get 'args request))))))
            (error
             (june-org-server--answer `((id . ,id) (ok . :false) (error . ,(error-message-string err))))))))))
  (kill-emacs 0))

(provide 'june-org-server)
;;; june-org-server.el ends here
