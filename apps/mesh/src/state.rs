//! The desired configuration, optionally persisted under `--state`.
//!
//! With a state directory the daemon comes back after a restart with the fleet, relays, exposures
//! and links it last had, so a Node keeps serving before the agent has re-sent anything. Without
//! one it starts empty and waits for the agent. Either way the agent's next `set_*` call is the
//! source of truth.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::api::PeerSpec;
use crate::key::{sync_dir, write_new_private};

#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RelaysSpec {
    pub relays: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_token: Option<String>,
    #[serde(default)]
    pub n0_fallback: bool,
}

// Hand-written so the relay token can never reach a log line through `{:?}`.
impl std::fmt::Debug for RelaysSpec {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RelaysSpec")
            .field("relays", &self.relays)
            .field(
                "auth_token",
                &self.auth_token.as_ref().map(|_| "<redacted>"),
            )
            .field("n0_fallback", &self.n0_fallback)
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExposeSpec {
    pub target: String,
    pub max_connections: u32,
    /// Earlier, undeployed v1 state has no grants. Loading it must deny everyone, not
    /// recreate all-fleet access or infer authorization from saved links.
    #[serde(default)]
    pub allowed_peers: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LinkSpec {
    pub peer: String,
    pub service: String,
    pub listen: String,
    pub max_connections: u32,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Desired {
    #[serde(default)]
    pub fleet: Vec<PeerSpec>,
    #[serde(default)]
    pub relays: RelaysSpec,
    #[serde(default)]
    pub exposures: BTreeMap<String, ExposeSpec>,
    #[serde(default)]
    pub links: BTreeMap<String, LinkSpec>,
}

#[derive(Debug, Clone)]
pub struct Store {
    path: PathBuf,
}

impl Store {
    pub fn new(dir: &Path) -> Result<Self> {
        fs::create_dir_all(dir).with_context(|| format!("cannot create {}", dir.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            // The file holds the relay token, so the directory is owner-only too.
            fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
                .with_context(|| format!("cannot restrict {}", dir.display()))?;
        }
        Ok(Self {
            path: dir.join("state.json"),
        })
    }

    /// Loads the saved configuration. A missing file is an empty configuration; an unreadable one
    /// is reported and treated as empty, because the agent re-sends everything anyway and a Node
    /// that refuses to start over a bad cache file helps nobody.
    pub fn load(&self) -> Desired {
        match fs::read(&self.path) {
            Ok(bytes) => match serde_json::from_slice(&bytes) {
                Ok(d) => d,
                Err(e) => {
                    tracing::warn!(path = %self.path.display(), error = %e, "ignoring an unreadable state file");
                    Desired::default()
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Desired::default(),
            Err(e) => {
                tracing::warn!(path = %self.path.display(), error = %e, "ignoring an unreadable state file");
                Desired::default()
            }
        }
    }

    /// Saves atomically: a new owner-only file, then a rename over the old one.
    pub fn save(&self, desired: &Desired) -> Result<()> {
        let tmp = self.path.with_extension("json.tmp");
        let _ = fs::remove_file(&tmp);
        let data = serde_json::to_vec_pretty(desired)?;
        write_new_private(&tmp, &data)?;
        fs::rename(&tmp, &self.path)
            .with_context(|| format!("cannot replace {}", self.path.display()))?;
        if let Some(dir) = self.path.parent() {
            sync_dir(dir);
        }
        Ok(())
    }
}
