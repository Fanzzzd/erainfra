# Joining a Windows box to the mesh

Windows needs its own bootstrap (`mesh-node.ps1`, served next to the `.sh` one) and **one
interactive step**, because:

- There's no POSIX shell, so `mesh-node.sh` won't run — use the PowerShell version.
- A Windows box typically exposes only **RDP** (and maybe SMB), not SSH/WinRM, so there's no clean
  remote-exec channel from outside.
- Even with admin SMB creds, **UAC remote token filtering** strips a *local* admin account's rights
  over the network (`rpc_s_access_denied` for psexec/atexec). So the first run must be done **on the
  box** (via RDP). After that it's reachable over the mesh like anything else.

## Install (run once, in an RDP session)

RDP into the box, open **PowerShell**, and run one line. Example — put this box's **Remote Desktop
(3389)** on the mesh so you can reach it from anywhere with no public IP:

```powershell
& ([scriptblock]::Create((irm https://<hub>/mesh-node.ps1))) share 3389
```

It downloads a prebuilt `dumbpipe.exe` (no build tools), persists a stable identity, and prints a
**ticket** plus the exact `connect` line for the other box. Other commands:

```powershell
& ([scriptblock]::Create((irm https://<hub>/mesh-node.ps1))) connect <ticket> 15432
& ([scriptblock]::Create((irm https://<hub>/mesh-node.ps1))) status
& ([scriptblock]::Create((irm https://<hub>/mesh-node.ps1))) stop share-3389
```

## Reach it from another box

On any Linux/macOS box (or another Windows box), dial the ticket onto a local port:

```bash
curl -fsSL https://<hub>/mesh-node.sh | sh -s -- connect <ticket> 13389
# now 127.0.0.1:13389 is the Windows box's RDP, over the mesh, no public IP
```

## Reboot-survival

The link runs as a normal process and outlives the launching shell, but **not a reboot**. To make
it permanent, register a Scheduled Task at startup (run once, elevated):

```powershell
$action  = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -Command "& ([scriptblock]::Create((irm https://<hub>/mesh-node.ps1))) share 3389"'
$trigger = New-ScheduledTaskTrigger -AtStartup
Register-ScheduledTask -TaskName 'portless-mesh-rdp' -Action $action -Trigger $trigger -RunLevel Highest -User 'SYSTEM'
```

## Optional: manage it over the mesh via SSH

To get a clean shell for ongoing management (deploy/run things, portless control), enable Windows'
built-in OpenSSH and put it on the mesh — then SSH to it from anywhere over iroh:

```powershell
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Start-Service sshd; Set-Service sshd -StartupType Automatic
& ([scriptblock]::Create((irm https://<hub>/mesh-node.ps1))) share 22
```

Then from your box: `connect <ssh-ticket> 2222`, and `ssh admin@127.0.0.1 -p 2222`.
