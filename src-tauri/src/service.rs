//! Per-user resident service. The desktop is only a client of this supervisor.
use fs2::FileExt;
use serde::{Deserialize, Serialize};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::{
    env,
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};

const LABEL: &str = "app.tasknboard.service";
type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

pub struct Paths {
    pub data: PathBuf,
    pub resources: PathBuf,
    pub executable: PathBuf,
    pub home: PathBuf,
}
impl Paths {
    pub fn current() -> Result<Self> {
        let executable = dunce::simplified(&env::current_exe()?).to_path_buf();
        let home = PathBuf::from(
            env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                .ok_or("User home is unavailable")?,
        );
        let data = if cfg!(windows) {
            PathBuf::from(env::var_os("APPDATA").ok_or("APPDATA is unavailable")?)
                .join("app.tasknboard.desktop")
        } else {
            home.join("Library/Application Support/app.tasknboard.desktop")
        };
        let resources = if cfg!(debug_assertions) {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources")
        } else if cfg!(windows) {
            executable
                .parent()
                .ok_or("Executable directory is unavailable")?
                .join("resources")
        } else {
            executable
                .parent()
                .and_then(Path::parent)
                .ok_or("Bundle directory is unavailable")?
                .join("Resources/resources")
        };
        Ok(Self {
            data,
            resources: dunce::simplified(&resources).to_path_buf(),
            executable,
            home,
        })
    }
    fn runtime(&self) -> PathBuf {
        self.data.join("runtime.json")
    }
    fn stop_file(&self) -> PathBuf {
        self.data.join("service-stop")
    }
    fn lock(&self) -> Result<File> {
        fs::create_dir_all(&self.data)?;
        Ok(OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(self.data.join("service.lock"))?)
    }
}

