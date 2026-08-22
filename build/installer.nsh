; Windows Firewall rules for the host role.
;
; Hosting means accepting inbound connections, and Windows blocks those by default for a new
; program. Left to the runtime, the user gets a UAC-elevated firewall prompt at the worst possible
; moment -- mid-call, with people waiting -- and clicking the wrong button there is silent and
; hard to undo. Adding the rules at install time, when elevation is already expected, gets it out
; of the way once.
;
; This covers Windows Firewall ONLY. A third-party antivirus with its own firewall -- Avast,
; Kaspersky, Norton -- filters inbound traffic independently and has to be allowed separately.
; That is the usual cause of "the address is right and nothing loads", so the app's room panel
; says so too.

!macro customInstall
  DetailPrint "Adding Windows Firewall rules for Streamer..."

  ; Remove any rule from a previous install first, so repeated installs do not stack duplicates.
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Streamer"'
  Pop $0

  nsExec::Exec 'netsh advfirewall firewall add rule name="Streamer" dir=in action=allow \
    program="$INSTDIR\${APP_EXECUTABLE_FILENAME}" enable=yes profile=any protocol=TCP'
  Pop $0
  ${If} $0 != 0
    ; Not fatal. Joining a room needs no inbound rule at all, and hosting still works once the
    ; user allows it another way -- so a failure here must not abort an otherwise good install.
    DetailPrint "Could not add the firewall rule automatically (code $0). Hosting may prompt later."
  ${EndIf}
!macroend

!macro customUnInstall
  DetailPrint "Removing Windows Firewall rules for Streamer..."
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Streamer"'
  Pop $0
!macroend
