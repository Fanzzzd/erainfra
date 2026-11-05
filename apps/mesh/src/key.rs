//! The Node's endpoint key: created once by `init`, loaded by `daemon`.
//!
//! The EndpointId is the public half, so keeping this file is what keeps a Node's identity across
//! restarts and upgrades (ADR 0016, decision 2). The file holds the 32-byte Ed25519 secret as 64
//! lowercase hex characters and a newline.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use iroh::SecretKey;

/// Creates a new secret key at `path` and returns it.
///
/// Refuses if anything already exists at `path`: overwriting a key silently changes the Node's
/// identity, and every peer's allowlist entry for it stops matching.
///
/// The write is atomic and never partial. The key goes to a temporary file created mode 0600 in
/// the same directory, is flushed to disk, and is then hard-linked into place. `link` fails if the
/// destination exists, so two concurrent `init`s cannot both win, and a crash leaves either no key
/// or a whole one. `rename` would not do: it replaces an existing file.
pub fn init(path: &Path) -> Result<SecretKey> {
    if fs::symlink_metadata(path).is_ok() {
        bail!(
            "{} already exists; refusing to overwrite an endpoint key (delete it first if a new identity is really intended)",
            path.display()
        );
    }
    let dir = parent_dir(path);
    let key = SecretKey::generate();
    let tmp = temp_path(path);
    let result = write_new_private(&tmp, &encode(&key)).and_then(|()| {
        fs::hard_link(&tmp, path).with_context(|| {
            if fs::symlink_metadata(path).is_ok() {
                format!(
                    "{} appeared while writing; refusing to overwrite it",
                    path.display()
                )
            } else {
                format!("cannot place the key at {}", path.display())
            }
        })
    });
    let _ = fs::remove_file(&tmp);
    result?;
    sync_dir(&dir);
    Ok(key)
}

/// Loads the secret key at `path`.
///
/// On Unix the file must not be readable or writable by group or others, the same rule ssh applies
/// to private keys: a key other users can read is a key other users can impersonate the Node with.
pub fn load(path: &Path) -> Result<SecretKey> {
    let meta = fs::metadata(path).with_context(|| {
        format!(
            "cannot read the endpoint key at {} (create it once with `erainfra-mesh init --key {}`)",
            path.display(),
            path.display()
        )
    })?;
    if !meta.is_file() {
        bail!("{} is not a regular file", path.display());
    }
    check_private(path, &meta)?;
    let text = fs::read_to_string(path)
        .with_context(|| format!("cannot read the endpoint key at {}", path.display()))?;
    decode(text.trim()).with_context(|| format!("{} does not hold an endpoint key", path.display()))
}

fn encode(key: &SecretKey) -> Vec<u8> {
    let mut out = String::with_capacity(65);
    for byte in key.to_bytes() {
        out.push_str(&format!("{byte:02x}"));
    }
    out.push('\n');
    out.into_bytes()
}

fn decode(text: &str) -> Result<SecretKey> {
    if text.len() != 64 || !text.bytes().all(|b| b.is_ascii_hexdigit()) {
        bail!("expected 64 hex characters");
    }
    let mut bytes = [0u8; 32];
    for (i, chunk) in text.as_bytes().chunks(2).enumerate() {
        let pair = std::str::from_utf8(chunk).expect("ascii");
        bytes[i] = u8::from_str_radix(pair, 16).expect("validated hex");
    }
    Ok(SecretKey::from_bytes(&bytes))
}

fn parent_dir(path: &Path) -> PathBuf {
    match path.parent() {
        Some(p) if !p.as_os_str().is_empty() => p.to_path_buf(),
        _ => PathBuf::from("."),
    }
}

fn temp_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "key".into());
    parent_dir(path).join(format!(".{name}.tmp-{}", std::process::id()))
}

/// Creates `path` exclusively with owner-only permissions and writes `data` durably.
pub(crate) fn write_new_private(path: &Path, data: &[u8]) -> Result<()> {
    let mut opts = OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file: File = opts
        .open(path)
        .with_context(|| format!("cannot create {}", path.display()))?;
    file.write_all(data)?;
    file.sync_all()?;
    Ok(())
}

#[cfg(unix)]
pub(crate) fn sync_dir(dir: &Path) {
    if let Ok(d) = File::open(dir) {
        let _ = d.sync_all();
    }
}

#[cfg(not(unix))]
pub(crate) fn sync_dir(_dir: &Path) {}

#[cfg(unix)]
fn check_private(path: &Path, meta: &fs::Metadata) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mode = meta.permissions().mode() & 0o777;
    if mode & 0o077 != 0 {
        bail!(
            "{} has mode {:03o}; an endpoint key must be private to its owner (chmod 600)",
            path.display(),
            mode
        );
    }
    Ok(())
}

#[cfg(not(unix))]
fn check_private(_path: &Path, _meta: &fs::Metadata) -> Result<()> {
    // Windows has no mode bits; the key inherits the ACL of the directory the installer created.
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_through_hex() {
        let key = SecretKey::generate();
        let text = String::from_utf8(encode(&key)).unwrap();
        assert_eq!(decode(text.trim()).unwrap().public(), key.public());
    }

    #[test]
    fn rejects_malformed_text() {
        assert!(decode("abc").is_err());
        assert!(decode(&"g".repeat(64)).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn writes_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mesh.key");
        init(&path).unwrap();
        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        // No temporary file is left behind.
        let entries: Vec<_> = fs::read_dir(dir.path()).unwrap().collect();
        assert_eq!(entries.len(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_key_others_can_read() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mesh.key");
        init(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        let err = load(&path).unwrap_err().to_string();
        assert!(err.contains("chmod 600"), "{err}");
    }
}