pub fn credential() -> Result<String> {
    let entry = keyring::Entry::new("app.tasknboard.desktop", "local-service")?;
    match entry.get_password() {
        Ok(secret) if !secret.is_empty() => Ok(secret),
        Ok(_) => Err("The local service credential is empty".into()),
        Err(keyring::Error::NoEntry) => {
            // Two random UUIDs provide 244 random bits, without a plaintext file.
            let secret = format!(
                "{}{}",
                uuid::Uuid::new_v4().simple(),
                uuid::Uuid::new_v4().simple()
            );
            entry.set_password(&secret)?;
            Ok(secret)
        }
        Err(error) => Err(error.into()),
    }
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Runtime {
    pub url: String,
    pub mcp_url: String,
    pub instance_id: String,
    pub pid: u32,
}
pub(crate) fn read_runtime(paths: &Paths) -> Result<Runtime> {
    let runtime: Runtime = serde_json::from_slice(&fs::read(paths.runtime())?)?;
    let url: tauri::Url = runtime.url.parse()?;
    let mcp: tauri::Url = runtime.mcp_url.parse()?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none()
        || mcp.origin() != url.origin()
        || runtime.pid == 0
        || runtime.instance_id.is_empty()
    {
        return Err("Invalid resident service descriptor".into());
    }
    Ok(runtime)
}

fn running(paths: &Paths) -> Result<bool> {
    let lock = paths.lock()?;
    match lock.try_lock_exclusive() {
        Ok(()) => Ok(false),
        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => Ok(true),
        Err(error) => Err(error.into()),
    }
}

fn status(paths: &Paths) -> Result<serde_json::Value> {
    let active = running(paths)?;
    let runtime = if active {
        read_runtime(paths).ok()
    } else {
        None
    };
    Ok(serde_json::json!({
        "running": active,
        "runtime": runtime,
        "runtimeFile": paths.runtime(),
        "native": { "available": true }
    }))
}
fn hidden(command: &mut Command) {
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    #[cfg(not(windows))]
    let _ = command;
}
struct ManagedChild {
    child: Child,
}
impl std::ops::Deref for ManagedChild {
    type Target = Child;
    fn deref(&self) -> &Child {
        &self.child
    }
}
impl std::ops::DerefMut for ManagedChild {
    fn deref_mut(&mut self) -> &mut Child {
        &mut self.child
    }
}
impl Drop for ManagedChild {
    fn drop(&mut self) {
        stop_child(&mut self.child);
    }
}
fn launch_node(paths: &Paths, secret: &str) -> Result<ManagedChild> {
    let user_env: std::collections::BTreeMap<String, String> = env::vars()
        .filter(|(key, _)| !key.starts_with("TASKNBOARD_"))
        .collect();
    let mut command =
        Command::new(
            paths
                .resources
                .join(if cfg!(windows) { "node.exe" } else { "node" }),
        );
    hidden(&mut command);
    command
        .arg(paths.resources.join("server.mjs"))
        .current_dir(&paths.data)
        .env_clear()
        .env("HOST", "127.0.0.1")
        .env(
            "PORT",
            env::var("TASKNBOARD_SERVICE_PORT").unwrap_or_else(|_| "0".into()),
        )
        .env("TASKNBOARD_RESIDENT", "1")
        .env("TASKNBOARD_DESKTOP", "1")
        .env("TASKNBOARD_LOCAL_SECRET", secret)
        .env("TASKNBOARD_RUNTIME_FILE", paths.runtime())
        .env("TASKNBOARD_STOP_FILE", paths.data.join("node-stop"))
        .env("TASKNBOARD_SUPERVISOR_PID", std::process::id().to_string())
        .env("TASKNBOARD_CREDENTIAL_HELPER", &paths.executable)
        .env("TASKNBOARD_USER_HOME", &paths.home)
        .env("TASKNBOARD_RESOURCES", &paths.resources)
        .env("TASKNBOARD_DB", paths.data.join("tasknboard.sqlite"))
        .env("TASKNBOARD_STATIC_DIR", paths.resources.join("dist"))
        .env("TASKNBOARD_USER_ENV", serde_json::to_string(&user_env)?)
        .env("PATH", env::var_os("PATH").unwrap_or_default())
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit());
    if let Some(client_id) = env::var("TASKNBOARD_GITHUB_CLIENT_ID")
        .ok()
        .or_else(|| option_env!("TASKNBOARD_GITHUB_CLIENT_ID").map(str::to_owned))
    {
        command.env("TASKNBOARD_GITHUB_CLIENT_ID", client_id);
    }
    for name in [
        "HOME",
        "USER",
        "LOGNAME",
        "SystemRoot",
        "WINDIR",
        "TEMP",
        "TMP",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
    ] {
        if let Some(value) = env::var_os(name) {
            command.env(name, value);
        }
    }
    Ok(ManagedChild {
        child: command.spawn()?,
    })
}
fn stop_child(child: &mut Child) {
    // EOF gives Node a graceful shutdown.
    drop(child.stdin.take());
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if !matches!(child.try_wait(), Ok(None)) {
            return;
        }
        thread::sleep(Duration::from_millis(50));
    }
    let _ = child.kill();
    let _ = child.wait();
}

const CONTROL_GRACE: Duration = Duration::from_millis(750);
fn control_ready(path: &Path) -> bool {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.elapsed().ok())
        .is_some_and(|age| age >= CONTROL_GRACE)
}
pub fn supervise(paths: &Paths) -> Result<()> {
    let lock = paths.lock()?;
    match lock.try_lock_exclusive() {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => return Ok(()),
        Err(error) => return Err(error.into()),
    }
    // Native credentials are created only while holding the singleton lock.
    let secret = credential()?;
    let stop = Arc::new(AtomicBool::new(false));
    let signal = Arc::clone(&stop);
    ctrlc::set_handler(move || signal.store(true, Ordering::SeqCst))?;
    #[cfg(windows)]
    let _job = windows_job()?;
    let _ = fs::remove_file(paths.stop_file());
    let _ = fs::remove_file(paths.runtime());
    let mut disabled = false;
    while !stop.load(Ordering::SeqCst) {
        let mut node = launch_node(paths, &secret)?;
        loop {
            if stop.load(Ordering::SeqCst) || control_ready(&paths.stop_file()) {
                disabled = fs::read(paths.stop_file()).ok().as_deref() == Some(b"disable");
                stop.store(true, Ordering::SeqCst);
                break;
            }
            if control_ready(&paths.data.join("service-restart")) {
                fs::remove_file(paths.data.join("service-restart"))?;
                break;
            }
            if node.try_wait()?.is_some() {
                break;
            }
            thread::sleep(Duration::from_millis(200));
        }
        drop(node.stdin.take());
        drop(node);
        let _ = fs::remove_file(paths.runtime());
        if !stop.load(Ordering::SeqCst) {
            thread::sleep(Duration::from_secs(2));
        }
    }
    let _ = fs::remove_file(paths.stop_file());
    #[cfg(target_os = "macos")]
    if disabled {
        // Persistent registration was removed before the acknowledgement.
        // Remove the loaded job only after the Node child stops.
        let _ = Command::new("/bin/launchctl")
            .args(["bootout", &format!("{}/{LABEL}", launch_domain()?)])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(target_os = "macos"))]
    let _ = disabled;
    Ok(())
}

