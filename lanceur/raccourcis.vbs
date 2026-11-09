' lanceur/raccourcis.vbs - cree sur le Bureau les deux raccourcis du lanceur unique (LC1), une seule fois (un raccourci existant est
' remplace) : "Livres - Lancer" (icone print.ico) et "Livres - Tout arreter" (icone de Windows). Double-clic, ou wscript.exe raccourcis.vbs.
' Les raccourcis executent wscript.exe sur lanceur.vbs : aucune fenetre de commande. Fichier en ASCII : tirets et accents par ChrW.
Option Explicit
Dim sh, fso, dossier, racine, bureau, wscriptExe, tiret
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dossier = fso.GetParentFolderName(WScript.ScriptFullName)
racine = fso.GetParentFolderName(dossier)
bureau = sh.SpecialFolders("Desktop")
wscriptExe = sh.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\wscript.exe"
tiret = " " & ChrW(8211) & " "

Sub Creer(nom, mode, icone, description)
  Dim l
  Set l = sh.CreateShortcut(bureau & "\" & nom & ".lnk")
  l.TargetPath = wscriptExe
  l.Arguments = """" & dossier & "\lanceur.vbs"" " & mode
  l.WorkingDirectory = racine
  l.IconLocation = icone
  l.Description = description
  l.WindowStyle = 1
  l.Save
End Sub

Creer "Livres" & tiret & "Lancer", "lancer", racine & "\print.ico,0", "Studio, Print et ComfyUI en arriere-plan"
Creer "Livres" & tiret & "Tout arr" & ChrW(234) & "ter", "arreter", sh.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\shell32.dll,131", "Arrete ce que le lanceur a demarre"
