@echo off
rem book-print (MP1) : double-clic pour lancer la mise en page du livre imprime.
rem La page s'ouvre dans le navigateur (http://127.0.0.1:4200/) ; cette fenetre reste ouverte tant que l'outil tourne.
rem Pour l'arreter : Ctrl+C ici, ou fermer la fenetre.
rem Sur le Bureau : clic droit sur print.cmd, Envoyer vers, Bureau (creer un raccourci). Une copie du fichier hors du
rem repo ne trouverait pas le repo.
setlocal
cd /d "%~dp0"
if not exist "package.json" (
  echo print.cmd doit rester a la racine du repo book-print.
  echo Pour le Bureau : clic droit sur print.cmd, Envoyer vers, Bureau ^(creer un raccourci^).
  pause
  exit /b 1
)
title book-print
call npm run print
if errorlevel 1 pause