#[cfg(windows)]
fn windows_job() -> Result<WindowsJob> {
    use windows_sys::Win32::System::{JobObjects::*, Threading::GetCurrentProcess};
    unsafe {
        let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if handle.is_null() {
            return Err(std::io::Error::last_os_error().into());
        }
        let job = WindowsJob(handle);
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(
            handle,
            JobObjectExtendedLimitInformation,
            &info as *const _ as _,
            std::mem::size_of_val(&info) as u32,
        ) == 0
            || AssignProcessToJobObject(handle, GetCurrentProcess()) == 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(job)
    }
}
#[cfg(windows)]
struct WindowsJob(windows_sys::Win32::Foundation::HANDLE);
#[cfg(windows)]
impl Drop for WindowsJob {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

fn xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}
fn run_command(command: &mut Command) -> Result<()> {
    hidden(command);
    let output = command.output()?;
    if !output.status.success() {
        return Err(format!(
            "Service manager failed: {}",
            String::from_utf8_lossy(&output.stderr)
        )
        .into());
    }
    Ok(())
}
#[cfg(target_os = "macos")]
fn launch_domain() -> Result<String> {
    let output = Command::new("/usr/bin/id").arg("-u").output()?;
    if !output.status.success() {
        return Err("Could not read the current user ID".into());
    }
    Ok(format!("gui/{}", String::from_utf8(output.stdout)?.trim()))
}
#[cfg(windows)]
fn task_name() -> String {
    format!(
        "TasknBoard Service {}",
        env::var("USERNAME").unwrap_or_default()
    )
}

