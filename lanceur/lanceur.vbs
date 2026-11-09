' lanceur/lanceur.vbs - lanceur unique de book-print (LC1). Execute par wscript.exe, sans fenetre de commande :
'   wscript.exe lanceur.vbs lancer     icone "Livres - Lancer" : Studio de GLBInterpreter, Print et ComfyUI, en arriere-plan
'   wscript.exe lanceur.vbs arreter    icone "Livres - Tout arreter" : ce que le lanceur a demarre, et seulement cela
'   wscript.exe lanceur.vbs message <texte>   fenetre de message (lignes separees par |), appelee par le lanceur
' Le travail est fait par src\lanceur\main.ts (Node, dans une console cachee : style de fenetre 0). Journaux : .lanceur\journaux\.
' Les raccourcis du Bureau sont crees par raccourcis.vbs. Fichier en ASCII : wscript lit les .vbs en ANSI.
Option Explicit
Dim sh, fso, racine, mode, commande
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
racine = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
mode = "lancer"
If WScript.Arguments.Count > 0 Then mode = WScript.Arguments(0)

If mode = "message" Then
  If WScript.Arguments.Count > 1 Then MsgBox Replace(WScript.Arguments(1), "|", vbCrLf), vbExclamation + vbSystemModal, "Livres"
  WScript.Quit 0
End If
If mode <> "lancer" And mode <> "arreter" Then
  MsgBox "lanceur.vbs : mode inconnu (" & mode & "). Modes : lancer, arreter.", vbCritical + vbSystemModal, "Livres"
  WScript.Quit 1
End If
If Not fso.FileExists(racine & "\src\lanceur\main.ts") Then
  MsgBox "lanceur.vbs doit rester dans le dossier lanceur du repo book-print (" & racine & ").", vbCritical + vbSystemModal, "Livres"
  WScript.Quit 1
End If

sh.CurrentDirectory = racine
commande = "node --import tsx ""src\lanceur\main.ts"" " & mode
On Error Resume Next
sh.Run commande, 0, False
If Err.Number <> 0 Then
  MsgBox "Impossible de lancer Node (" & Err.Description & ")." & vbCrLf & "Commande : " & commande & vbCrLf & "Dossier : " & racine, vbCritical + vbSystemModal, "Livres"
  WScript.Quit 1
End If
