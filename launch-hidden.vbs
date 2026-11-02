' Starts Jira App in the background (no console window) and logs to logs\server.log.
' Used by the Startup-folder and Desktop shortcuts. If the app is already running,
' server.js just opens the browser and exits.
Option Explicit
Dim fso, shell, appDir, logDir, logFile, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

appDir = fso.GetParentFolderName(WScript.ScriptFullName)
logDir = appDir & "\logs"
logFile = logDir & "\server.log"
If Not fso.FolderExists(logDir) Then fso.CreateFolder logDir

' Simple log rotation at ~5 MB
If fso.FileExists(logFile) Then
  If fso.GetFile(logFile).Size > 5242880 Then
    If fso.FileExists(logDir & "\server.old.log") Then fso.DeleteFile logDir & "\server.old.log", True
    fso.MoveFile logFile, logDir & "\server.old.log"
  End If
End If

shell.CurrentDirectory = appDir
cmd = "cmd.exe /c node """ & appDir & "\server.js"" >> """ & logFile & """ 2>&1"
shell.Run cmd, 0, False