pub fn install(paths: &Paths) -> Result<()> {
    fs::create_dir_all(&paths.data)?;
    #[cfg(target_os = "macos")]
    {
        let directory = paths.home.join("Library/LaunchAgents");
        fs::create_dir_all(&directory)?;
        let file = directory.join(format!("{LABEL}.plist"));
        let contents = format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?><!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\"><plist version=\"1.0\"><dict><key>Label</key><string>{LABEL}</string><key>ProgramArguments</key><array><string>{}</string><string>--service</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ProcessType</key><string>Background</string><key>StandardErrorPath</key><string>{}</string><key>EnvironmentVariables</key><dict><key>PATH</key><string>{}</string><key>HOME</key><string>{}</string></dict></dict></plist>", xml(&paths.executable.to_string_lossy()), xml(&paths.data.join("service.log").to_string_lossy()), xml(&env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin:/usr/sbin:/sbin".into())), xml(&paths.home.to_string_lossy()));
        let domain = launch_domain()?;
        if fs::read_to_string(&file).ok().as_deref() != Some(&contents) {
            stop_managed(paths)?;
            fs::write(&file, contents)?;
        }
        let target = format!("{domain}/{LABEL}");
        run_command(Command::new("/bin/launchctl").args(["enable", &target]))?;
        if !Command::new("/bin/launchctl")
            .args(["print", &target])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()?
            .success()
        {
            run_command(
                Command::new("/bin/launchctl")
                    .arg("bootstrap")
                    .arg(&domain)
                    .arg(&file),
            )?;
        }
        run_command(Command::new("/bin/launchctl").args(["kickstart", &target]))?;
    }
    #[cfg(windows)]
    {
        let name = task_name();
        let account = format!("{}\\{}", env::var("USERDOMAIN")?, env::var("USERNAME")?);
        let contents = format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Task version=\"1.2\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\"><Triggers><LogonTrigger><Enabled>true</Enabled><UserId>{}</UserId></LogonTrigger></Triggers><Principals><Principal id=\"User\"><UserId>{}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings><Actions Context=\"User\"><Exec><Command>{}</Command><Arguments>--service</Arguments></Exec></Actions></Task>", xml(&account), xml(&account), xml(&paths.executable.to_string_lossy()));
        let file = paths.data.join("service-task.xml");
        if fs::read_to_string(&file).ok().as_deref() != Some(&contents) {
            stop_managed(paths)?;
            fs::write(&file, contents)?;
            run_command(
                Command::new("schtasks.exe")
                    .args(["/Create", "/TN", &name, "/XML"])
                    .arg(&file)
                    .arg("/F"),
            )?;
        }
        run_command(Command::new("schtasks.exe").args(["/Change", "/TN", &name, "/ENABLE"]))?;
        run_command(Command::new("schtasks.exe").args(["/Run", "/TN", &name]))?;
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    return Err("Resident services support macOS and Windows".into());
    Ok(())
}

pub fn stop_managed(paths: &Paths) -> Result<()> {
    fs::create_dir_all(&paths.data)?;
    #[cfg(windows)]
    {
        let _ = Command::new("schtasks.exe")
            .args(["/Change", "/TN", &task_name(), "/DISABLE"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()?;
    }
    if running(paths)? {
        fs::write(paths.stop_file(), b"stop")?;
        let deadline = Instant::now() + Duration::from_secs(15);
        while running(paths)? {
            if Instant::now() >= deadline {
                return Err("Resident service did not stop within 15 seconds".into());
            }
            thread::sleep(Duration::from_millis(100));
        }
    }
    #[cfg(target_os = "macos")]
    {
        let _ = Command::new("/bin/launchctl")
            .args(["bootout", &format!("{}/{LABEL}", launch_domain()?)])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()?;
    }
    Ok(())
}
fn unregister(paths: &Paths) -> Result<()> {
    // Unregister first: this helper can be a descendant of the Windows service job.
    #[cfg(target_os = "macos")]
    {
        let file = paths
            .home
            .join(format!("Library/LaunchAgents/{LABEL}.plist"));
        if file.exists() {
            fs::remove_file(file)?;
        }
    }
    #[cfg(windows)]
    {
        run_command(Command::new("schtasks.exe").args(["/Delete", "/TN", &task_name(), "/F"]))?;
        let _ = fs::remove_file(paths.data.join("service-task.xml"));
    }
    Ok(())
}
pub fn uninstall(paths: &Paths) -> Result<()> {
    unregister(paths)?;
    stop_managed(paths)
}
fn disable(paths: &Paths) -> Result<()> {
    #[cfg(target_os = "macos")]
    run_command(
        Command::new("/bin/launchctl").args(["disable", &format!("{}/{LABEL}", launch_domain()?)]),
    )?;
    unregister(paths)?;
    fs::create_dir_all(&paths.data)?;
    fs::write(paths.stop_file(), b"disable")?;
    Ok(())
}
pub fn attach(paths: &Paths) -> Result<Runtime> {
    // Attaching must not rewrite registration from a client's different PATH.
    // Explicit installation updates the executable and persistent registration.
    if !running(paths)? {
        install(paths)?;
    }
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if running(paths)? {
            if let Ok(runtime) = read_runtime(paths) {
                return Ok(runtime);
            }
        }
        if Instant::now() >= deadline {
            return Err("Resident service did not start within 30 seconds. Check service.log and the native credential store.".into());
        }
        thread::sleep(Duration::from_millis(100));
    }
}

fn input<T: serde::de::DeserializeOwned>() -> Result<T> {
    use std::io::Read;
    let mut bytes = Vec::new();
    std::io::stdin()
        .take(16 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 16 * 1024 * 1024 {
        return Err("Native helper input exceeds 16 MB".into());
    }
    Ok(serde_json::from_slice(&bytes)?)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Export {
    name: String,
    mime: String,
    data: String,
}
fn export() -> Result<()> {
    use base64::Engine;
    let file: Export = input()?;
    let name = Path::new(&file.name)
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("Invalid export filename")?;
    if !matches!(
        file.mime.as_str(),
        "application/json" | "text/plain" | "text/markdown" | "text/csv"
    ) {
        return Err("Unsupported export content type".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(file.data)?;
    let destination = rfd::FileDialog::new()
        .set_title("Save TasknBoard export")
        .set_file_name(name)
        .save_file();
    if let Some(path) = destination.as_ref() {
        fs::write(path, bytes)?;
    }
    println!("{}", serde_json::json!({"saved": destination.is_some()}));
    Ok(())
}
pub fn cli() -> bool {
    let args: Vec<String> = env::args().skip(1).collect();
    let Some(flag) = args.first() else {
        return false;
    };
    if !matches!(
        flag.as_str(),
        "--service"
            | "--service-install"
            | "--service-uninstall"
            | "--service-status"
            | "--service-credential"
            | "--service-attach"
            | "--service-control"
            | "--service-export"
            | "--service-pick-folder"
    ) {
        return false;
    }
    let result = (|| -> Result<()> {
        if args.len() != 1 {
            return Err("Service commands do not accept arguments".into());
        }
        let paths = Paths::current()?;
        match flag.as_str() {
            "--service" => supervise(&paths)?,
            "--service-install" => {
                install(&paths)?;
            }
            "--service-uninstall" => uninstall(&paths)?,
            "--service-status" => println!("{}", status(&paths)?),
            "--service-attach" => println!("{}", serde_json::to_string(&attach(&paths)?)?),
            "--service-export" => export()?,
            "--service-pick-folder" => {
                let path = rfd::FileDialog::new()
                    .set_title("Choose the repository folder")
                    .pick_folder();
                println!(
                    "{}",
                    serde_json::json!({"path": path.map(|path| dunce::simplified(&path).to_string_lossy().into_owned())})
                );
            }
            "--service-control" => {
                #[derive(Deserialize)]
                struct Control {
                    action: String,
                }
                match input::<Control>()?.action.as_str() {
                    "start" => install(&paths)?,
                    "stop" => stop_managed(&paths)?,
                    "disable" => disable(&paths)?,
                    "restart" => {
                        if running(&paths)? {
                            fs::write(paths.data.join("service-restart"), b"restart")?;
                        } else {
                            install(&paths)?;
                        }
                    }
                    _ => return Err("Unknown service action".into()),
                }
                println!("{}", status(&paths)?);
            }
            "--service-credential" => {
                // Credential helper never creates a credential outside the supervisor lock.
                println!(
                    "{}",
                    keyring::Entry::new("app.tasknboard.desktop", "local-service")?
                        .get_password()?
                );
            }
            _ => unreachable!(),
        }
        Ok(())
    })();
    if let Err(error) = result {
        eprintln!("TasknBoard: {error}");
        std::process::exit(1);
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn xml_escapes_paths_and_accounts() {
        assert_eq!(xml("a&<b>\"'"), "a&amp;&lt;b&gt;&quot;&apos;");
    }
    #[test]
    fn control_marker_waits_for_the_acknowledgement_grace() {
        let file = env::temp_dir().join(format!("tasknboard-control-{}", uuid::Uuid::new_v4()));
        assert!(!control_ready(&file));
        fs::write(&file, b"disable").unwrap();
        assert!(!control_ready(&file));
        thread::sleep(CONTROL_GRACE + Duration::from_millis(50));
        assert!(control_ready(&file));
        fs::remove_file(file).unwrap();
    }
    #[test]
    fn singleton_lock_rejects_a_second_supervisor() {
        let data = env::temp_dir().join(format!("tasknboard-lock-{}", uuid::Uuid::new_v4()));
        let paths = Paths {
            data: data.clone(),
            resources: data.clone(),
            executable: data.clone(),
            home: data.clone(),
        };
        let first = paths.lock().unwrap();
        first.try_lock_exclusive().unwrap();
        assert!(running(&paths).unwrap());
        // A concurrent test can fork before close-on-exec releases its copy.
        FileExt::unlock(&first).unwrap();
        drop(first);
        assert!(!running(&paths).unwrap());
        fs::remove_dir_all(data).unwrap();
    }
    #[test]
    fn status_reports_only_the_resident_service() {
        let data = env::temp_dir().join(format!("tasknboard-status-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&data).unwrap();
        let paths = Paths {
            data: data.clone(),
            resources: data.clone(),
            executable: data.clone(),
            home: data.clone(),
        };
        // Old connection files must not affect local service discovery.
        fs::write(data.join("connection.json"), b"obsolete connection").unwrap();
        let value = status(&paths).unwrap();
        assert_eq!(value["running"], false);
        assert!(value["runtime"].is_null());
        assert_eq!(value["native"]["available"], true);
        assert!(value.get("tunnel").is_none());
        assert!(value.get("pluginConnectionId").is_none());
        let lock = paths.lock().unwrap();
        lock.try_lock_exclusive().unwrap();
        let runtime = serde_json::json!({
            "url": "http://127.0.0.1:1234",
            "mcpUrl": "http://127.0.0.1:1234/mcp",
            "instanceId": "status-test",
            "pid": 1
        });
        fs::write(paths.runtime(), runtime.to_string()).unwrap();
        let active = status(&paths).unwrap();
        assert_eq!(active["running"], true);
        assert_eq!(active["runtime"], runtime);
        drop(lock);
        fs::remove_dir_all(data).unwrap();
    }
    #[test]
    fn attach_reuses_the_running_resident_without_registration() {
        let data = env::temp_dir().join(format!("tasknboard-attach-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&data).unwrap();
        let paths = Paths {
            data: data.clone(),
            resources: data.clone(),
            executable: data.join("different-client"),
            home: data.clone(),
        };
        let lock = paths.lock().unwrap();
        lock.try_lock_exclusive().unwrap();
        let runtime = Runtime {
            url: "http://127.0.0.1:1234".into(),
            mcp_url: "http://127.0.0.1:1234/mcp".into(),
            instance_id: "existing-resident".into(),
            pid: std::process::id(),
        };
        fs::write(paths.runtime(), serde_json::to_string(&runtime).unwrap()).unwrap();
        let attached = attach(&paths).unwrap();
        assert_eq!(attached.instance_id, runtime.instance_id);
        assert_eq!(attached.pid, runtime.pid);
        assert!(!paths.home.join("Library/LaunchAgents").exists());
        assert!(!paths.stop_file().exists());
        drop(lock);
        fs::remove_dir_all(data).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn supervisor_cleanup_closes_the_owned_child_pipe() {
        let child = Command::new("/bin/sh")
            .args(["-c", "cat >/dev/null"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let pid = child.id();
        drop(ManagedChild { child });
        // Drop waits for the owned child, including on an early supervisor error.
        assert_eq!(unsafe { libc::kill(pid as i32, 0) }, -1);
    }
    #[test]
    fn descriptor_rejects_non_loopback_urls() {
        let data = env::temp_dir().join(format!("tasknboard-descriptor-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&data).unwrap();
        let paths = Paths {
            data: data.clone(),
            resources: data.clone(),
            executable: data.clone(),
            home: data.clone(),
        };
        for url in [
            "https://127.0.0.1:1234",
            "http://evil.example:1234",
            "http://127.0.0.1",
        ] {
            fs::write(paths.runtime(), serde_json::json!({"url": url, "mcpUrl": format!("{url}/mcp"), "instanceId": "test", "pid": 1}).to_string()).unwrap();
            assert!(read_runtime(&paths).is_err());
        }
        fs::remove_dir_all(data).unwrap();
    }
}
