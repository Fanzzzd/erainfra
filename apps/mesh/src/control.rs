//! The local control socket.
//!
//! On Unix it is a Unix domain socket, mode 0660, so the daemon's own user and members of its group
//! (the Infra Agent) may drive it and nobody else may. On Windows it is a named pipe that refuses
//! remote clients; there the path names the pipe, for example `\\.\pipe\erainfra-mesh`.

use std::sync::Arc;

use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};

use crate::api::{self, ApiError, MAX_REQUEST_BYTES, Response};
use crate::daemon::Daemon;

/// Serves one client: one JSON request per line, one JSON response per line, in order.
pub async fn serve_client<S>(stream: S, daemon: Arc<Daemon>)
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let (read, mut write) = tokio::io::split(stream);
    let mut reader = BufReader::new(read);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        let n = match (&mut reader)
            .take(MAX_REQUEST_BYTES as u64 + 1)
            .read_until(b'\n', &mut buf)
            .await
        {
            Ok(n) => n,
            Err(_) => return,
        };
        if n == 0 {
            return;
        }
        let too_long = buf.len() > MAX_REQUEST_BYTES;
        let response = if too_long {
            Response::err(
                None,
                ApiError::bad_request(format!("request longer than {MAX_REQUEST_BYTES} bytes")),
            )
        } else {
            match std::str::from_utf8(&buf) {
                Ok(line) if line.trim().is_empty() => continue,
                Ok(line) => {
                    let (id, req) = api::parse_request(line.trim());
                    match req {
                        Ok(req) => match daemon.handle(req).await {
                            Ok(result) => Response::ok(id, result),
                            Err(e) => Response::err(id, e),
                        },
                        Err(e) => Response::err(id, e),
                    }
                }
                Err(_) => Response::err(None, ApiError::bad_request("request is not UTF-8")),
            }
        };
        let mut out = serde_json::to_vec(&response).expect("response serializes");
        out.push(b'\n');
        if write.write_all(&out).await.is_err() || write.flush().await.is_err() {
            return;
        }
        if too_long {
            // The rest of the oversized line is still unread, so there is no telling where the
            // next request starts. End the session.
            return;
        }
    }
}

/// Binds a Unix socket at `path` with mode 0660, without ever exposing it under a wider mode.
///
/// The socket is bound under a temporary name, restricted, and only then renamed into place, so a
/// client can never reach the final path while the socket still has umask-derived permissions.
#[cfg(unix)]
pub fn bind_unix(path: &std::path::Path) -> anyhow::Result<tokio::net::UnixListener> {
    use std::os::unix::fs::{FileTypeExt, PermissionsExt};

    use anyhow::{Context, bail};

    if let Ok(meta) = std::fs::symlink_metadata(path) {
        if !meta.file_type().is_socket() {
            bail!(
                "{} exists and is not a socket; refusing to replace it",
                path.display()
            );
        }
        if std::os::unix::net::UnixStream::connect(path).is_ok() {
            bail!(
                "another erainfra-mesh daemon is already serving {}",
                path.display()
            );
        }
        std::fs::remove_file(path)
            .with_context(|| format!("cannot remove stale socket {}", path.display()))?;
    }
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "mesh.sock".into());
    let tmp = path.with_file_name(format!(".{file_name}.{}", std::process::id()));
    let _ = std::fs::remove_file(&tmp);
    let listener = tokio::net::UnixListener::bind(&tmp)
        .with_context(|| format!("cannot bind the control socket at {}", tmp.display()))?;
    let placed = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o660))
        .and_then(|()| std::fs::rename(&tmp, path));
    if let Err(e) = placed {
        let _ = std::fs::remove_file(&tmp);
        return Err(e)
            .with_context(|| format!("cannot place the control socket at {}", path.display()));
    }
    Ok(listener)
}

/// Serves the control named pipe until `shutdown` fires.
#[cfg(windows)]
pub async fn run_pipe(
    path: &std::path::Path,
    daemon: Arc<Daemon>,
    shutdown: tokio_util::sync::CancellationToken,
) -> anyhow::Result<()> {
    use anyhow::Context;
    use tokio::net::windows::named_pipe::ServerOptions;

    let name = path.as_os_str();
    let mut server = ServerOptions::new()
        .first_pipe_instance(true)
        .reject_remote_clients(true)
        .create(name)
        .with_context(|| format!("cannot create the control pipe {}", path.display()))?;
    loop {
        tokio::select! {
            _ = shutdown.cancelled() => return Ok(()),
            connected = server.connect() => {
                connected.context("control pipe connect failed")?;
                let client = server;
                server = ServerOptions::new()
                    .reject_remote_clients(true)
                    .create(name)
                    .with_context(|| format!("cannot create the control pipe {}", path.display()))?;
                tokio::spawn(serve_client(client, daemon.clone()));
            }
        }
    }
}
