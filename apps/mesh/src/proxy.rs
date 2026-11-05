//! The stream protocol behind ALPN `erainfra/tcp/1`, and the byte pump both ends share.
//!
//! One QUIC bidirectional stream carries one TCP connection. The dialing side (a link) opens the
//! stream and writes a header naming the service:
//!
//! ```text
//! u16 big-endian  name length (1..=64)
//! bytes           service name
//! ```
//!
//! The accepting side (an exposure) answers with one status byte, then both directions carry raw
//! bytes until each side finishes its half. The link does not wait for the status before sending:
//! the header and the first client bytes leave together, which saves a round trip per connection,
//! and a refused stream simply discards them.

use std::io;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};

pub const STATUS_OK: u8 = 0;
pub const STATUS_UNKNOWN_SERVICE: u8 = 1;
pub const STATUS_TARGET_UNREACHABLE: u8 = 2;
pub const STATUS_BUSY: u8 = 3;

pub fn status_text(status: u8) -> &'static str {
    match status {
        STATUS_OK => "ok",
        STATUS_UNKNOWN_SERVICE => "the peer exposes no such service",
        STATUS_TARGET_UNREACHABLE => "the peer could not reach the service's target",
        STATUS_BUSY => "the peer's exposure is at its connection limit",
        _ => "unknown status",
    }
}

/// How long the accepting side waits for a stream header before dropping the stream.
pub const HEADER_TIMEOUT: Duration = Duration::from_secs(10);

pub async fn write_header<W: AsyncWrite + Unpin>(w: &mut W, service: &str) -> io::Result<()> {
    let len =
        u16::try_from(service.len()).map_err(|_| io::Error::other("service name too long"))?;
    let mut buf = Vec::with_capacity(2 + service.len());
    buf.extend_from_slice(&len.to_be_bytes());
    buf.extend_from_slice(service.as_bytes());
    w.write_all(&buf).await
}

pub async fn read_header<R: AsyncRead + Unpin>(r: &mut R) -> io::Result<String> {
    let len = r.read_u16().await? as usize;
    if len == 0 || len > 64 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "bad service name length",
        ));
    }
    let mut name = vec![0u8; len];
    r.read_exact(&mut name).await?;
    String::from_utf8(name)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "service name is not UTF-8"))
}

/// Byte and connection counters for one link or exposure, reported by `status`.
#[derive(Debug, Default)]
pub struct Counters {
    /// Bytes sent into the mesh (towards the peer).
    pub bytes_sent: AtomicU64,
    /// Bytes received from the mesh (from the peer).
    pub bytes_received: AtomicU64,
    pub connections_active: AtomicU64,
    pub connections_total: AtomicU64,
    pub connections_refused: AtomicU64,
}

impl Counters {
    pub fn json(&self) -> serde_json::Value {
        serde_json::json!({
            "bytes_sent": self.bytes_sent.load(Ordering::Relaxed),
            "bytes_received": self.bytes_received.load(Ordering::Relaxed),
            "connections_active": self.connections_active.load(Ordering::Relaxed),
            "connections_total": self.connections_total.load(Ordering::Relaxed),
            "connections_refused": self.connections_refused.load(Ordering::Relaxed),
        })
    }
}

/// Marks one connection active for as long as it lives.
pub struct ActiveGuard(Arc<Counters>);

impl ActiveGuard {
    pub fn new(c: Arc<Counters>) -> Self {
        c.connections_active.fetch_add(1, Ordering::Relaxed);
        c.connections_total.fetch_add(1, Ordering::Relaxed);
        Self(c)
    }
}

impl Drop for ActiveGuard {
    fn drop(&mut self) {
        self.0.connections_active.fetch_sub(1, Ordering::Relaxed);
    }
}

struct Activity {
    start: Instant,
    last_ms: AtomicU64,
}

