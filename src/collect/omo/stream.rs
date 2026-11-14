//! Passive public-host status transport. No attachment or content subscription.
//! All socket work is nonblocking and bounded per collection; failures discard
//! the entire live projection. A reconnect starts from a new snapshot.
use super::{Activity, ActivityState, OmoConfig};
#[cfg(target_os = "linux")]
use serde::Deserialize;
#[cfg(target_os = "linux")]
use std::collections::BTreeMap;

#[derive(Default)]
pub(super) struct Streams {
    #[cfg(target_os = "linux")]
    hosts: BTreeMap<String, linux::Host>,
}

impl Streams {
    pub(super) fn refresh(&mut self, config: &OmoConfig, owners: &[String]) {
        #[cfg(target_os = "linux")]
        {
            self.hosts
                .retain(|owner, _| owners.iter().take(8).any(|wanted| wanted == owner));
            for owner in owners.iter().take(8) {
                self.hosts
                    .entry(owner.clone())
                    .or_default()
                    .refresh(config, owner);
            }
        }
        #[cfg(not(target_os = "linux"))]
        let _ = (config, owners);
    }

    pub(super) fn apply(&self, activity: &mut Activity, eligible: Option<bool>) {
        if eligible.is_none() || activity.state == ActivityState::Conflict {
            return;
        }
        #[cfg(target_os = "linux")]
        let status = activity
            .coordinator
            .as_ref()
            .and_then(|owner| self.hosts.get(owner))
            .and_then(|host| host.connection.as_ref())
            .filter(|connection| connection.ready())
            .and_then(|connection| connection.statuses.get(activity.child_session.as_deref()?));
        #[cfg(not(target_os = "linux"))]
        let status: Option<&Status> = None;
        match status {
            Some(status)
                if status.kind == "worker"
                    && status.parent.as_deref() == activity.coordinator.as_deref() =>
            {
                activity.evidence.push(format!(
                    "verified passive worker session {} status {} observed {}; current attempt {}; task {}; session status is not completion or acceptance",
                    activity.child_session.as_deref().unwrap_or_default(), status.status,
                    status.observed, activity.attempt_id.as_deref().unwrap_or_default(),
                    activity.task_id.as_deref().unwrap_or_default()));
                if eligible == Some(false)
                    && matches!(status.status.as_str(), "running" | "compacting")
                    && matches!(
                        activity.state,
                        ActivityState::Finished
                            | ActivityState::AwaitingAcceptance
                            | ActivityState::Failed
                            | ActivityState::Cancelled
                    )
                {
                    activity.evidence.push("running session conflicts with terminal task evidence; task outcome retained and no liveness or acceptance inferred".into());
                }
                if eligible == Some(true)
                    && matches!(
                        activity.state,
                        ActivityState::Working | ActivityState::Unknown
                    )
                {
                    if matches!(status.status.as_str(), "running" | "compacting") {
                        activity.state = ActivityState::Working;
                        activity.fresh = Some(true);
                        activity.observed_at = Some(status.observed);
                        activity.evidence.push("authenticated current worker session supplies independent liveness for the matched running task; file timestamp is not a heartbeat".into());
                    } else {
                        activity.state = ActivityState::Unknown;
                        activity.fresh = Some(false);
                        activity.evidence.push("worker session is not running; task record alone cannot override this live observation".into());
                    }
                }
            }
            _ => {
                activity.evidence.push("passive worker status unavailable, disconnected, pending verification, or identity mismatch; no stream liveness; file evidence retained".into());
            }
        }
    }
}

struct Status {
    kind: String,
    status: String,
    parent: Option<String>,
    observed: chrono::DateTime<chrono::Utc>,
}

// Only these identity keys are deserialized from published context. In
// particular task_status, prompts, names, and other arbitrary text are ignored.
#[cfg(target_os = "linux")]
#[derive(Deserialize, Default)]
struct Context {
    parent_session_id: Option<String>,
}
#[cfg(target_os = "linux")]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireStatus {
    #[serde(rename = "type")]
    kind: String,
    subscription_id: String,
    seq: u64,
    session_id: String,
    durable_session_id: String,
    #[serde(rename = "kind")]
    session_kind: String,
    status: String,
    #[serde(default)]
    context: Context,
}

