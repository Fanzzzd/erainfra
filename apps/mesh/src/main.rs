//! `erainfra-mesh` command line. See apps/mesh/README.md.

use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use erainfra_mesh::daemon::{self, Config, Daemon};
use erainfra_mesh::key;

const USAGE: &str = "\
erainfra-mesh: EraInfra's Node-to-Node data plane on iroh

Usage:
  erainfra-mesh init --key <path>
      Create the Node's endpoint key (mode 0600) and print its EndpointId.
      Refuses if <path> already exists.
  erainfra-mesh id --key <path>
      Print the EndpointId of an existing key.
  erainfra-mesh daemon --key <path> --socket <path> [options]
      Run the endpoint and serve the control API on <socket>.
      --state <dir>          persist the last configuration and restore it on start
      --idle-timeout <secs>  close a forwarded TCP connection idle this long (default 3600)
      --loopback-only        bind the endpoint to 127.0.0.1 (offline tests or local use)
      --no-portmap           do not ask the local router for a port mapping (UPnP, PCP, NAT-PMP)
      --log-format <fmt>     text (default) or json; level from RUST_LOG (default info)
  erainfra-mesh ctl --socket <path> <json>
      Send one control request and print the response, e.g. '{\"v\":1,\"op\":\"status\"}'.
  erainfra-mesh version
";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(args) {
        Ok(code) => code,
        Err(e) => {
            eprintln!("erainfra-mesh: {e:#}");
            ExitCode::FAILURE
        }
    }
}

/// Flags that take no value.
const SWITCHES: &[&str] = &["no-portmap", "loopback-only"];

struct Flags {
    values: Vec<(String, String)>,
    positional: Vec<String>,
}

impl Flags {
    fn parse(args: &[String], known: &[&str]) -> Result<Self> {
        let mut values = Vec::new();
        let mut positional = Vec::new();
        let mut it = args.iter();
        while let Some(arg) = it.next() {
            if let Some(name) = arg.strip_prefix("--") {
                let (name, inline) = match name.split_once('=') {
                    Some((n, v)) => (n, Some(v.to_string())),
                    None => (name, None),
                };
                if SWITCHES.contains(&name) && known.contains(&name) {
                    if inline.is_some() {
                        bail!("--{name} takes no value");
                    }
                    values.push((name.to_string(), String::new()));
                    continue;
                }
                if !known.contains(&name) {
                    bail!("unknown flag --{name}\n\n{USAGE}");
                }
                let value = match inline {
                    Some(v) => v,
                    None => it
                        .next()
                        .cloned()
                        .with_context(|| format!("--{name} needs a value"))?,
                };
                values.push((name.to_string(), value));
            } else {
                positional.push(arg.clone());
            }
        }
        Ok(Self { values, positional })
    }

    fn get(&self, name: &str) -> Option<&str> {
        self.values
            .iter()
            .rev()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.as_str())
    }

    fn require(&self, name: &str) -> Result<&str> {
        self.get(name)
            .with_context(|| format!("--{name} is required\n\n{USAGE}"))
    }
}

