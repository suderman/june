;;; links.el --- June's interactive Emacs link integration -*- lexical-binding: t; -*-

(require 'ert)
(require 'cl-lib)
(require 'june-links)
(require 'org-protocol)

(defmacro test-with-june-org (&rest body)
  (declare (indent 0))
  `(let ((home (make-temp-file "june-links-" t))
         (process-environment (copy-sequence process-environment)))
     (unwind-protect
         (progn
           (setenv "HOME" home)
           (make-directory (expand-file-name "org" home))
           ,@body)
       (delete-directory home t))))

(ert-deftest june-links-route-files ()
  (test-with-june-org
    (let ((june-host "june-test-host") opened focused)
      (cl-letf (((symbol-function 'system-name) (lambda () june-host))
                ((symbol-function 'find-file) (lambda (file) (setq opened file)))
                ((symbol-function 'select-frame-set-input-focus)
		 (lambda (frame) (setq focused frame))))
        (should-not (june-open "~/org/june-link-test.org"))
        (should (equal opened (expand-file-name "~/org/june-link-test.org")))
        (should (eq focused (selected-frame)))
        (june-open "/tmp/june-link-test.org" "")
        (should (equal opened "/tmp/june-link-test.org"))
        (cl-letf (((symbol-function 'system-name) (lambda () "another-host")))
          (june-open "~/org/june-link-test.org")
          (should (equal opened (expand-file-name "~/org/june-link-test.org")))
          (june-open "~/outside-org.org")
          (should (equal opened "/ssh:june-test-host:~/outside-org.org")))))))

(ert-deftest june-links-android-keeps-org-local ()
  (test-with-june-org
    (let ((featurep (symbol-function 'featurep)) opened)
      (cl-letf (((symbol-function 'featurep)
		 (lambda (feature &optional subfeature)
                   (or (eq feature 'android) (funcall featurep feature subfeature))))
                ((symbol-function 'find-file) (lambda (file) (setq opened file)))
                ((symbol-function 'select-frame-set-input-focus) #'ignore))
        (june-open "~/org/june-link-test.org")
        (should (equal opened (expand-file-name "~/org/june-link-test.org")))
        (setq opened nil)
        (should-error (june-open "/tmp/june-link-test.org") :type 'user-error)
        (should-not opened)))))

(ert-deftest june-links-org-searches ()
  (with-temp-buffer
    (org-mode)
    (insert "* First\nBody\n* Heading with spaces\n:PROPERTIES:\n:CUSTOM_ID: june-test\n:END:\nNeedle text\n")
    (cl-letf (((symbol-function 'find-file) #'ignore)
              ((symbol-function 'select-frame-set-input-focus) #'ignore))
      (dolist (search '("*Heading with spaces" "#june-test" "3"))
        (goto-char (point-min))
        (june-open "~/org/june-link-test.org" search)
        (should (looking-at-p "\\* Heading with spaces")))
      (fundamental-mode)
      (goto-char (point-min))
      (june-open "~/org/june-link-test.org" "Needle text")
      (should (= (line-number-at-pos) 7)))))

(ert-deftest june-links-protocol-decodes-path-and-search ()
  (let (opened)
    (cl-letf (((symbol-function 'june-open)
               (lambda (path &optional search) (setq opened (list path search)))))
      (should-not
       (org-protocol-check-filename-for-protocol
        "org-protocol://june-open?path=~%2Forg%2Fnotes%20%26%20plans.org&search=*Heading%20%26%20detail"
        nil nil))
      (should (equal opened '("~/org/notes & plans.org" "*Heading & detail")))
      (should-not (june-org-protocol '(:path "~/org/plain.org")))
      (should (equal opened '("~/org/plain.org" nil))))))

(ert-deftest june-links-protocol-registration-is-idempotent ()
  (load "june-links" nil t)
  (load "june-links" nil t)
  (should (= 1 (cl-count "june-open" org-protocol-protocol-alist
                         :key #'car :test #'equal)))
  (should (eq (plist-get (cdr (assoc "june-open" org-protocol-protocol-alist))
                         :function)
              'june-org-protocol)))
