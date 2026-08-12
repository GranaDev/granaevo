@echo off
REM ===========================================================================
REM GranaEvo - wrapper do backup diario para o Agendador de Tarefas do Windows.
REM
REM POR QUE UM .CMD E NAO O NODE DIRETO NA TAREFA:
REM   1. o Agendador nao tem "diretorio de trabalho + redirecionamento de log"
REM      de forma confiavel; aqui os dois ficam explicitos e versionados;
REM   2. o codigo de saida do node precisa CHEGAR ao Agendador, senao a coluna
REM      "Ultimo resultado da execucao" mostra 0 mesmo quando o backup falhou —
REM      e um monitoramento que sempre diz "ok" e pior que nenhum.
REM
REM As credenciais vem das variaveis de ambiente do USUARIO (setx), nunca deste
REM arquivo: ele esta versionado no git.
REM ===========================================================================

setlocal

REM UTF-8 no console: sem isto o log sai com "retenÃ§Ã£o" e fica ilegivel
REM justamente no momento em que alguem vai le-lo, que e quando deu errado.
chcp 65001 >nul

REM Raiz do repositorio = pasta deste script, um nivel acima.
set "RAIZ=%~dp0.."
cd /d "%RAIZ%"

set "LOGDIR=%USERPROFILE%\Desktop\Apps\granaevo-backups\logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"

REM Um log por dia. Mantem historico sem virar arquivo gigante.
for /f "tokens=1 delims= " %%d in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set "HOJE=%%d"
set "LOG=%LOGDIR%\backup-%HOJE%.log"

echo. >> "%LOG%"
echo ======================================================== >> "%LOG%"
echo Inicio: %DATE% %TIME% >> "%LOG%"

node scripts\backup-db.mjs >> "%LOG%" 2>&1
set "CODIGO=%ERRORLEVEL%"

echo Fim: %DATE% %TIME%  (exit %CODIGO%) >> "%LOG%"

if not "%CODIGO%"=="0" (
    echo *** BACKUP FALHOU - exit %CODIGO% *** >> "%LOG%"
)

REM Propaga o codigo para o Agendador. Sem isto ele registra sempre sucesso.
exit /b %CODIGO%