fn run(args: Vec<String>) -> Result<ExitCode> {
    let Some((cmd, rest)) = args.split_first() else {
        eprint!("{USAGE}");
        return Ok(ExitCode::from(2));
    };
    match cmd.as_str() {
        "init" => {
            let flags = Flags::parse(rest, &["key"])?;
            let key = key::init(&PathBuf::from(flags.require("key")?))?;
            println!("{}", key.public());
            Ok(ExitCode::SUCCESS)
        }
        "id" => {
            let flags = Flags::parse(rest, &["key"])?;
            let key = key::load(&PathBuf::from(flags.require("key")?))?;
            println!("{}", key.public());
            Ok(ExitCode::SUCCESS)
        }
        "daemon" => {
            let flags = Flags::parse(
                rest,
                &[
                    "key",
                    "socket",
                    "state",
                    "idle-timeout",
                    "log-format",
                    "no-portmap",
                    "loopback-only",
                ],
            )?;
            init_logging(flags.get("log-format").unwrap_or("text"))?;
            let mut cfg = Config::new(
                PathBuf::from(flags.require("key")?),
                PathBuf::from(flags.require("socket")?),
            );
            cfg.state_dir = flags.get("state").map(PathBuf::from);
            cfg.portmapper = flags.get("no-portmap").is_none();
            cfg.loopback_only = flags.get("loopback-only").is_some();
            if let Some(secs) = flags.get("idle-timeout") {
                let secs: u64 = secs.parse().ok().filter(|s| *s > 0).with_context(|| {
                    format!("--idle-timeout {secs:?} must be a positive number of seconds")
                })?;
                cfg.idle_timeout = Duration::from_secs(secs);
            } else {
                cfg.idle_timeout = daemon::DEFAULT_IDLE_TIMEOUT;
            }
            runtime()?.block_on(run_daemon(cfg))?;
            Ok(ExitCode::SUCCESS)
        }
        "ctl" => {
            let flags = Flags::parse(rest, &["socket"])?;
            let socket = PathBuf::from(flags.require("socket")?);
            let [request] = flags.positional.as_slice() else {
                bail!("ctl takes exactly one JSON request\n\n{USAGE}");
            };
            let response = runtime()?.block_on(ctl(socket, request.clone()))?;
            println!("{response}");
            let ok = serde_json::from_str::<serde_json::Value>(&response)
                .ok()
                .and_then(|v| v.get("ok").and_then(|o| o.as_bool()))
                .unwrap_or(false);
            Ok(if ok {
                ExitCode::SUCCESS
            } else {
                ExitCode::FAILURE
            })
        }
        "version" | "--version" | "-V" => {
            println!("erainfra-mesh {}", env!("CARGO_PKG_VERSION"));
            Ok(ExitCode::SUCCESS)
        }
        "help" | "--help" | "-h" => {
            print!("{USAGE}");
            Ok(ExitCode::SUCCESS)
        }
        other => bail!("unknown command {other:?}\n\n{USAGE}"),
    }
}

fn runtime() -> Result<tokio::runtime::Runtime> {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .context("cannot start the async runtime")
}

fn init_logging(format: &str) -> Result<()> {
    use tracing_subscriber::EnvFilter;
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let builder = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr);
    match format {
        "text" => builder.init(),
        "json" => builder.json().init(),
        other => bail!("--log-format {other:?} must be text or json"),
    }
    Ok(())
}

async fn run_daemon(cfg: Config) -> Result<()> {
    let mut running = Daemon::start(cfg).await?;
    let outcome = tokio::select! {
        _ = shutdown_signal() => {
            tracing::info!("shutting down");
            Ok(())
        }
        r = running.wait_control() => r,
    };
    running.shutdown().await;
    outcome
}

#[cfg(unix)]
async fn shutdown_signal() {
    use tokio::signal::unix::{SignalKind, signal};
    let mut term = signal(SignalKind::terminate()).expect("SIGTERM handler");
    let mut int = signal(SignalKind::interrupt()).expect("SIGINT handler");
    tokio::select! {
        _ = term.recv() => {}
        _ = int.recv() => {}
    }
}

#[cfg(windows)]
async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}

#[cfg(unix)]
async fn ctl(socket: PathBuf, request: String) -> Result<String> {
    let stream = tokio::net::UnixStream::connect(&socket)
        .await
        .with_context(|| format!("cannot connect to {}", socket.display()))?;
    exchange(stream, request).await
}

#[cfg(windows)]
async fn ctl(socket: PathBuf, request: String) -> Result<String> {
    let client = tokio::net::windows::named_pipe::ClientOptions::new()
        .open(socket.as_os_str())
        .with_context(|| format!("cannot open {}", socket.display()))?;
    exchange(client, request).await
}

async fn exchange<S>(stream: S, request: String) -> Result<String>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let (read, mut write) = tokio::io::split(stream);
    write.write_all(request.trim().as_bytes()).await?;
    write.write_all(b"\n").await?;
    write.flush().await?;
    let mut line = String::new();
    BufReader::new(read).read_line(&mut line).await?;
    if line.is_empty() {
        bail!("the daemon closed the connection without answering");
    }
    Ok(line.trim_end().to_string())
}