#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use hmac::{Hmac, KeyInit, Mac};
    use sha2::Sha256;
    use std::{
        fs,
        io::{Read, Write},
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::{
                fs::{MetadataExt, OpenOptionsExt},
                net::UnixStream,
            },
        },
        path::{Path, PathBuf},
        time::{Duration, Instant},
    };
    const FRAME: usize = 256 * 1024;
    const RECORDS: usize = 256;
    const DEADLINE: Duration = Duration::from_secs(30);

    #[derive(Default)]
    pub(super) struct Host {
        pub(super) connection: Option<Connection>,
        retry: Option<Instant>,
    }
    impl Host {
        pub(super) fn refresh(&mut self, config: &OmoConfig, owner: &str) {
            let now = Instant::now();
            if self.connection.as_ref().is_some_and(|c| now > c.expires) {
                self.connection = None;
                self.retry = None;
            }
            if self.connection.is_none() && self.retry.is_none_or(|at| now >= at) {
                self.retry = Some(now + Duration::from_secs(5));
                self.connection = discover(config, owner).ok();
            }
            if self
                .connection
                .as_mut()
                .is_some_and(|c| !c.registry_matches(config, owner) || c.advance().is_err())
            {
                self.connection = None;
                self.retry = Some(now + Duration::from_secs(5));
            }
        }
    }
    enum Phase {
        Protocol(String),
        Authenticate,
        Subscribe,
        Live,
    }
    pub(super) struct Connection {
        socket: UnixStream,
        endpoint: PathBuf,
        key_root: PathBuf,
        pid: u32,
        owner_pid: u32,
        owner_id: String,
        owner_start: u64,
        socket_identity: (u64, u64, i64, i64),
        expires: Instant,
        phase: Phase,
        input: Vec<u8>,
        output: Vec<u8>,
        sent: usize,
        deadline: Instant,
        subscription: String,
        seq: u64,
        pub(super) statuses: BTreeMap<String, Status>,
        routes: BTreeMap<String, String>,
    }
    impl Connection {
        fn registry_matches(&self, config: &OmoConfig, owner: &str) -> bool {
            select(config, owner).is_ok_and(|(root, meta, start)| {
                root == self.key_root
                    && meta.socket == self.endpoint
                    && meta.created_by_pid == self.owner_pid
                    && start == self.owner_start
                    && socket_identity(&meta.socket) == Ok(self.socket_identity)
            })
        }
        pub(super) fn ready(&self) -> bool {
            matches!(self.phase, Phase::Live)
        }
        fn send(&mut self, value: serde_json::Value) -> Result<(), ()> {
            if self.sent != self.output.len() {
                return Err(());
            }
            self.output = serde_json::to_vec(&value).map_err(|_| ())?;
            self.output.push(b'\n');
            self.sent = 0;
            self.deadline = Instant::now() + DEADLINE;
            Ok(())
        }
        fn advance(&mut self) -> Result<(), ()> {
            // Complete a responsive local handshake in this collection. Slow
            // peers get at most ten milliseconds; no background thread survives
            // the Reader and no connect/write/read can block on the peer.
            for _ in 0..5 {
                self.pump()?;
                if self.ready() {
                    return Ok(());
                }
                let mut fd = libc::pollfd {
                    fd: self.socket.as_raw_fd(),
                    events: libc::POLLIN,
                    revents: 0,
                };
                if unsafe { libc::poll(&mut fd, 1, 2) } < 0 {
                    return Err(());
                }
            }
            Ok(())
        }
        fn pump(&mut self) -> Result<(), ()> {
            if Instant::now() > self.expires || (!self.ready() && Instant::now() > self.deadline) {
                return Err(());
            }
            // Peer identity is checked before even the protocol probe leaves.
            let mut cred: libc::ucred = unsafe { std::mem::zeroed() };
            let mut len = std::mem::size_of_val(&cred) as libc::socklen_t;
            if unsafe {
                libc::getsockopt(
                    self.socket.as_raw_fd(),
                    libc::SOL_SOCKET,
                    libc::SO_PEERCRED,
                    (&mut cred as *mut libc::ucred).cast(),
                    &mut len,
                )
            } != 0
                || cred.uid != unsafe { libc::geteuid() }
                || cred.pid as u32 != self.pid
                || process(self.owner_pid).map(|(_, start)| start) != Ok(self.owner_start)
                || !descends(self.pid, self.owner_pid)
            {
                return Err(());
            }
            let mut budget = FRAME;
            for _ in 0..RECORDS {
                while self.sent < self.output.len() {
                    match self.socket.write(&self.output[self.sent..]) {
                        Ok(0) => return Err(()),
                        Ok(n) => self.sent += n,
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => return Ok(()),
                        Err(_) => return Err(()),
                    }
                }
                if let Some(end) = self.input.iter().position(|b| *b == b'\n') {
                    let line: Vec<_> = self.input.drain(..=end).collect();
                    self.record(&line)?;
                    continue;
                }
                if budget == 0 {
                    return Err(());
                }
                let mut bytes = [0; 8192];
                let cap = bytes.len().min(budget).min(FRAME - self.input.len());
                if cap == 0 {
                    return Err(());
                }
                match self.socket.read(&mut bytes[..cap]) {
                    Ok(0) => return Err(()),
                    Ok(n) => {
                        self.input.extend_from_slice(&bytes[..n]);
                        budget -= n;
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => return Ok(()),
                    Err(_) => return Err(()),
                }
            }
            // A peer flooding the connection must not retain an old live view.
            Err(())
        }
        fn record(&mut self, line: &[u8]) -> Result<(), ()> {
            #[derive(Deserialize)]
            struct Envelope<'a> {
                #[serde(rename = "type")]
                kind: &'a str,
                id: Option<&'a str>,
                success: Option<bool>,
                #[serde(borrow)]
                data: Option<&'a serde_json::value::RawValue>,
            }
            let envelope: Envelope<'_> = serde_json::from_slice(line).map_err(|_| ())?;
            if matches!(
                envelope.kind,
                "session_opened"
                    | "session_closed"
                    | "agent_start"
                    | "agent_settled"
                    | "agent_idle"
                    | "session_parked"
            ) {
                return Ok(());
            }
            if self.ready() {
                if envelope.kind != "session_status" {
                    return Err(());
                }
                let status: WireStatus = serde_json::from_slice(line).map_err(|_| ())?;
                if status.seq != self.seq.checked_add(1).ok_or(())? {
                    return Err(());
                }
                self.accept(status)?;
                self.seq += 1;
                return Ok(());
            }
            let expected = match self.phase {
                Phase::Protocol(_) => "protocol",
                Phase::Authenticate => "auth",
                Phase::Subscribe => "subscribe",
                Phase::Live => unreachable!(),
            };
            if envelope.kind != "response"
                || envelope.id != Some(expected)
                || envelope.success != Some(true)
            {
                return Err(());
            }
            match &self.phase {
                Phase::Protocol(nonce) => {
                    #[derive(Deserialize)]
                    struct Auth {
                        launch_id: String,
                        server_nonce: String,
                        server_proof: String,
                    }
                    #[derive(Deserialize)]
                    struct Protocol {
                        capabilities: Vec<String>,
                        auth: Auth,
                    }
                    let protocol: Protocol =
                        serde_json::from_str(envelope.data.ok_or(())?.get()).map_err(|_| ())?;
                    if !["socket_auth", "session_status", "observe_reads"]
                        .iter()
                        .all(|c| protocol.capabilities.iter().any(|v| v == c))
                    {
                        return Err(());
                    }
                    let auth = protocol.auth;
                    if !super::super::safe_id(&auth.launch_id) || auth.launch_id.len() > 64 {
                        return Err(());
                    }
                    let key = key(&self.key_root, &auth.launch_id, &self.endpoint, self.pid)?;
                    let proof = hex_decode(&auth.server_proof)?;
                    hex_decode(&auth.server_nonce)?;
                    let mut mac = Hmac::<Sha256>::new_from_slice(&key).map_err(|_| ())?;
                    mac.update(
                        format!(
                            "senpi-rpc-server\n{}\n{nonce}\n{}",
                            auth.launch_id, auth.server_nonce
                        )
                        .as_bytes(),
                    );
                    mac.verify_slice(&proof).map_err(|_| ())?;
                    let mut mac = Hmac::<Sha256>::new_from_slice(&key).map_err(|_| ())?;
                    mac.update(
                        format!(
                            "senpi-rpc-client\n{}\n{}\n{nonce}",
                            auth.launch_id, auth.server_nonce
                        )
                        .as_bytes(),
                    );
                    let proof = hex(&mac.finalize().into_bytes());
                    self.phase = Phase::Authenticate;
                    self.send(serde_json::json!({"id":"auth","type":"authenticate","client_proof":proof,"observe":true}))?;
                }
                Phase::Authenticate => {
                    self.phase = Phase::Subscribe;
                    self.send(serde_json::json!({"id":"subscribe","type":"subscribe_sessions","observe":true,"sessions":{"childrenOf":self.owner_id},"include_workers":true,"include_context":true,"mirror":"none","effects":false,"dialogs":false}))?;
                }
                Phase::Subscribe => {
                    #[derive(Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct Snapshot {
                        subscription_id: String,
                        seq: u64,
                        host_instance_id: String,
                        host_generation: String,
                        snapshot: Vec<WireStatus>,
                    }
                    let snapshot: Snapshot =
                        serde_json::from_str(envelope.data.ok_or(())?.get()).map_err(|_| ())?;
                    if snapshot.seq != 0
                        || snapshot.snapshot.len() > RECORDS
                        || !valid(&snapshot.subscription_id)
                        || !valid(&snapshot.host_instance_id)
                        || !valid(&snapshot.host_generation)
                    {
                        return Err(());
                    }
                    self.subscription = snapshot.subscription_id;
                    for status in snapshot.snapshot {
                        if status.seq != 0 {
                            return Err(());
                        }
                        self.accept(status)?;
                    }
                    self.expires = Instant::now() + Duration::from_secs(15);
                    self.phase = Phase::Live;
                }
                Phase::Live => unreachable!(),
            }
            Ok(())
        }
        fn accept(&mut self, status: WireStatus) -> Result<(), ()> {
            if status.kind != "session_status"
                || status.subscription_id != self.subscription
                || !valid(&status.session_id)
                || !valid(&status.durable_session_id)
                || !matches!(
                    status.status.as_str(),
                    "opening"
                        | "idle"
                        | "running"
                        | "waiting_input"
                        | "compacting"
                        | "unloaded"
                        | "closed"
                )
                || !matches!(status.session_kind.as_str(), "worker" | "interactive")
                || status
                    .context
                    .parent_session_id
                    .as_deref()
                    .is_some_and(|s| !valid(s))
            {
                return Err(());
            }
            // Routing handles can switch durable sessions. Remove their old
            // projection rather than leaving a replaced worker apparently live.
            self.routes_remove(&status.session_id);
            if self.statuses.len() >= RECORDS
                && !self.statuses.contains_key(&status.durable_session_id)
            {
                return Err(());
            }
            if self.statuses.contains_key(&status.durable_session_id) {
                return Err(());
            }
            self.routes
                .insert(status.session_id, status.durable_session_id.clone());
            self.statuses.insert(
                status.durable_session_id,
                Status {
                    kind: status.session_kind,
                    status: status.status,
                    parent: status.context.parent_session_id,
                    observed: chrono::Utc::now(),
                },
            );
            Ok(())
        }
        fn routes_remove(&mut self, route: &str) {
            if let Some(old) = self.routes.remove(route) {
                self.statuses.remove(&old);
            }
        }
    }
    fn valid(s: &str) -> bool {
        !s.is_empty() && s.len() <= 128 && super::super::safe_id(s)
    }
    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }
    fn hex_decode(s: &str) -> Result<Vec<u8>, ()> {
        if s.len() != 64
            || !s
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(());
        }
        (0..64)
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|_| ()))
            .collect()
    }
    fn private(path: &Path, directory: bool, mode: u32) -> Result<(), ()> {
        let meta = fs::symlink_metadata(path).map_err(|_| ())?;
        if meta.uid() != unsafe { libc::geteuid() }
            || meta.mode() & 0o7777 != mode
            || (if directory {
                !meta.is_dir()
            } else {
                !meta.is_file()
            })
        {
            return Err(());
        }
        Ok(())
    }
    fn small(path: &Path) -> Result<Vec<u8>, ()> {
        let mut file = fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(path)
            .map_err(|_| ())?;
        if !file.metadata().map_err(|_| ())?.is_file() {
            return Err(());
        }
        let mut bytes = Vec::new();
        Read::by_ref(&mut file)
            .take(16385)
            .read_to_end(&mut bytes)
            .map_err(|_| ())?;
        if bytes.len() > 16384 {
            return Err(());
        }
        Ok(bytes)
    }
    fn key(root: &Path, launch: &str, endpoint: &Path, pid: u32) -> Result<Vec<u8>, ()> {
        for path in [root.to_owned(), root.join("rpc")] {
            let m = fs::symlink_metadata(path).map_err(|_| ())?;
            if !m.is_dir() || m.uid() != unsafe { libc::geteuid() } || m.mode() & 0o022 != 0 {
                return Err(());
            }
        }
        private(&root.join("rpc/keys"), true, 0o700)?;
        let path = root.join("rpc/keys").join(launch);
        private(&path, false, 0o600)?;
        #[derive(Deserialize)]
        struct Key {
            version: u64,
            launch_id: String,
            key: String,
            pid: u32,
            endpoint: PathBuf,
            process_start: String,
        }
        let mut file = fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(&path)
            .map_err(|_| ())?;
        let meta = file.metadata().map_err(|_| ())?;
        if !meta.is_file()
            || meta.uid() != unsafe { libc::geteuid() }
            || meta.mode() & 0o7777 != 0o600
        {
            return Err(());
        }
        let mut bytes = Vec::new();
        Read::by_ref(&mut file)
            .take(16385)
            .read_to_end(&mut bytes)
            .map_err(|_| ())?;
        if bytes.len() > 16384 {
            return Err(());
        }
        let record: Key = serde_json::from_slice(&bytes).map_err(|_| ())?;
        if record.version != 1
            || record.launch_id != launch
            || record.process_start.split_whitespace().collect::<Vec<_>>()
                != process_start(record.pid)?
                    .split_whitespace()
                    .collect::<Vec<_>>()
            || !credential_endpoint(record.pid, &record.endpoint, pid, endpoint)
        {
            return Err(());
        }
        hex_decode(&record.key)
    }
    #[derive(Deserialize)]
    struct Meta {
        socket: PathBuf,
        kind: String,
        created_by_pid: u32,
        owner_session_id: String,
        owner_session_file: PathBuf,
        stores: Vec<PathBuf>,
        created_at: chrono::DateTime<chrono::Utc>,
    }
    fn select(config: &OmoConfig, owner: &str) -> Result<(PathBuf, Meta, u64), ()> {
        let directory = config.runtime_directory.as_ref().ok_or(())?;
        let rpc = directory
            .parent()
            .filter(|p| p.file_name().is_some_and(|n| n == "rpc"))
            .ok_or(())?;
        let root = rpc.parent().ok_or(())?;
        let store = config.task_directory.parent().ok_or(())?;
        let mut found = None;
        let mut budget = 512 * 1024usize;
        for (i, entry) in fs::read_dir(directory)
            .map_err(|_| ())?
            .take(513)
            .enumerate()
        {
            if i == 512 {
                return Err(());
            }
            let entry = entry.map_err(|_| ())?;
            let name = entry.file_name();
            let Some(stem) = name.to_str().and_then(|s| s.strip_suffix(".meta.json")) else {
                continue;
            };
            let Ok(bytes) = small(&entry.path()) else {
                continue;
            };
            budget = budget.checked_sub(bytes.len()).ok_or(())?;
            let Ok(meta) = serde_json::from_slice::<Meta>(&bytes) else {
                continue;
            };
            if meta.owner_session_id != owner
                || meta.kind != "p"
                || !meta.stores.iter().any(|s| s == store)
                || meta.socket != directory.join(format!("{stem}.sock"))
            {
                continue;
            }
            if found.is_some() {
                return Err(());
            }
            found = Some(meta);
        }
        let meta = found.ok_or(())?;
        let sessions = config.session_directory.as_ref().ok_or(())?;
        if meta.owner_session_file.parent() != Some(sessions.as_path())
            || !meta
                .owner_session_file
                .file_name()
                .and_then(|s| s.to_str())
                .is_some_and(|s| s.ends_with(&format!("_{owner}.jsonl")))
        {
            return Err(());
        }
        let mut file = fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(&meta.owner_session_file)
            .map_err(|_| ())?;
        if !file.metadata().map_err(|_| ())?.is_file() {
            return Err(());
        }
        let mut prefix = Vec::new();
        loop {
            let mut byte = [0u8; 1];
            if prefix.len() >= 8192 || file.read(&mut byte).map_err(|_| ())? != 1 {
                return Err(());
            }
            if byte[0] == b'\n' {
                break;
            }
            prefix.push(byte[0]);
        }
        let end = prefix.len();
        #[derive(Deserialize)]
        struct Header {
            #[serde(rename = "type")]
            kind: String,
            version: u64,
            id: String,
        }
        let header: Header = serde_json::from_slice(&prefix[..end]).map_err(|_| ())?;
        if header.kind != "session" || header.version != 3 || header.id != owner {
            return Err(());
        }

        let (_, owner_start) = process(meta.created_by_pid)?;
        let started = started_ms(owner_start)?;
        if meta.created_at.timestamp_millis() < started - 1000
            || meta.created_at > chrono::Utc::now() + chrono::TimeDelta::seconds(1)
        {
            return Err(());
        }
        socket_identity(&meta.socket)?;
        Ok((root.into(), meta, owner_start))
    }
    fn discover(config: &OmoConfig, owner: &str) -> Result<Connection, ()> {
        let (root, meta, owner_start) = select(config, owner)?;
        let socket = connect(&meta.socket)?;
        let mut cred: libc::ucred = unsafe { std::mem::zeroed() };
        let mut len = std::mem::size_of_val(&cred) as libc::socklen_t;
        if unsafe {
            libc::getsockopt(
                socket.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_PEERCRED,
                (&mut cred as *mut libc::ucred).cast(),
                &mut len,
            )
        } != 0
            || cred.uid != unsafe { libc::geteuid() }
            || !descends(cred.pid as u32, meta.created_by_pid)
        {
            return Err(());
        }

        let mut nonce = [0; 32];
        fs::File::open("/dev/urandom")
            .map_err(|_| ())?
            .read_exact(&mut nonce)
            .map_err(|_| ())?;
        let nonce = hex(&nonce);
        let mut connection = Connection {
            socket,
            endpoint: meta.socket.clone(),
            key_root: root,
            pid: cred.pid as u32,
            owner_pid: meta.created_by_pid,
            owner_id: owner.to_owned(),
            owner_start,
            socket_identity: socket_identity(&meta.socket)?,
            expires: Instant::now() + DEADLINE,
            phase: Phase::Protocol(nonce.clone()),
            input: Vec::new(),
            output: Vec::new(),
            sent: 0,
            deadline: Instant::now() + DEADLINE,
            subscription: String::new(),
            seq: 0,
            statuses: BTreeMap::new(),
            routes: BTreeMap::new(),
        };
        connection.send(serde_json::json!({"id":"protocol","type":"get_protocol_info","observe":true,"auth":{"client_nonce":nonce}}))?;
        Ok(connection)
    }
    fn process(pid: u32) -> Result<(u32, u64), ()> {
        let directory = PathBuf::from(format!("/proc/{pid}"));
        if fs::metadata(&directory).map_err(|_| ())?.uid() != unsafe { libc::geteuid() } {
            return Err(());
        }
        let bytes = fs::read(directory.join("stat")).map_err(|_| ())?;
        if bytes.len() > 8192 {
            return Err(());
        }
        let text = std::str::from_utf8(&bytes).map_err(|_| ())?;
        let fields: Vec<_> = text
            .rsplit_once(')')
            .ok_or(())?
            .1
            .split_whitespace()
            .collect();
        Ok((
            fields.get(1).ok_or(())?.parse().map_err(|_| ())?,
            fields.get(19).ok_or(())?.parse().map_err(|_| ())?,
        ))
    }
    fn descends(mut child: u32, owner: u32) -> bool {
        for _ in 0..8 {
            if child == owner {
                return process(owner).is_ok();
            }
            let Ok((parent, _)) = process(child) else {
                return false;
            };
            if parent == child || parent == 0 {
                return false;
            }
            child = parent;
        }
        false
    }
    fn started_ms(ticks: u64) -> Result<i64, ()> {
        let text = fs::read_to_string("/proc/stat").map_err(|_| ())?;
        let boot: i64 = text
            .lines()
            .find_map(|s| s.strip_prefix("btime "))
            .ok_or(())?
            .parse()
            .map_err(|_| ())?;
        let hz = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
        if hz <= 0 {
            return Err(());
        }
        Ok(boot * 1000 + (ticks / hz as u64 * 1000) as i64)
    }
    fn socket_identity(path: &Path) -> Result<(u64, u64, i64, i64), ()> {
        use std::os::unix::fs::FileTypeExt;
        let m = fs::metadata(path).map_err(|_| ())?;
        if !m.file_type().is_socket() || m.uid() != unsafe { libc::geteuid() } {
            return Err(());
        }
        Ok((m.dev(), m.ino(), m.ctime(), m.ctime_nsec()))
    }
    fn process_start(pid: u32) -> Result<String, ()> {
        use chrono::TimeZone;
        let (_, ticks) = process(pid)?;
        let date = chrono::Local
            .timestamp_millis_opt(started_ms(ticks)?)
            .single()
            .ok_or(())?;
        Ok(date.format("%a %b %e %H:%M:%S %Y").to_string())
    }
    fn credential_endpoint(key_pid: u32, key_endpoint: &Path, peer: u32, selected: &Path) -> bool {
        if key_pid == peer {
            return key_endpoint == selected;
        }
        // A supervisor proxies one immediate internal host. An arbitrary
        // descendant is insufficient: both command lines must bind the alias.
        process(key_pid).is_ok_and(|(parent, _)| parent == peer)
            && has_argument(peer, b"--internal-rpc-host-supervisor")
            && argument(peer, b"--socket", selected)
            && listens(key_pid, key_endpoint)
    }
    fn has_argument(pid: u32, expected: &[u8]) -> bool {
        fs::read(format!("/proc/{pid}/cmdline"))
            .is_ok_and(|b| b.len() <= 16384 && b.split(|c| *c == 0).any(|a| a == expected))
    }
    fn argument(pid: u32, flag: &[u8], value: &Path) -> bool {
        fs::read(format!("/proc/{pid}/cmdline")).is_ok_and(|b| {
            b.len() <= 16384
                && b.split(|c| *c == 0)
                    .collect::<Vec<_>>()
                    .windows(2)
                    .any(|a| a[0] == flag && a[1] == value.as_os_str().as_encoded_bytes())
        })
    }
    fn listens(pid: u32, endpoint: &Path) -> bool {
        let Ok(bytes) = fs::read(format!("/proc/{pid}/cmdline")) else {
            return false;
        };
        if bytes.len() > 16384 {
            return false;
        }
        let args: Vec<_> = bytes.split(|b| *b == 0).collect();
        let expected = format!("unix://{}", endpoint.display());
        args.windows(2).any(|a| {
            a[0] == b"--listen"
                && (a[1] == expected.as_bytes() || a[1] == endpoint.as_os_str().as_encoded_bytes())
        })
    }
    fn connect(path: &Path) -> Result<UnixStream, ()> {
        use std::os::unix::ffi::OsStrExt;
        let bytes = path.as_os_str().as_bytes();
        let mut address: libc::sockaddr_un = unsafe { std::mem::zeroed() };
        if bytes.contains(&0) || bytes.len() >= address.sun_path.len() {
            return Err(());
        }
        address.sun_family = libc::AF_UNIX as _;
        for (dest, byte) in address.sun_path.iter_mut().zip(bytes) {
            *dest = *byte as _;
        }
        let fd = unsafe {
            libc::socket(
                libc::AF_UNIX,
                libc::SOCK_STREAM | libc::SOCK_NONBLOCK | libc::SOCK_CLOEXEC,
                0,
            )
        };
        if fd < 0 {
            return Err(());
        }
        let stream = unsafe { UnixStream::from_raw_fd(fd) };
        if unsafe {
            libc::connect(
                fd,
                (&address as *const libc::sockaddr_un).cast(),
                std::mem::size_of_val(&address) as _,
            )
        } != 0
        {
            return Err(());
        }
        Ok(stream)
    }
    #[cfg(test)]
    mod tests {
        use super::*;
        use std::{
            io::{BufRead, BufReader},
            os::unix::fs::PermissionsExt,
            sync::atomic::{AtomicUsize, Ordering},
        };
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        struct Ground(PathBuf);
        impl Drop for Ground {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
        fn fixture() -> (Ground, Connection, UnixStream) {
            let root = Ground(std::env::temp_dir().join(format!(
                "bdi-status-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            )));
            fs::create_dir_all(root.0.join("rpc/keys")).unwrap();
            fs::set_permissions(root.0.join("rpc/keys"), fs::Permissions::from_mode(0o700))
                .unwrap();
            let (socket, peer) = UnixStream::pair().unwrap();
            socket.set_nonblocking(true).unwrap();
            peer.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
            let pid = std::process::id();
            let connection = Connection {
                socket,
                endpoint: root.0.join("rpc/shards/p-test.sock"),
                key_root: root.0.clone(),
                pid,
                owner_pid: pid,
                owner_id: "owner-1".into(),
                owner_start: process(pid).unwrap().1,
                socket_identity: (0, 0, 0, 0),
                expires: Instant::now() + DEADLINE,
                phase: Phase::Protocol("11".repeat(32)),
                input: Vec::new(),
                output: Vec::new(),
                sent: 0,
                deadline: Instant::now() + DEADLINE,
                subscription: String::new(),
                seq: 0,
                statuses: BTreeMap::new(),
                routes: BTreeMap::new(),
            };
            (root, connection, peer)
        }
        fn wire(seq: u64, child: &str) -> serde_json::Value {
            serde_json::json!({"type":"session_status","subscriptionId":"sub-1","seq":seq,"sessionId":"rpc-1","durableSessionId":child,"kind":"worker","status":"running","context":{"parent_session_id":"owner-1"}})
        }
        fn record(c: &mut Connection, value: serde_json::Value) -> Result<(), ()> {
            c.record(&serde_json::to_vec(&value).unwrap())
        }
        fn snapshot(c: &mut Connection) {
            c.phase = Phase::Subscribe;
            record(c,serde_json::json!({"type":"response","id":"subscribe","success":true,"data":{"subscriptionId":"sub-1","seq":0,"hostInstanceId":"instance-1","hostGeneration":"0","snapshot":[wire(0,"child-1")]}})).unwrap();
        }

        #[test]
        fn lifecycle_broadcasts_do_not_consume_status_sequence_and_silence_expires() {
            let (_root, mut c, _peer) = fixture();
            for kind in [
                "agent_start",
                "agent_settled",
                "agent_idle",
                "session_parked",
            ] {
                record(&mut c, serde_json::json!({"type":kind,"seq":999})).unwrap();
            }
            snapshot(&mut c);
            for kind in [
                "agent_start",
                "agent_settled",
                "agent_idle",
                "session_parked",
            ] {
                record(&mut c, serde_json::json!({"type":kind,"seq":999})).unwrap();
            }
            assert_eq!(c.seq, 0);
            record(&mut c, wire(1, "child-1")).unwrap();
            c.expires = Instant::now() - Duration::from_secs(1);
            assert!(c.pump().is_err());
        }
        #[test]
        fn persistent_connections_recheck_registry_owner_store_socket_and_ambiguity() {
            use std::os::unix::net::UnixListener;
            let (root, _unused, _peer) = fixture();
            let registry = root.0.join("rpc/shards");
            fs::create_dir_all(&registry).unwrap();
            let sessions = root.0.join("sessions");
            fs::create_dir_all(&sessions).unwrap();
            let session = sessions.join("invented_owner-1.jsonl");
            fs::write(
                &session,
                "{\"type\":\"session\",\"version\":3,\"id\":\"owner-1\"}\n",
            )
            .unwrap();
            let endpoint = registry.join("p-test.sock");
            let listener = UnixListener::bind(&endpoint).unwrap();
            let store = root.0.join("native");
            let config = OmoConfig {
                runtime_directory: Some(registry.clone()),
                session_directory: Some(sessions),
                task_directory: store.join("tasks"),
                ..Default::default()
            };
            let path = registry.join("p-test.meta.json");
            let meta = serde_json::json!({"socket":endpoint,"kind":"p","created_by_pid":std::process::id(),"owner_session_id":"owner-1","owner_session_file":session,"stores":[store],"created_at":chrono::Utc::now()});
            fs::write(&path, serde_json::to_vec(&meta).unwrap()).unwrap();
            let c = discover(&config, "owner-1").unwrap();
            assert!(c.registry_matches(&config, "owner-1"));
            for (field, value) in [
                ("owner_session_id", serde_json::json!("owner-2")),
                ("stores", serde_json::json!(["/invented/other"])),
                ("created_by_pid", serde_json::json!(0)),
            ] {
                let mut changed = meta.clone();
                changed[field] = value;
                fs::write(&path, serde_json::to_vec(&changed).unwrap()).unwrap();
                assert!(!c.registry_matches(&config, "owner-1"));
            }
            fs::write(&path, serde_json::to_vec(&meta).unwrap()).unwrap();
            let second = registry.join("p-second.sock");
            let _second = UnixListener::bind(&second).unwrap();
            let mut duplicate = meta.clone();
            duplicate["socket"] = serde_json::json!(second);
            let duplicate_path = registry.join("p-second.meta.json");
            fs::write(&duplicate_path, serde_json::to_vec(&duplicate).unwrap()).unwrap();
            assert!(!c.registry_matches(&config, "owner-1"));
            fs::remove_file(duplicate_path).unwrap();
            drop(listener);
            fs::remove_file(&endpoint).unwrap();
            let _replacement = UnixListener::bind(&endpoint).unwrap();
            assert!(!c.registry_matches(&config, "owner-1"));
        }
        #[test]
        fn credentials_require_exact_process_start_and_endpoint_alias() {
            let (root, c, _peer) = fixture();
            let launch = "test-launch";
            let path = root.0.join("rpc/keys").join(launch);
            let mut value = serde_json::json!({"version":1,"launch_id":launch,"key":"22".repeat(32),"pid":c.pid,"endpoint":c.endpoint,"process_start":process_start(c.pid).unwrap()});
            fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
            assert!(key(&root.0, launch, &c.endpoint, c.pid).is_ok());
            value["process_start"] = "invented wrong start".into();
            fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
            assert!(key(&root.0, launch, &c.endpoint, c.pid).is_err());
            assert!(!credential_endpoint(
                c.pid,
                &root.0.join("other.sock"),
                c.pid,
                &c.endpoint
            ));
            assert!(!credential_endpoint(
                c.pid,
                &c.endpoint,
                process(c.pid).unwrap().0,
                &c.endpoint
            ));
            let target = root.0.join("key-target");
            fs::rename(&path, &target).unwrap();
            std::os::unix::fs::symlink(target, &path).unwrap();
            assert!(key(&root.0, launch, &c.endpoint, c.pid).is_err());
        }
        #[test]
        fn authentication_proves_server_before_sending_client_proof_and_status_only_subscription() {
            let (root, mut c, mut peer) = fixture();
            let launch = "invented-launch";
            let path = root.0.join("rpc/keys").join(launch);
            fs::write(&path,serde_json::to_vec(&serde_json::json!({"version":1,"launch_id":launch,"key":"22".repeat(32),"pid":c.pid,"endpoint":c.endpoint,"process_start":process_start(c.pid).unwrap()})).unwrap()).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
            let mut mac = Hmac::<Sha256>::new_from_slice(&[0x22; 32]).unwrap();
            mac.update(
                format!(
                    "senpi-rpc-server\n{launch}\n{}\n{}",
                    "11".repeat(32),
                    "33".repeat(32)
                )
                .as_bytes(),
            );
            let challenge = serde_json::json!({"id":"protocol","type":"response","success":true,"data":{"capabilities":["socket_auth","session_status","observe_reads"],"auth":{"launch_id":launch,"server_nonce":"33".repeat(32),"server_proof":hex(&mac.finalize().into_bytes())}}});
            let mut forged = challenge.clone();
            forged["data"]["auth"]["server_proof"] = "00".repeat(32).into();
            assert!(record(&mut c, forged).is_err());
            assert!(c.output.is_empty());
            fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
            assert!(record(&mut c, challenge.clone()).is_err());
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
            peer.write_all(&serde_json::to_vec(&challenge).unwrap())
                .unwrap();
            peer.write_all(b"\n").unwrap();
            c.pump().unwrap();
            let mut reader = BufReader::new(peer);
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            let auth: serde_json::Value = serde_json::from_str(&line).unwrap();
            assert_eq!(auth["type"], "authenticate");
            assert_eq!(auth["observe"], true);
            reader
                .get_mut()
                .write_all(b"{\"id\":\"auth\",\"type\":\"response\",\"success\":true}\n")
                .unwrap();
            c.pump().unwrap();
            line.clear();
            reader.read_line(&mut line).unwrap();
            let subscribe: serde_json::Value = serde_json::from_str(&line).unwrap();
            assert_eq!(
                subscribe,
                serde_json::json!({"id":"subscribe","type":"subscribe_sessions","observe":true,"sessions":{"childrenOf":"owner-1"},"include_workers":true,"include_context":true,"mirror":"none","effects":false,"dialogs":false})
            );
            snapshot(&mut c);
            assert!(c.ready());
            assert_eq!(c.statuses.len(), 1);
        }
        #[test]
        fn unsafe_or_missing_credentials_and_bad_proofs_never_subscribe() {
            let (_root, mut c, _peer) = fixture();
            let challenge = serde_json::json!({"id":"protocol","type":"response","success":true,"data":{"capabilities":["socket_auth","session_status","observe_reads"],"auth":{"launch_id":"missing-launch","server_nonce":"33".repeat(32),"server_proof":"00".repeat(32)}}});
            assert!(record(&mut c, challenge).is_err());
            assert!(c.output.is_empty());
            assert!(key(&c.key_root, "missing-launch", &c.endpoint, c.pid).is_err());
            assert!(hex_decode(&"AA".repeat(32)).is_err());
        }
        #[test]
        fn contiguous_deltas_replace_routes_and_gaps_duplicates_foreign_subscriptions_fail() {
            let (_root, mut c, _peer) = fixture();
            snapshot(&mut c);
            record(&mut c, wire(1, "child-2")).unwrap();
            assert!(!c.statuses.contains_key("child-1"));
            assert!(c.statuses.contains_key("child-2"));
            assert!(record(&mut c, wire(1, "child-2")).is_err());
            assert!(record(&mut c, wire(3, "child-2")).is_err());
            let mut foreign = wire(2, "child-2");
            foreign["subscriptionId"] = "other".into();
            assert!(record(&mut c, foreign).is_err());
            assert!(record(
                &mut c,
                serde_json::json!({"type":"message_update","private":"invented"})
            )
            .is_err());
        }
        #[test]
        fn oversized_frames_disconnects_and_timeouts_discard_live_projection() {
            let (_root, mut c, _peer) = fixture();
            snapshot(&mut c);
            c.input = vec![b'x'; FRAME];
            assert!(c.pump().is_err());
            let (_root, mut c, peer) = fixture();
            snapshot(&mut c);
            drop(peer);
            let mut host = Host {
                connection: Some(c),
                retry: None,
            };
            host.refresh(&OmoConfig::default(), "owner-1");
            assert!(host.connection.is_none());
            let (_root, mut c, _peer) = fixture();
            c.deadline = Instant::now() - Duration::from_secs(1);
            assert!(c.pump().is_err());
        }
        #[test]
        fn live_running_recovers_only_verified_running_tasks_and_disconnect_restores_file_baseline()
        {
            let (_root, mut c, _peer) = fixture();
            snapshot(&mut c);
            let mut streams = Streams::default();
            streams.hosts.insert(
                "owner-1".into(),
                Host {
                    connection: Some(c),
                    retry: None,
                },
            );
            let mut activity =
                super::super::super::empty_activity(&super::super::super::BeadInput {
                    project: "ferry".into(),
                    bead_id: "fer-1".into(),
                    fields: serde_json::Value::Null,
                    bead_status: None,
                });
            activity.attempt_id = Some("attempt-1".into());
            activity.task_id = Some("task-1".into());
            activity.child_session = Some("child-1".into());
            activity.coordinator = Some("owner-1".into());
            activity.fresh = Some(false);
            let baseline = activity.clone();
            streams.apply(&mut activity, Some(true));
            assert_eq!(activity.state, ActivityState::Working);
            assert_eq!(activity.fresh, Some(true));
            assert!(!activity.acceptance_ready);
            for state in [
                ActivityState::Finished,
                ActivityState::Failed,
                ActivityState::Cancelled,
                ActivityState::Conflict,
            ] {
                let mut terminal = baseline.clone();
                terminal.state = state;
                streams.apply(&mut terminal, Some(false));
                assert_eq!(terminal.state, state);
            }
            let mut missing = baseline.clone();
            streams.apply(&mut missing, None);
            assert_eq!(missing.state, ActivityState::Unknown);
            streams.hosts.clear();
            let mut disconnected = baseline.clone();
            streams.apply(&mut disconnected, Some(true));
            assert_eq!(disconnected.state, ActivityState::Unknown);
            let mut fresh = baseline;
            fresh.state = ActivityState::Working;
            fresh.fresh = Some(true);
            streams.apply(&mut fresh, Some(true));
            assert_eq!(fresh.state, ActivityState::Working);
        }
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    #[test]
    fn published_context_discards_everything_except_parent_identity() {
        let status: WireStatus = serde_json::from_value(serde_json::json!({
            "type":"session_status", "subscriptionId":"sub-1", "seq":1,
            "sessionId":"rpc-1", "durableSessionId":"child-1", "kind":"worker",
            "status":"running", "context":{"parent_session_id":"owner-1", "private_text":{"nested":["invented secret"]}}
        })).unwrap();
        assert_eq!(status.context.parent_session_id.as_deref(), Some("owner-1"));
    }
}
