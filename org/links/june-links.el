;;; june-links.el --- Open June's file links in Emacs -*- lexical-binding: t; -*-

;; Author: Jon Suderman
;; Version: 0.1.0
;; Package-Requires: ((emacs "30.1"))
;; Keywords: files, hypermedia
;; URL: https://github.com/suderman/june

;;; Commentary:
;; Load in interactive Emacs on the desktop and Android.  June's desktop
;; client calls `june-open'; her Android app sends org-protocol://june-open.

;;; Code:

(require 'org)
(require 'subr-x)

(defvar org-protocol-protocol-alist)

(defgroup june-links nil "Open file links from June." :group 'org-link)

(defcustom june-host (system-name)
  "Host where June runs, whose files her links name outside ~/org."
  :type 'string
  :group 'june-links)

(defun june-open (path &optional search)
  "Open PATH from a link June wrote, then find SEARCH as an Org file link does.
~/org is the same tree on every device, so its files open here.  Any other
path is a file on `june-host', opened over TRAMP from other devices,
including Android.  SEARCH is a heading (*Heading), custom ID (#id),
line number, or text; nothing in it is evaluated."
  (let* ((org (file-name-as-directory (expand-file-name "~/org")))
         (local (expand-file-name path))
         (file (cond ((file-in-directory-p local org) local)
                     ((string= (system-name) june-host) local)
                     (t (concat "/ssh:" june-host ":" path)))))
    (find-file file)
    (when (and search (not (string-empty-p search)))
      (if (string-match-p "\\`[0-9]+\\'" search)
          (progn (goto-char (point-min))
                 (forward-line (1- (string-to-number search))))
        (org-link-search search)))
    (select-frame-set-input-focus (selected-frame))
    nil))

(defun june-org-protocol (info)
  "Open the file in org-protocol INFO, from June's Android app.
INFO has :path and an optional :search, as `june-open' takes them."
  (june-open (plist-get info :path) (plist-get info :search))
  nil)

(with-eval-after-load 'org-protocol
  (add-to-list 'org-protocol-protocol-alist
               '("june-open" :protocol "june-open"
                 :function june-org-protocol)))

;; Android passes protocol links to the server before visiting any file.
(when (featurep 'android)
  (require 'org-protocol))

(provide 'june-links)
;;; june-links.el ends here
