# Joining a Windows box to the mesh

A Windows box needs **one interactive step** to enroll — run a single line in an RDP session — because:

- A Windows box typically exposes only **RDP** (maybe SMB), not SSH/WinRM, so there's no clean
  remote-exec channel from outside.
- Even with admin SMB creds, **UAC remote token filtering** strips a _local_ admin's rights over the
  network (`rpc_s_access_denied` for psexec/atexec). So the first run must happen **on the box** (RDP).

After that one line the box is on the mesh and you drive it (exec, deploy) from the hub like any node.
This is universal — Tailscale/k8s/Coolify all need one command on the node too.

## Install (run once, in an RDP session)

RDP into the box, open **PowerShell**, and run:

```powershell
& ([scriptblock]::Create((irm https://<hub>/agent.ps1))) -Token <token> -Name <name> -Install
```

It downloads the prebuilt agent from the hub (no build tools), starts it, and makes it survive reboot.
The hub URL defaults to wherever the script was served from, so usually just `-Token` (and `-Name`)
are needed. The agent dials OUT over WSS — no inbound port, works behind NAT.

**Reboot-survival, no admin required.** `-Install` first tries a Scheduled Task; on a UAC-filtered
local admin in a non-elevated shell that's Access-Denied, so it automatically falls back to a per-user
**Startup entry** (`shell:startup\portless-agent.cmd`) — which needs no elevation and reconnects at
each logon. To remove: `del "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\portless-agent.cmd"`
(or `Unregister-ScheduledTask -TaskName PortlessAgent -Confirm:$false` if the task path was used).

Without `-Install` the agent just runs in the current window (Ctrl-C to stop) — handy for a quick test.

## Running containers on Windows

The agent enrolls and accepts `exec`/`deploy` immediately, but **deploying app containers needs a
working container runtime on the box**. Linux images (most apps) require Docker with a healthy **WSL2**
backend. The installer reports what's present and what's missing on every run. To set up the stack:

```powershell
& ([scriptblock]::Create((irm https://<hub>/agent.ps1))) -Token <token> -Install -SetupRuntime
```

`-SetupRuntime` (run elevated) enables the `VirtualMachinePlatform`/WSL features and updates the WSL2
kernel — it never reboots on its own; it tells you when a reboot is needed. After the reboot, install
Docker once and Linux deploys flow through the already-running agent. If `wsl --install` keeps failing
at `CreateVm/HCS/E_INVALIDARG` even after a reboot, nested virtualization is off on the host/BIOS that
runs this box — enable it there.

## Manage it over the mesh

Once enrolled, run commands on the box from the hub (`agents.run`) or deploy containers (`agents.deploy`)
— no SSH needed. If you want a shell anyway, enable Windows' built-in OpenSSH:

```powershell
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Start-Service sshd; Set-Service sshd -StartupType Automatic
```
