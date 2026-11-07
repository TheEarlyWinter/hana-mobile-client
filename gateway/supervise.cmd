@echo off
rem ---------------------------------------------------------------------
rem 网关守护：崩了自动拉起，连续快速失败时指数退避。
rem
rem 为什么不再固定 2 秒：网关起不来（端口占用、配置写错、node 路径变了）时，
rem 2 秒一循环会在几分钟里把日志刷成几十 MB，还把 CPU 占满。
rem 现在：连续失败 2/4/8/16/32/60 秒退避；成功跑满 30 秒后计数归零。
rem 计时与退避计算在 gateway\supervise-delay.mjs（纯函数，有单测），cmd 只负责编排。
rem
rem 手机上调试时网关一停，整个界面就只剩「Failed to fetch」，
rem 而现场往往已经看不到了——所以宁可自动重启，日志留在 %TEMP% 里。
rem ---------------------------------------------------------------------
cd /d "%~dp0.."

set "NODE_EXE=C:\Program Files\nodejs\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"
set "OUT_LOG=%TEMP%\hana-gateway.log"
set "ERR_LOG=%TEMP%\hana-gateway.err.log"
set "DELAY_HELPER=gateway\supervise-delay.mjs"
set "DELAY_STATE=%TEMP%\hana-gateway.backoff"
set "DELAY_FILE=%TEMP%\hana-gateway.delay"

:loop
call :rotate "%OUT_LOG%"
call :rotate "%ERR_LOG%"

echo [supervise] %date% %time% starting gateway>>"%OUT_LOG%"
set "T0=%TIME%"
"%NODE_EXE%" gateway\server.mjs >>"%OUT_LOG%" 2>>"%ERR_LOG%"
set "CODE=%ERRORLEVEL%"
set "T1=%TIME%"

rem 默认 2 秒；助手算得出来就用它算的（连续失败会一路退到 60 秒上限）
set "DELAY=2"
if exist "%DELAY_FILE%" del /q "%DELAY_FILE%" >nul 2>nul
if exist "%DELAY_HELPER%" (
  "%NODE_EXE%" "%DELAY_HELPER%" --start "%T0%" --end "%T1%" --state "%DELAY_STATE%" --out "%DELAY_FILE%" >nul 2>nul
  if exist "%DELAY_FILE%" for /f "usebackq tokens=1,2 delims==" %%a in ("%DELAY_FILE%") do set "%%a=%%b"
)

echo [supervise] %date% %time% gateway exited with %CODE%, restarting in %DELAY%s>>"%OUT_LOG%"
timeout /t %DELAY% /nobreak >nul
goto loop

rem 日志按大小轮转一次：守护会长期跑，不轮转迟早把磁盘写满。
rem 只在刚跑完一轮、没有进程持有句柄时调用，move 才不会失败。
:rotate
if not exist "%~1" goto :eof
for %%F in ("%~1") do if %%~zF GTR 5242880 move /y "%~1" "%~1.1" >nul 2>nul
goto :eof
