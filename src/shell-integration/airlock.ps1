# Airlock Terminal shell integration (see docs/adr/0002-shell-integration.md).
# Dot-sourced after the user's profile. Wraps the existing prompt so that every prompt also
# reports the current directory and environment to the app via a private OSC sequence:
#   ESC ] 7337 ; airlock ; base64(cwd) ; base64(NUL-separated KEY=VALUE) BEL

if (-not $global:__airlockPrompt) {
    $global:__airlockPrompt = $function:prompt

    function global:prompt {
        # Run the user's prompt first so it still sees the real $? / $LASTEXITCODE.
        $out = & $global:__airlockPrompt

        $utf8 = [System.Text.Encoding]::UTF8
        $cwd = if ($PWD.Provider.Name -eq 'FileSystem') { $PWD.ProviderPath } else { '' }
        $vars = [System.Environment]::GetEnvironmentVariables()
        $env = ($vars.Keys | ForEach-Object { "$_=$($vars[$_])" }) -join [char]0
        $osc = [char]27 + ']7337;airlock;' +
            [Convert]::ToBase64String($utf8.GetBytes($cwd)) + ';' +
            [Convert]::ToBase64String($utf8.GetBytes($env)) + [char]7
        [Console]::Write($osc)

        $out
    }
}