impl Activity {
    fn new() -> Self {
        Self {
            start: Instant::now(),
            last_ms: AtomicU64::new(0),
        }
    }
    fn touch(&self) {
        let ms = self.start.elapsed().as_millis() as u64;
        self.last_ms.store(ms, Ordering::Relaxed);
    }
    fn idle_for(&self) -> Duration {
        let now = self.start.elapsed().as_millis() as u64;
        Duration::from_millis(now.saturating_sub(self.last_ms.load(Ordering::Relaxed)))
    }
}

const PUMP_BUFFER: usize = 64 * 1024;

async fn pump<R, W>(mut r: R, mut w: W, counter: &AtomicU64, activity: &Activity) -> io::Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut buf = vec![0u8; PUMP_BUFFER];
    loop {
        let n = r.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        w.write_all(&buf[..n]).await?;
        counter.fetch_add(n as u64, Ordering::Relaxed);
        activity.touch();
    }
    // Propagate the half-close: TCP FIN becomes a QUIC stream FIN and the other way round.
    w.shutdown().await
}

/// Copies both directions between a local TCP connection and a mesh stream until both halves
/// finish, either side fails, or nothing has moved in either direction for `idle`.
pub async fn splice<LR, LW, MR, MW>(
    local_read: LR,
    local_write: LW,
    mesh_read: MR,
    mesh_write: MW,
    counters: &Counters,
    idle: Duration,
) -> io::Result<()>
where
    LR: AsyncRead + Unpin,
    LW: AsyncWrite + Unpin,
    MR: AsyncRead + Unpin,
    MW: AsyncWrite + Unpin,
{
    let activity = Activity::new();
    let up = pump(local_read, mesh_write, &counters.bytes_sent, &activity);
    let down = pump(mesh_read, local_write, &counters.bytes_received, &activity);
    let both = async { tokio::try_join!(up, down).map(|_| ()) };
    let watchdog = async {
        let tick = (idle / 4).clamp(Duration::from_millis(50), Duration::from_secs(30));
        loop {
            tokio::time::sleep(tick).await;
            if activity.idle_for() >= idle {
                return io::Error::new(io::ErrorKind::TimedOut, "idle timeout");
            }
        }
    };
    tokio::select! {
        r = both => r,
        e = watchdog => Err(e),
    }
}

/// Wraps the link side's receive stream and consumes the exposure's status byte before any data.
///
/// The link starts sending as soon as the header is written, so the status is checked here, on
/// the first read, rather than before the splice starts. A refusal turns into a read error, which
/// ends the splice and closes the local TCP connection; the status is kept for the log line.
pub struct StatusGate<R> {
    inner: R,
    passed: bool,
    answer: Arc<OnceLock<u8>>,
}

impl<R> StatusGate<R> {
    pub fn new(inner: R) -> Self {
        Self {
            inner,
            passed: false,
            answer: Arc::default(),
        }
    }

    /// The status byte the peer answered with, once it has. Still empty after the splice means
    /// the peer never accepted the stream: its connection or the stream closed first.
    pub fn answer(&self) -> Arc<OnceLock<u8>> {
        self.answer.clone()
    }
}

impl<R: AsyncRead + Unpin> AsyncRead for StatusGate<R> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if !self.passed {
            let mut byte = [0u8; 1];
            let mut status = ReadBuf::new(&mut byte);
            match Pin::new(&mut self.inner).poll_read(cx, &mut status) {
                Poll::Pending => return Poll::Pending,
                Poll::Ready(Err(e)) => return Poll::Ready(Err(e)),
                Poll::Ready(Ok(())) => {}
            }
            if status.filled().is_empty() {
                return Poll::Ready(Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "the peer closed the stream without answering",
                )));
            }
            let _ = self.answer.set(byte[0]);
            if byte[0] != STATUS_OK {
                return Poll::Ready(Err(io::Error::new(
                    io::ErrorKind::ConnectionRefused,
                    status_text(byte[0]),
                )));
            }
            self.passed = true;
        }
        Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}
