// Remote sessions (ADR 0008): what a remote is, how it's stored, and the command line that
// connects to it. Plain functions, so the main process stays the only place that runs anything.
//
// A remote's fields end up in command lines, and a Team repo's files can be changed by anyone who
// can push to it, so every field is checked against a strict pattern when it's read and when it's
// saved. Nothing here is ever passed through a shell without that check and quoting.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const TRANSPORTS = { ssh: 'SSH', winrm: 'PowerShell (WinRM)', 'pwsh-ssh': 'PowerShell over SSH' };
const ENVIRONMENTS = { prod: 'PROD', test: 'TEST', dev: 'DEV' };
const SIGN_INS = { windows: 'Windows sign-in', '1password': '1Password', saved: 'Saved on each machine', ask: 'Ask each time' };
// How each connection type signs in. SSH ones use keys from ssh-agent (1Password's included), so
// there's nothing to choose.
const SIGN_INS_FOR = { winrm: ['windows', '1password', 'saved', 'ask'], ssh: [], 'pwsh-ssh': [] };

const RULES = {
  name: (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= 80 && !/[\r\n]/.test(v),
  // Host names, IPv4 and IPv6. Never starting with '-', which ssh would read as an option.
  address: (v) => typeof v === 'string' && /^(?!-)[A-Za-z0-9._:%[\]-]{1,253}$/.test(v),
  user: (v) => v === '' || (typeof v === 'string' && /^(?!-)[A-Za-z0-9._@\\-]{1,104}$/.test(v)),
  port: (v) => v === null || (Number.isInteger(v) && v >= 1 && v <= 65535),
  https: (v) => typeof v === 'boolean',
  transport: (v) => Object.hasOwn(TRANSPORTS, v),
  env: (v) => v === '' || Object.hasOwn(ENVIRONMENTS, v),
  group: (v) => typeof v === 'string' && v.length <= 60 && !/[\r\n]/.test(v),
  // Quoted as a literal in sh and PowerShell; quotes, $ and backticks are refused outright.
  startIn: (v) => typeof v === 'string' && v.length <= 260 && !/[\x00-\x1f'"`$]/.test(v),
  keepSession: (v) => typeof v === 'boolean',
  signIn: (v) => v === '' || Object.hasOwn(SIGN_INS, v),
  // A 1Password secret reference. It names a secret; it isn't one.
  // Vault and item names may have spaces; it's always single-quoted.
  passwordRef: (v) => v === '' || (typeof v === 'string' && /^op:\/\/[^\x00-\x1f'"`$\\]{3,300}$/.test(v)),
  notes: (v) => typeof v === 'string' && v.length <= 4000,
};

const EMPTY = {
  name: '', address: '', user: '', port: null, https: false, transport: 'ssh', env: '', group: '',
  startIn: '', keepSession: false, signIn: '', passwordRef: '', notes: '',
};

// The first field that's wrong, as a sentence fragment, or '' if it's all fine.
function remoteProblem(r) {
  if (!r || typeof r !== 'object') return 'isn\'t a remote';
  for (const [key, ok] of Object.entries(RULES)) {
    if (!ok(r[key])) return `has an invalid ${key === 'passwordRef' ? '1Password reference' : key === 'startIn' ? 'starting folder' : key}`;
  }
  if (r.signIn && !SIGN_INS_FOR[r.transport].includes(r.signIn)) return `can't sign in with ${SIGN_INS[r.signIn]} over ${TRANSPORTS[r.transport]}`;
  if (r.signIn === '1password' && !r.passwordRef) return 'needs a 1Password reference';
  if (['1password', 'saved'].includes(r.signIn) && !r.user) return 'needs a user name';
  if (r.keepSession && r.transport !== 'ssh') return 'can only keep the session on the server over SSH';
  if (r.https && r.transport !== 'winrm') return 'can only use HTTPS over WinRM';
  return '';
}

// Only the known fields, each of the right type.
function cleanRemote(r) {
  const out = { ...EMPTY };
  for (const key of Object.keys(EMPTY)) if (r && Object.hasOwn(r, key)) out[key] = r[key];
  if (typeof out.name === 'string') out.name = out.name.trim();
  if (typeof out.notes === 'string') out.notes = out.notes.replace(/\r\n/g, '\n').trim();
  if (out.port === '' || out.port === undefined) out.port = null;
  if (out.transport !== 'winrm') out.signIn = '';
  if (out.signIn !== '1password') out.passwordRef = '';
  return out;
}

// --- The Markdown file, one per remote, in a repo's remotes/ folder ---------------------------
//
//   # app-01
//
//   - Address: app-01.example.com
//   - Connect with: SSH
//   - User: deploy
//   - Environment: PROD
//
//   Anything after the list is notes for the team.

const LABELS = {
  address: 'Address', transport: 'Connect with', user: 'User', port: 'Port', https: 'Use HTTPS',
  env: 'Environment', group: 'Group', startIn: 'Start in', keepSession: 'Keep the session on the server',
  signIn: 'Sign in', passwordRef: 'Password',
};
const byLabel = new Map(Object.entries(LABELS).map(([k, v]) => [v.toLowerCase(), k]));
const lookup = (table, text) => Object.entries(table).find(([, label]) => label.toLowerCase() === text.toLowerCase())?.[0];
const yes = (text) => /^(yes|true|on)$/i.test(text);

function parseRemoteMarkdown(text) {
  const r = { ...EMPTY };
  const notes = [];
  let inList = false;
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const heading = line.match(/^#\s+(.+?)\s*#*$/);
    if (heading && !r.name) { r.name = heading[1]; continue; }
    const item = line.match(/^\s*[-*]\s+([^:]+):\s*(.*?)\s*$/);
    const key = item && byLabel.get(item[1].trim().toLowerCase());
    if (key && !notes.length) {
      inList = true;
      const value = item[2].replace(/^`(.*)`$/, '$1');
      if (key === 'transport') r.transport = lookup(TRANSPORTS, value) ?? value;
      else if (key === 'env') r.env = lookup(ENVIRONMENTS, value) ?? value.toLowerCase();
      else if (key === 'signIn') r.signIn = lookup(SIGN_INS, value) ?? value;
      else if (key === 'port') r.port = /^\d+$/.test(value) ? Number(value) : value;
      else if (key === 'https' || key === 'keepSession') r[key] = yes(value);
      else r[key] = value;
      continue;
    }
    // Blank lines before the notes begin are only spacing.
    if (!notes.length && !line.trim()) continue;
    if (inList || r.name) notes.push(line);
  }
  r.notes = notes.join('\n').trim();
  return r;
}

function remoteMarkdown(r) {
  const lines = [`# ${r.name}`, ''];
  const add = (key, value) => { if (value !== '' && value !== null && value !== false) lines.push(`- ${LABELS[key]}: ${value}`); };
  add('address', r.address);
  add('transport', TRANSPORTS[r.transport]);
  add('user', r.user);
  add('port', r.port);
  add('https', r.https && 'yes');
  add('env', ENVIRONMENTS[r.env] ?? '');
  add('group', r.group);
  add('startIn', r.startIn);
  add('keepSession', r.keepSession && 'yes');
  add('signIn', SIGN_INS[r.signIn] ?? '');
  add('passwordRef', r.passwordRef);
  if (r.notes) lines.push('', r.notes);
  return `${lines.join('\n')}\n`;
}

// --- ~/.ssh/config: its hosts are listed as they are, read only -------------------------------

// Host names from the config and the files it includes. Patterns (*, ?, !) aren't hosts.
function sshConfigHosts(file = path.join(os.homedir(), '.ssh', 'config'), seen = new Set()) {
  if (seen.has(file) || seen.size > 20) return [];
  seen.add(file);
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const hosts = [];
  let current = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = line.match(/^(\S+)\s*=?\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (key === 'include') {
      for (const pattern of m[2].split(/\s+/)) {
        const expanded = pattern.replace(/^~(?=\/|$)/, os.homedir());
        const full = path.isAbsolute(expanded) ? expanded : path.join(os.homedir(), '.ssh', expanded);
        for (const f of globFiles(full)) hosts.push(...sshConfigHosts(f, seen));
      }
    } else if (key === 'host') {
      current = m[2].split(/\s+/).filter((h) => /^[A-Za-z0-9._-]+$/.test(h)).map((alias) => ({ alias, user: '', hostName: '' }));
      hosts.push(...current);
    } else if (key === 'match') {
      current = [];
    } else if (key === 'hostname') {
      for (const h of current) h.hostName ||= m[2];
    } else if (key === 'user') {
      for (const h of current) h.user ||= m[2];
    }
  }
  return hosts;
}

// Enough of glob for Include lines: a * in the last part of the path.
function globFiles(pattern) {
  if (!pattern.includes('*')) return [pattern];
  const dir = path.dirname(pattern);
  const re = new RegExp(`^${path.basename(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
  try { return fs.readdirSync(dir).filter((f) => re.test(f)).sort().map((f) => path.join(dir, f)); } catch { return []; }
}

// --- 1Password's SSH agent -------------------------------------------------------------------

function onePasswordAgentSocket() {
  if (process.platform === 'win32') return null; // there it takes over the standard agent pipe
  const sock = process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Group Containers', '2BUA8C4S2C.com.1password', 't', 'agent.sock')
    : path.join(os.homedir(), '.1password', 'agent.sock');
  try { return fs.statSync(sock).isSocket() ? sock : null; } catch { return null; }
}

// Whether ~/.ssh/config already sends ssh to 1Password's agent.
function sshConfigUsesOnePassword() {
  try { return /^\s*IdentityAgent\s+.*1password/im.test(fs.readFileSync(path.join(os.homedir(), '.ssh', 'config'), 'utf8')); } catch { return false; }
}

// --- Connecting ----------------------------------------------------------------------------

const shQuote = (s) => `'${s.replace(/'/g, "'\\''")}'`;
const psQuote = (s) => `'${s.replace(/'/g, "''")}'`;
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'remote';

// The ssh destination and options shared by ssh and scp. Hosts from ~/.ssh/config are used by name,
// so everything set there applies. `acceptNew`: save a server's key the first time without asking
// (ssh's StrictHostKeyChecking=accept-new). A key that has changed is still refused.
function sshTarget(r, { scp = false, acceptNew = false } = {}) {
  const args = acceptNew ? ['-o', 'StrictHostKeyChecking=accept-new'] : [];
  if (r.port) args.push(scp ? '-P' : '-p', String(r.port));
  return { args, dest: r.user ? `${r.user}@${r.address}` : r.address };
}

// What runs on the server: a POSIX sh script, sent as base64 so no shell on the way can change it.
// It writes our shell integration to a temporary folder (removed again once the shell has read it),
// then starts the user's login shell with it, inside tmux if the session should be kept.
function sshBootstrap(r, integrationDir) {
  const file = (rel) => b64(fs.readFileSync(path.join(integrationDir, rel), 'utf8'));
  const zshFiles = ['.zshenv', '.zprofile', '.zshrc', '.zlogin'];
  const lines = [
    'd=$(mktemp -d 2>/dev/null || mktemp -d -t airlock 2>/dev/null) || d=',
    'if [ -n "$d" ]; then',
    `  printf %s ${shQuote(file('airlock.bash'))} | base64 -d > "$d/airlock.bash" 2>/dev/null || d=`,
    'fi',
    'if [ -n "$d" ]; then',
    '  mkdir "$d/zsh"',
    ...zshFiles.map((f) => `  printf %s ${shQuote(file(`zsh/${f}`))} | base64 -d > "$d/zsh/${f}"`),
    'fi',
    's=${SHELL:-/bin/sh}',
    r.startIn ? `cd ${shQuote(r.startIn)} 2>/dev/null || echo "Airlock: couldn't open ${r.startIn.replace(/[\\"]/g, '')}"` : 'cd',
    // The command that starts the shell, as one string, so tmux can run it too.
    'case "${s##*/}" in',
    '  bash) if [ -n "$d" ]; then c="env AIRLOCK_CLEANUP=$d $s --init-file $d/airlock.bash -i"; else c="$s -l"; fi ;;',
    '  zsh) if [ -n "$d" ]; then c="env AIRLOCK_CLEANUP=$d AIRLOCK_USER_ZDOTDIR=${ZDOTDIR:-} ZDOTDIR=$d/zsh $s -l"; else c="$s -l"; fi ;;',
    '  *) [ -n "$d" ] && rm -rf "$d"; c="$s -l" ;;',
    'esac',
  ];
  if (r.keepSession) {
    const session = `airlock-${slug(r.name)}`;
    lines.push(
      'if command -v tmux >/dev/null 2>&1; then',
      // Attaching to a session that's still there leaves this new shell unused, so tidy up for it.
      `  tmux has-session -t ${shQuote(session)} 2>/dev/null && [ -n "$d" ] && rm -rf "$d"`,
      `  exec tmux new-session -A -s ${shQuote(session)} "$c"`,
      'fi',
      'echo "Airlock: tmux isn\'t installed on this server, so this session ends when the connection does."',
    );
  }
  lines.push('exec $c');
  return lines.join('\n');
}

// The ssh command line for a remote tab.
function sshLaunch(r, integrationDir, { acceptNew = false } = {}) {
  const { args, dest } = sshTarget(r, { acceptNew });
  // The user's login shell runs this, whatever it is (bash, zsh, fish): plain words only, and the
  // script itself in base64 inside single quotes.
  const remoteCommand = `exec /bin/sh -c 'eval "$(printf %s ${b64(sshBootstrap(r, integrationDir))} | base64 -d)"'`;
  return { file: process.platform === 'win32' ? 'ssh.exe' : 'ssh', args: ['-t', ...args, '--', dest, remoteCommand] };
}

// PowerShell that makes $c, the credential, or leaves it $null for Windows sign-in.
function psCredential(r) {
  if (r.transport !== 'winrm') return '$c = $null';
  const user = psQuote(r.user);
  switch (r.signIn) {
    case '1password':
      // op asks for Touch ID or the 1Password password itself. The password goes straight from op
      // into a SecureString, never onto the screen or into a variable as text.
      return [
        'if (-not (Get-Command op -ErrorAction Ignore)) { throw "The 1Password CLI (op) isn\'t installed, or 1Password\'s CLI integration is off." }',
        `$c = [pscredential]::new(${user}, (op read ${psQuote(r.passwordRef)} | ConvertTo-SecureString -AsPlainText -Force))`,
        'if (-not $c.Password.Length) { throw "1Password didn\'t return a password." }',
      ].join('\n');
    case 'saved':
      // Put in this process's environment by the app, and removed from it at once.
      return [
        'if (-not $env:AIRLOCK_REMOTE_SECRET) { throw "No password is saved for this remote on this machine. Edit it to save one." }',
        `$c = [pscredential]::new(${user}, (ConvertTo-SecureString $env:AIRLOCK_REMOTE_SECRET -AsPlainText -Force))`,
        'Remove-Item Env:AIRLOCK_REMOTE_SECRET',
      ].join('\n');
    case 'ask':
      return r.user ? `$c = Get-Credential -UserName ${user} -Message ${psQuote(`Sign in to ${r.name}`)}`
        : `$c = Get-Credential -Message ${psQuote(`Sign in to ${r.name}`)}`;
    default:
      return '$c = $null';
  }
}

// Parameters for New-PSSession / Get-PSSession / Test-WSMan, as a PowerShell hashtable.
function psConnectParams(r, { name = true } = {}) {
  const p = [];
  if (r.transport === 'winrm') {
    p.push(`ComputerName = ${psQuote(r.address)}`);
    if (r.port) p.push(`Port = ${r.port}`);
    if (r.https) p.push('UseSSL = $true');
    if (name) p.push(`Name = ${psQuote(`airlock-${slug(r.name)}`)}`);
  } else {
    p.push(`HostName = ${psQuote(r.address)}`);
    if (r.user) p.push(`UserName = ${psQuote(r.user)}`);
    if (r.port) p.push(`Port = ${r.port}`);
  }
  return `@{ ${p.join('; ')} }`;
}

// The same as sshTarget's acceptNew, for PowerShell over SSH: New-PSSession's -Options, which
// PowerShell has from 7.3. Added to $p, the connection parameters.
const psSshOptions = (r, acceptNew) => (r.transport === 'pwsh-ssh' && acceptNew
  ? "if ($PSVersionTable.PSVersion -ge [version]'7.3') { $p.Options = @{ StrictHostKeyChecking = 'accept-new' } }" : '');

// Runs in the tab's local PowerShell, after the app's own integration. Picks up a session kept on
// the server if there is one, else makes a new one, loads the integration into it, and enters it.
function psBootstrap(r, integrationDir, { acceptNew = false } = {}) {
  const ps1 = psQuote(path.join(integrationDir, 'airlock.ps1'));
  const sessionName = psQuote(`airlock-${slug(r.name)}`);
  const lines = [
    'try {',
    psCredential(r),
    `$p = ${psConnectParams(r)}`,
    'if ($c) { $p.Credential = $c }',
    psSshOptions(r, acceptNew),
    '$s = $null',
  ];
  if (r.transport === 'winrm') {
    lines.push(
      `$g = ${psConnectParams(r, { name: false })}`,
      'if ($c) { $g.Credential = $c }',
      `$s = Get-PSSession @g -Name ${sessionName} -ErrorAction Ignore | Where-Object State -eq 'Disconnected' | Select-Object -First 1`,
      'if ($s) { $s = Connect-PSSession -Session $s -ErrorAction Stop; Write-Host "Picked up the session kept on the server." -ForegroundColor DarkGray }',
    );
  }
  lines.push(
    'if (-not $s) {',
    '  $s = New-PSSession @p -ErrorAction Stop',
    `  Invoke-Command -Session $s -FilePath ${ps1} -ErrorAction Continue`,
    r.startIn ? `  Invoke-Command -Session $s { Set-Location -LiteralPath ${psQuote(r.startIn)} } -ErrorAction Continue` : '',
    '}',
    '$global:AirlockSession = $s',
    'Remove-Variable c, p -ErrorAction Ignore',
    // The tab is only ever this remote: back at a local prompt, the session is over, so the shell
    // ends too and the tab shows it's not connected. Disconnect (ADR 0008) leaves a file for this
    // prompt to find, and then the session is left running on the server instead of closed.
    'function global:prompt {',
    '  if ($env:AIRLOCK_KEEP_FILE -and (Test-Path -LiteralPath $env:AIRLOCK_KEEP_FILE)) {',
    '    Remove-Item -LiteralPath $env:AIRLOCK_KEEP_FILE',
    '    Disconnect-PSSession -Session $global:AirlockSession -ErrorAction Continue | Out-Null',
    '  } else { Remove-PSSession -Session $global:AirlockSession -ErrorAction Ignore }',
    '  [Environment]::Exit(0)',
    '}',
    'Enter-PSSession -Session $s -ErrorAction Stop',
    // Never left at a local prompt in a tab labelled as the remote.
    '} catch { Write-Host "Couldn\'t connect: $($_.Exception.Message)" -ForegroundColor Red; [Environment]::Exit(1) }',
  );
  return lines.filter(Boolean).join('\n');
}


module.exports = {
  TRANSPORTS, ENVIRONMENTS, SIGN_INS, SIGN_INS_FOR, EMPTY,
  remoteProblem, cleanRemote, parseRemoteMarkdown, remoteMarkdown,
  sshConfigHosts, onePasswordAgentSocket, sshConfigUsesOnePassword,
  sshTarget, sshBootstrap, sshLaunch, psCredential, psConnectParams, psSshOptions, psBootstrap,
  shQuote, psQuote, slug,
};
