# Airlock Terminal shell integration (see docs/adr/0002-shell-integration.md).
# Dot-sourced after the user's profile. Wraps the existing prompt so that every prompt also
# reports the current directory and environment to the app via a private OSC sequence:
#   ESC ] 7337 ; airlock ; base64(cwd) ; base64(NUL-separated KEY=VALUE) BEL
# It also marks command blocks (ADR 0007) with standard OSC 133 sequences: D;<exit> when the last
# command has finished, A where the prompt starts, and C where a command's output starts, just
# after its command line (ESC ] 7337 ; cmd ; base64(command) BEL).

if (-not $global:__airlockPrompt) {
    $global:__airlockPrompt = $function:prompt

    function global:prompt {
        # Read the status before anything else changes it.
        $ok = $global:?
        $code = if ($ok) { 0 } elseif ($global:LASTEXITCODE) { $global:LASTEXITCODE } else { 1 }
        # Put $? back the way it was, so the user's prompt still sees a failure.
        if (-not $ok) { Write-Error 'failed' -ErrorAction Ignore }
        $out = & $global:__airlockPrompt

        $utf8 = [System.Text.Encoding]::UTF8
        $e = [char]27
        $cwd = if ($PWD.Provider.Name -eq 'FileSystem') { $PWD.ProviderPath } else { '' }
        $vars = [System.Environment]::GetEnvironmentVariables()
        $env = ($vars.Keys | ForEach-Object { "$_=$($vars[$_])" }) -join [char]0
        $osc = "$e]133;D;$code$([char]7)" +
            "$e]7337;airlock;" +
            [Convert]::ToBase64String($utf8.GetBytes($cwd)) + ';' +
            [Convert]::ToBase64String($utf8.GetBytes($env)) + [char]7 +
            "$e]133;A$([char]7)"
        # In a remote session (Enter-PSSession, ADR 0008) this runs on the server, whose console
        # isn't ours: the marks go back to the app at the front of the prompt text instead. The
        # local PowerShell has already written "[server]: " by then, so the end-of-command mark is
        # made at the start of the line (save the cursor, carriage return, mark, restore), and the
        # prefix isn't taken as the command's output.
        if ($PSSenderInfo) { return "${e}7`r$osc${e}8$out" }
        [Console]::Write($osc)

        $out
    }
}

# PSReadLine hands each command line to PowerShell through this function, after Enter and before
# the command runs. Without PSReadLine there's no C mark, and the app falls back to where Enter
# was pressed.
# Locally only. Inside Enter-PSSession, PowerShell reads command lines without PSReadLine, so
# there the app works out each command from where Enter was pressed.
if (-not $PSSenderInfo -and -not $global:__airlockReadLine -and (Get-Command PSConsoleHostReadLine -ErrorAction Ignore)) {
    $global:__airlockReadLine = $function:PSConsoleHostReadLine

    function global:PSConsoleHostReadLine {
        $line = & $global:__airlockReadLine
        if ("$line".Trim()) {
            $b64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($line))
            [Console]::Write("$([char]27)]7337;cmd;$b64$([char]7)$([char]27)]133;C$([char]7)")
        }
        $line
    }
}
