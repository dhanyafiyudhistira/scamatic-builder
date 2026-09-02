#[cfg(not(windows))]
fn main() {
    eprintln!("scamatic-runtime-service is only used by the Windows local installer");
    std::process::exit(1);
}

#[cfg(windows)]
mod windows_host {
    use std::collections::{BTreeMap, HashSet};
    use std::env;
    use std::error::Error;
    use std::ffi::{OsString, c_void};
    use std::fs::{self, File, OpenOptions};
    use std::io::{self, Read, Write};
    use std::mem::{size_of, zeroed};
    use std::net::{SocketAddr, TcpListener, TcpStream};
    use std::os::windows::io::AsRawHandle;
    use std::path::{Path, PathBuf};
    use std::process::{Child, Command, ExitStatus, Stdio};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc::{self, Receiver, TryRecvError};
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
    use windows_service::define_windows_service;
    use windows_service::service::{
        ServiceAccess, ServiceControl, ServiceControlAccept, ServiceExitCode, ServiceState,
        ServiceStatus, ServiceType,
    };
    use windows_service::service_control_handler::{self, ServiceControlHandlerResult};
    use windows_service::service_dispatcher;
    use windows_service::service_manager::{ServiceManager, ServiceManagerAccess};
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::Security::Cryptography::{
        BCRYPT_USE_SYSTEM_PREFERRED_RNG, BCryptGenRandom,
    };
    use windows_sys::Win32::System::Console::{
        CTRL_BREAK_EVENT, CTRL_C_EVENT, CTRL_CLOSE_EVENT, CTRL_LOGOFF_EVENT, CTRL_SHUTDOWN_EVENT,
        SetConsoleCtrlHandler,
    };
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
        SetInformationJobObject,
    };

    const SERVICE_NAME: &str = "SCAMATICRuntime";
    const SERVICE_DISPLAY_NAME: &str = "SCAMATIC Local Runtime";
    const SERVICE_DESCRIPTION: &str =
        "Keeps the local SCAMATIC Express, connector worker, and Isaac data-plane available.";
    const ERROR_SERVICE_EXISTS: i32 = 1073;
    const ERROR_SERVICE_ALREADY_RUNNING: i32 = 1056;
    const DEFAULT_RUNTIME_RELATIVE_PATH: &str = "resources\\runtime";
    const CONFIG_RELATIVE_PATH: &str = "SCAMATIC\\runtime.env";
    const LOG_RELATIVE_PATH: &str = "SCAMATIC\\logs\\runtime.log";
    const MAX_CONFIG_BYTES: u64 = 64 * 1024;
    const LOCAL_APP_ORIGINS: &str = "http://127.0.0.1:3001,http://localhost:3001";
    const POLL_INTERVAL: Duration = Duration::from_millis(250);
    const READINESS_ADDRESS: &str = "127.0.0.1:3001";
    const READINESS_PATH: &str = "/health/data-plane/ready";
    const KEY_COMPATIBILITY_PATH: &str = "/health/data-plane/key-compatibility";
    const DEFAULT_READINESS_TIMEOUT: Duration = Duration::from_secs(60);
    const MAX_READINESS_TIMEOUT_SECONDS: u64 = 300;
    static CONSOLE_STOP_REQUESTED: AtomicBool = AtomicBool::new(false);

    define_windows_service!(ffi_service_main, service_main);

    type DynError = Box<dyn Error + Send + Sync>;

    #[derive(Clone, Debug, Eq, PartialEq)]
    struct RuntimeLayout {
        runtime_root: PathBuf,
        node_binary: PathBuf,
        server_entrypoint: PathBuf,
        isaac_binary: PathBuf,
        config_file: PathBuf,
        log_file: PathBuf,
    }

    impl RuntimeLayout {
        fn discover(
            runtime_override: Option<PathBuf>,
            config_override: Option<PathBuf>,
        ) -> Result<Self, DynError> {
            let install_root = env::current_exe()?
                .parent()
                .ok_or("the service executable has no parent directory")?
                .to_path_buf();
            let runtime_root = absolute_path(
                runtime_override
                    .unwrap_or_else(|| install_root.join(DEFAULT_RUNTIME_RELATIVE_PATH)),
            )?;
            let program_data = env::var_os("ProgramData")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"));
            let config_file = absolute_path(
                config_override.unwrap_or_else(|| program_data.join(CONFIG_RELATIVE_PATH)),
            )?;
            let log_file = absolute_path(program_data.join(LOG_RELATIVE_PATH))?;
            Ok(Self {
                node_binary: runtime_root.join("node.exe"),
                server_entrypoint: runtime_root.join("server").join("index.js"),
                isaac_binary: runtime_root.join("scamatic-data-plane.exe"),
                runtime_root,
                config_file,
                log_file,
            })
        }

        fn validate_files(&self) -> Result<(), DynError> {
            for (label, path) in [
                ("Node runtime", &self.node_binary),
                ("server entrypoint", &self.server_entrypoint),
                ("Isaac data-plane", &self.isaac_binary),
            ] {
                if !path.is_file() {
                    return Err(format!("{label} is missing: {}", path.display()).into());
                }
            }
            Ok(())
        }
    }

    fn absolute_path(path: PathBuf) -> io::Result<PathBuf> {
        if path.is_absolute() {
            Ok(path)
        } else {
            Ok(env::current_dir()?.join(path))
        }
    }

    #[derive(Default)]
    struct CliOptions {
        runtime_root: Option<PathBuf>,
        config_file: Option<PathBuf>,
    }

    pub fn main() -> Result<(), DynError> {
        let mut args = env::args_os().skip(1);
        let command = args.next().unwrap_or_else(|| OsString::from("service"));
        match command.to_string_lossy().as_ref() {
            "service" => {
                service_dispatcher::start(SERVICE_NAME, ffi_service_main)?;
                Ok(())
            }
            "run-console" => {
                let options = parse_options(args)?;
                let layout = RuntimeLayout::discover(options.runtime_root, options.config_file)?;
                install_console_control_handler()?;
                let (_stop_tx, stop_rx) = mpsc::channel();
                run_supervisor(layout, stop_rx, true).map(|_| ())
            }
            "validate" => {
                let options = parse_options(args)?;
                let layout = RuntimeLayout::discover(options.runtime_root, options.config_file)?;
                validate_layout(&layout)
            }
            "generate-master-key" => {
                if args.next().is_some() {
                    return Err("generate-master-key does not accept options".into());
                }
                print!("{}", generate_master_key()?);
                io::stdout().flush()?;
                Ok(())
            }
            "register-service" => {
                if args.next().is_some() {
                    return Err("register-service does not accept options".into());
                }
                register_service()
            }
            "wait-ready" => {
                let timeout = parse_readiness_timeout(args)?;
                wait_until_ready(timeout)
            }
            "wait-key-compatible" => {
                let timeout = parse_readiness_timeout(args)?;
                wait_until_key_compatible(timeout)
            }
            "check-key-compatible" => {
                if args.next().is_some() {
                    return Err("check-key-compatible does not accept options".into());
                }
                check_key_compatible()
            }
            "help" | "--help" | "-h" => {
                print_help();
                Ok(())
            }
            unknown => Err(format!("unknown command: {unknown}").into()),
        }
    }

    fn parse_options(mut args: impl Iterator<Item = OsString>) -> Result<CliOptions, DynError> {
        let mut options = CliOptions::default();
        while let Some(argument) = args.next() {
            match argument.to_string_lossy().as_ref() {
                "--runtime-root" => {
                    options.runtime_root = Some(PathBuf::from(
                        args.next().ok_or("--runtime-root requires a path")?,
                    ));
                }
                "--config" => {
                    options.config_file = Some(PathBuf::from(
                        args.next().ok_or("--config requires a path")?,
                    ));
                }
                unknown => return Err(format!("unknown option: {unknown}").into()),
            }
        }
        Ok(options)
    }

    fn print_help() {
        println!("{SERVICE_DISPLAY_NAME}");
        println!("  service      Run under the Windows Service Control Manager");
        println!("  run-console  Run the runtime supervisor in this console");
        println!("  validate     Validate packaged files and machine configuration");
        println!("  generate-master-key  Print a cryptographically random 32-byte key as hex");
        println!("  register-service  Create, configure, and start the Windows Service");
        println!("  wait-ready   Wait for the packaged data-plane readiness endpoint");
        println!("  wait-key-compatible  Verify the configured key can unwrap stored secrets");
        println!("  check-key-compatible  Run the compatibility probe once");
        println!("Options: --runtime-root <path> --config <path> --timeout-seconds <1-300>");
    }

    fn parse_readiness_timeout(
        mut args: impl Iterator<Item = OsString>,
    ) -> Result<Duration, DynError> {
        let mut timeout = DEFAULT_READINESS_TIMEOUT;
        while let Some(argument) = args.next() {
            match argument.to_string_lossy().as_ref() {
                "--timeout-seconds" => {
                    let raw = args.next().ok_or("--timeout-seconds requires a value")?;
                    let seconds = raw
                        .to_string_lossy()
                        .parse::<u64>()
                        .map_err(|_| "--timeout-seconds must be an integer")?;
                    if !(1..=MAX_READINESS_TIMEOUT_SECONDS).contains(&seconds) {
                        return Err(format!(
                            "--timeout-seconds must be between 1 and {MAX_READINESS_TIMEOUT_SECONDS}"
                        )
                        .into());
                    }
                    timeout = Duration::from_secs(seconds);
                }
                unknown => return Err(format!("unknown option: {unknown}").into()),
            }
        }
        Ok(timeout)
    }

    fn generate_master_key() -> Result<String, DynError> {
        let mut bytes = [0_u8; 32];
        let status = unsafe {
            BCryptGenRandom(
                std::ptr::null_mut(),
                bytes.as_mut_ptr(),
                bytes.len() as u32,
                BCRYPT_USE_SYSTEM_PREFERRED_RNG,
            )
        };
        if status < 0 {
            return Err(format!(
                "Windows CNG random generation failed: 0x{:08x}",
                status as u32
            )
            .into());
        }
        Ok(hex_encode(&bytes))
    }

    fn register_service() -> Result<(), DynError> {
        let executable = env::current_exe()?;
        let binary_path = service_binary_path(&executable);

        run_sc(
            "create service",
            &[
                "create",
                SERVICE_NAME,
                "binPath=",
                &binary_path,
                "start=",
                "delayed-auto",
                "DisplayName=",
                SERVICE_DISPLAY_NAME,
            ],
            &[0, ERROR_SERVICE_EXISTS],
        )?;
        run_sc(
            "configure service",
            &[
                "config",
                SERVICE_NAME,
                "binPath=",
                &binary_path,
                "start=",
                "delayed-auto",
                "DisplayName=",
                SERVICE_DISPLAY_NAME,
            ],
            &[0],
        )?;
        run_sc(
            "set service description",
            &["description", SERVICE_NAME, SERVICE_DESCRIPTION],
            &[0],
        )?;
        run_sc(
            "set service recovery actions",
            &[
                "failure",
                SERVICE_NAME,
                "reset=",
                "86400",
                "actions=",
                "restart/5000/restart/15000/restart/60000",
            ],
            &[0],
        )?;
        run_sc(
            "enable service recovery for non-crash failures",
            &["failureflag", SERVICE_NAME, "1"],
            &[0],
        )?;
        if query_service_state()? != ServiceState::Running {
            wait_for_port_available(READINESS_ADDRESS.parse()?, Duration::from_secs(5))?;
        }
        run_sc(
            "start service",
            &["start", SERVICE_NAME],
            &[0, ERROR_SERVICE_ALREADY_RUNNING],
        )?;
        println!("{SERVICE_DISPLAY_NAME} is registered and starting.");
        Ok(())
    }

    fn service_binary_path(executable: &Path) -> String {
        format!("\"{}\" service", executable.display())
    }

    fn run_sc(label: &str, arguments: &[&str], accepted_codes: &[i32]) -> Result<(), DynError> {
        let system_root = env::var_os("SystemRoot").ok_or("SystemRoot is not available")?;
        let sc_executable = PathBuf::from(system_root).join("System32").join("sc.exe");
        let status = Command::new(sc_executable).args(arguments).status()?;
        let code = status.code().unwrap_or(-1);
        if !accepted_codes.contains(&code) {
            return Err(format!("failed to {label}: sc.exe exited with {code}").into());
        }
        Ok(())
    }

    fn hex_encode(bytes: &[u8]) -> String {
        const HEX: &[u8; 16] = b"0123456789abcdef";
        let mut encoded = String::with_capacity(bytes.len() * 2);
        for byte in bytes {
            encoded.push(HEX[(byte >> 4) as usize] as char);
            encoded.push(HEX[(byte & 0x0f) as usize] as char);
        }
        encoded
    }

    fn wait_until_ready(timeout: Duration) -> Result<(), DynError> {
        let address: SocketAddr = READINESS_ADDRESS.parse()?;
        let deadline = Instant::now() + timeout;
        loop {
            let state = query_service_state()?;
            let last_failure = match (state, readiness_probe(address)) {
                (ServiceState::Running, Ok(true)) => {
                    println!(
                        "SCAMATIC data-plane is ready at http://{READINESS_ADDRESS}{READINESS_PATH}"
                    );
                    return Ok(());
                }
                (ServiceState::Stopped, _) => {
                    return Err("SCAMATIC Windows Service stopped before becoming ready; check for a port 3001 conflict and inspect runtime.log".into());
                }
                (_, Ok(true)) => {
                    format!("readiness endpoint responded, but Windows Service is {state:?}")
                }
                (_, Ok(false)) => format!(
                    "Windows Service is {state:?}; readiness endpoint returned a non-200 status"
                ),
                (_, Err(error)) => format!("Windows Service is {state:?}; {error}"),
            };
            if Instant::now() >= deadline {
                return Err(format!(
                    "SCAMATIC data-plane did not become ready within {} seconds: {last_failure}",
                    timeout.as_secs()
                )
                .into());
            }
            std::thread::sleep(Duration::from_millis(500));
        }
    }

    fn wait_until_key_compatible(timeout: Duration) -> Result<(), DynError> {
        let address: SocketAddr = READINESS_ADDRESS.parse()?;
        let deadline = Instant::now() + timeout;
        loop {
            let state = query_service_state()?;
            let last_failure = match (state, compatibility_probe(address)) {
                (ServiceState::Running, Ok(true)) => {
                    println!(
                        "SCAMATIC master key is compatible with the encrypted database records."
                    );
                    return Ok(());
                }
                (ServiceState::Stopped, _) => {
                    return Err("SCAMATIC Windows Service stopped before master-key compatibility could be checked; inspect runtime.log".into());
                }
                (_, Ok(true)) => {
                    format!("compatibility endpoint responded, but Windows Service is {state:?}")
                }
                (_, Ok(false)) => format!(
                    "Windows Service is {state:?}; configured master key is incompatible with one or more encrypted records"
                ),
                (_, Err(error)) => format!("Windows Service is {state:?}; {error}"),
            };
            if Instant::now() >= deadline {
                return Err(format!(
                    "SCAMATIC master-key compatibility was not confirmed within {} seconds: {last_failure}",
                    timeout.as_secs()
                )
                .into());
            }
            std::thread::sleep(Duration::from_millis(500));
        }
    }

    fn check_key_compatible() -> Result<(), DynError> {
        if query_service_state()? != ServiceState::Running {
            return Err("SCAMATIC Windows Service is not running".into());
        }
        let address: SocketAddr = READINESS_ADDRESS.parse()?;
        if compatibility_probe(address)? {
            println!("SCAMATIC master key is compatible with the encrypted database records.");
            Ok(())
        } else {
            Err("configured master key is incompatible with one or more encrypted records".into())
        }
    }

    fn query_service_state() -> Result<ServiceState, DynError> {
        let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)?;
        let service = manager.open_service(SERVICE_NAME, ServiceAccess::QUERY_STATUS)?;
        Ok(service.query_status()?.current_state)
    }

    fn wait_for_port_available(address: SocketAddr, timeout: Duration) -> Result<(), DynError> {
        let deadline = Instant::now() + timeout;
        loop {
            match TcpListener::bind(address) {
                Ok(listener) => {
                    drop(listener);
                    return Ok(());
                }
                Err(error) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(250));
                    let _ = error;
                }
                Err(error) => {
                    return Err(format!(
                        "port {address} is already in use ({error}); close any manually started SCAMATIC/Node server before installing"
                    )
                    .into());
                }
            }
        }
    }

    fn readiness_probe(address: SocketAddr) -> Result<bool, DynError> {
        http_json_probe(address, READINESS_PATH, br#""status":"ready""#)
    }

    fn compatibility_probe(address: SocketAddr) -> Result<bool, DynError> {
        http_json_probe(
            address,
            KEY_COMPATIBILITY_PATH,
            br#""check":"master-key-compatibility""#,
        )
    }

    fn http_json_probe(
        address: SocketAddr,
        path: &str,
        expected_marker: &[u8],
    ) -> Result<bool, DynError> {
        let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(2))?;
        stream.set_read_timeout(Some(Duration::from_secs(2)))?;
        stream.set_write_timeout(Some(Duration::from_secs(2)))?;
        write!(
            stream,
            "GET {path} HTTP/1.1\r\nHost: {READINESS_ADDRESS}\r\nConnection: close\r\n\r\n"
        )?;
        stream.flush()?;
        let mut response = Vec::with_capacity(1024);
        stream.take(64 * 1024).read_to_end(&mut response)?;
        Ok(response_reports_success(&response, expected_marker))
    }

    #[cfg(test)]
    fn response_reports_ready(response: &[u8]) -> bool {
        response_reports_success(response, br#""status":"ready""#)
    }

    fn response_reports_success(response: &[u8], expected_marker: &[u8]) -> bool {
        let success_status = response
            .split(|byte| *byte == b'\n')
            .next()
            .and_then(|line| std::str::from_utf8(line).ok())
            .is_some_and(|line| line.trim_end_matches('\r').starts_with("HTTP/1.1 200 "));
        let body = response
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .map(|index| &response[index + 4..])
            .unwrap_or_default();
        success_status
            && contains_bytes(body, br#""ok":true"#)
            && contains_bytes(body, expected_marker)
    }

    fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
        !needle.is_empty()
            && haystack
                .windows(needle.len())
                .any(|window| window == needle)
    }

    fn validate_layout(layout: &RuntimeLayout) -> Result<(), DynError> {
        layout.validate_files()?;
        let environment = load_environment(&layout.config_file)?;
        validate_master_key_environment(&environment)?;
        let missing = operational_warnings(&environment);
        println!("SCAMATIC runtime bundle is valid.");
        println!("Runtime root: {}", layout.runtime_root.display());
        println!("Machine config: {}", layout.config_file.display());
        if missing.is_empty() {
            println!("Machine configuration contains the operational keys.");
        } else {
            println!(
                "Runtime can start in degraded mode; missing: {}",
                missing.join(", ")
            );
        }
        Ok(())
    }

    fn validate_master_key_environment(
        environment: &BTreeMap<String, String>,
    ) -> Result<(), DynError> {
        if let Some(value) = environment.get("SCADA_CONNECTOR_MASTER_KEY") {
            if !value.trim().is_empty() && !valid_master_key(value.trim()) {
                return Err(
                    "SCADA_CONNECTOR_MASTER_KEY must be 64-character hex or 32-byte base64".into(),
                );
            }
        }
        if let Some(values) = environment.get("SCADA_CONNECTOR_PREVIOUS_MASTER_KEYS") {
            for value in values
                .split(',')
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                if !valid_master_key(value) {
                    return Err(
                        "SCADA_CONNECTOR_PREVIOUS_MASTER_KEYS contains an invalid key".into(),
                    );
                }
            }
        }
        Ok(())
    }

    fn valid_master_key(value: &str) -> bool {
        if value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return true;
        }
        let bytes = value.as_bytes();
        if !matches!(bytes.len(), 43 | 44) || (bytes.len() == 44 && bytes[43] != b'=') {
            return false;
        }
        bytes[..43]
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/'))
    }

    fn service_main(_arguments: Vec<OsString>) {
        if let Err(error) = run_service() {
            let fallback = RuntimeLayout::discover(None, None)
                .ok()
                .and_then(|layout| RuntimeLogger::open(&layout.log_file).ok());
            if let Some(mut logger) = fallback {
                logger.line(&format!("service failed: {error}"));
            }
        }
    }

    fn install_console_control_handler() -> io::Result<()> {
        CONSOLE_STOP_REQUESTED.store(false, Ordering::Release);
        let registered = unsafe { SetConsoleCtrlHandler(Some(console_control_handler), 1) };
        if registered == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    unsafe extern "system" fn console_control_handler(control: u32) -> i32 {
        match control {
            CTRL_C_EVENT | CTRL_BREAK_EVENT | CTRL_CLOSE_EVENT | CTRL_LOGOFF_EVENT
            | CTRL_SHUTDOWN_EVENT => {
                CONSOLE_STOP_REQUESTED.store(true, Ordering::Release);
                1
            }
            _ => 0,
        }
    }

    fn run_service() -> Result<(), DynError> {
        let (stop_tx, stop_rx) = mpsc::channel();
        let event_handler = move |event| match event {
            ServiceControl::Stop | ServiceControl::Shutdown => {
                let _ = stop_tx.send(());
                ServiceControlHandlerResult::NoError
            }
            ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
            _ => ServiceControlHandlerResult::NotImplemented,
        };
        let status_handle = service_control_handler::register(SERVICE_NAME, event_handler)?;
        status_handle.set_service_status(service_status(
            ServiceState::StartPending,
            ServiceControlAccept::empty(),
            1,
            Duration::from_secs(20),
            ServiceExitCode::Win32(0),
        ))?;

        let layout = RuntimeLayout::discover(None, None)?;
        layout.validate_files()?;
        status_handle.set_service_status(service_status(
            ServiceState::Running,
            ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN,
            0,
            Duration::default(),
            ServiceExitCode::Win32(0),
        ))?;

        let result = run_supervisor(layout, stop_rx, false);
        status_handle.set_service_status(service_status(
            ServiceState::StopPending,
            ServiceControlAccept::empty(),
            1,
            Duration::from_secs(15),
            ServiceExitCode::Win32(0),
        ))?;
        let exit_code = if result.is_ok() {
            ServiceExitCode::Win32(0)
        } else {
            ServiceExitCode::ServiceSpecific(1)
        };
        status_handle.set_service_status(service_status(
            ServiceState::Stopped,
            ServiceControlAccept::empty(),
            0,
            Duration::default(),
            exit_code,
        ))?;
        result.map(|_| ())
    }

    fn service_status(
        current_state: ServiceState,
        controls_accepted: ServiceControlAccept,
        checkpoint: u32,
        wait_hint: Duration,
        exit_code: ServiceExitCode,
    ) -> ServiceStatus {
        ServiceStatus {
            service_type: ServiceType::OWN_PROCESS,
            current_state,
            controls_accepted,
            exit_code,
            checkpoint,
            wait_hint,
            process_id: None,
        }
    }

    fn run_supervisor(
        layout: RuntimeLayout,
        stop_rx: Receiver<()>,
        console: bool,
    ) -> Result<ExitStatus, DynError> {
        layout.validate_files()?;
        let configured_environment = load_environment(&layout.config_file)?;
        let mut logger = RuntimeLogger::open(&layout.log_file)?;
        logger.line("starting packaged SCAMATIC runtime");
        for warning in operational_warnings(&configured_environment) {
            logger.line(&format!("configuration warning: {warning} is not set"));
        }

        let output = logger.child_output()?;
        let mut command = Command::new(&layout.node_binary);
        command
            .arg(&layout.server_entrypoint)
            .current_dir(&layout.runtime_root)
            .stdin(Stdio::null())
            .stdout(Stdio::from(output.try_clone()?))
            .stderr(Stdio::from(output));
        for (key, value) in configured_environment {
            command.env(key, value);
        }
        apply_forced_environment(&mut command, &layout);

        let mut child = command.spawn()?;
        let job = KillOnCloseJob::create()?;
        job.assign(&child)?;
        logger.line(&format!("runtime process started with pid {}", child.id()));
        if console {
            println!(
                "SCAMATIC runtime started with pid {}. Press Ctrl+C or close the console to stop it.",
                child.id()
            );
        }

        loop {
            if console && CONSOLE_STOP_REQUESTED.load(Ordering::Acquire) {
                logger.line("console stop requested; terminating runtime process tree");
                drop(job);
                return wait_for_exit(&mut child, Duration::from_secs(10));
            }
            match stop_rx.try_recv() {
                Ok(()) | Err(TryRecvError::Disconnected) => {
                    logger.line("stop requested; terminating runtime process tree");
                    drop(job);
                    return wait_for_exit(&mut child, Duration::from_secs(10));
                }
                Err(TryRecvError::Empty) => {}
            }
            if let Some(status) = child.try_wait()? {
                logger.line(&format!("runtime process exited unexpectedly: {status}"));
                return Err(format!("runtime process exited unexpectedly: {status}").into());
            }
            std::thread::sleep(POLL_INTERVAL);
        }
    }

    fn wait_for_exit(child: &mut Child, timeout: Duration) -> Result<ExitStatus, DynError> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(status) = child.try_wait()? {
                return Ok(status);
            }
            if Instant::now() >= deadline {
                child.kill()?;
                return Ok(child.wait()?);
            }
            std::thread::sleep(POLL_INTERVAL);
        }
    }

    fn apply_forced_environment(command: &mut Command, layout: &RuntimeLayout) {
        command
            .env("NODE_ENV", "production")
            .env("PORT", "3001")
            .env("APP_ORIGIN", LOCAL_APP_ORIGINS)
            .env("SCAMATIC_CANONICAL_LOCAL_ORIGIN", "http://127.0.0.1:3001")
            .env("SERVE_STATIC_FRONTEND", "true")
            .env("CONNECTOR_PLATFORM_ENABLED", "true")
            .env("CONNECTOR_LIVE_COMMANDS_ENABLED", "true")
            .env("CONNECTOR_EXECUTION_MODE", "worker")
            .env("CONNECTOR_STREAM_MODE", "embedded")
            .env("SCADA_RUST_SHADOW_BINARY", &layout.isaac_binary);
    }

    fn operational_warnings(environment: &BTreeMap<String, String>) -> Vec<&'static str> {
        ["MONGO_URI", "SCADA_CONNECTOR_MASTER_KEY"]
            .into_iter()
            .filter(|key| {
                environment
                    .get(*key)
                    .is_none_or(|value| value.trim().is_empty())
            })
            .collect()
    }

    fn load_environment(path: &Path) -> Result<BTreeMap<String, String>, DynError> {
        if !path.exists() {
            return Ok(BTreeMap::new());
        }
        let metadata = fs::metadata(path)?;
        if metadata.len() > MAX_CONFIG_BYTES {
            return Err(format!("machine configuration exceeds {MAX_CONFIG_BYTES} bytes").into());
        }
        let content = fs::read_to_string(path)?;
        parse_environment(&content)
    }

    fn parse_environment(content: &str) -> Result<BTreeMap<String, String>, DynError> {
        let mut parsed = BTreeMap::new();
        let mut seen = HashSet::new();
        for (index, original) in content.lines().enumerate() {
            let line_number = index + 1;
            let mut line = original.trim();
            if line_number == 1 {
                line = line.trim_start_matches('\u{feff}');
            }
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if let Some(rest) = line.strip_prefix("export ") {
                line = rest.trim_start();
            }
            let (raw_key, raw_value) = line
                .split_once('=')
                .ok_or_else(|| format!("invalid machine configuration at line {line_number}"))?;
            let key = raw_key.trim();
            if !valid_environment_key(key) {
                return Err(format!("invalid environment key at line {line_number}").into());
            }
            if blocked_environment_key(key) {
                return Err(format!("unsafe environment key {key} at line {line_number}").into());
            }
            if !seen.insert(key.to_string()) {
                return Err(
                    format!("duplicate environment key {key} at line {line_number}").into(),
                );
            }
            let value = parse_environment_value(raw_value.trim(), line_number)?;
            parsed.insert(key.to_string(), value);
        }
        Ok(parsed)
    }

    fn parse_environment_value(value: &str, line_number: usize) -> Result<String, DynError> {
        if value.len() >= 2 {
            let first = value.as_bytes()[0];
            let last = value.as_bytes()[value.len() - 1];
            if (first == b'\'' && last == b'\'') || (first == b'"' && last == b'"') {
                return Ok(value[1..value.len() - 1].to_string());
            }
        }
        if value.starts_with(['\'', '"']) || value.ends_with(['\'', '"']) {
            return Err(format!("unbalanced quotes at line {line_number}").into());
        }
        Ok(value.to_string())
    }

    fn valid_environment_key(key: &str) -> bool {
        let mut characters = key.chars();
        matches!(characters.next(), Some(first) if first == '_' || first.is_ascii_alphabetic())
            && characters.all(|character| character == '_' || character.is_ascii_alphanumeric())
    }

    fn blocked_environment_key(key: &str) -> bool {
        matches!(
            key.to_ascii_uppercase().as_str(),
            "COMSPEC" | "NODE_OPTIONS" | "NODE_PATH" | "PATH" | "PATHEXT" | "SYSTEMROOT" | "WINDIR"
        )
    }

    struct RuntimeLogger {
        file: File,
    }

    impl RuntimeLogger {
        fn open(path: &Path) -> io::Result<Self> {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)?;
            }
            let file = OpenOptions::new().create(true).append(true).open(path)?;
            Ok(Self { file })
        }

        fn line(&mut self, message: &str) {
            let _ = writeln!(self.file, "[{}] [service] {message}", unix_time_seconds());
            let _ = self.file.flush();
        }

        fn child_output(&self) -> io::Result<File> {
            self.file.try_clone()
        }
    }

    fn unix_time_seconds() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_secs())
            .unwrap_or(0)
    }

    struct KillOnCloseJob(HANDLE);

    impl KillOnCloseJob {
        fn create() -> io::Result<Self> {
            let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if handle.is_null() {
                return Err(io::Error::last_os_error());
            }
            let job = Self(handle);
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let configured = unsafe {
                SetInformationJobObject(
                    job.0,
                    JobObjectExtendedLimitInformation,
                    (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast::<c_void>(),
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            };
            if configured == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(job)
        }

        fn assign(&self, child: &Child) -> io::Result<()> {
            let process_handle = child.as_raw_handle() as HANDLE;
            let assigned = unsafe { AssignProcessToJobObject(self.0, process_handle) };
            if assigned == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }
    }

    impl Drop for KillOnCloseJob {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    CloseHandle(self.0);
                }
                self.0 = std::ptr::null_mut();
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::ffi::OsStr;

        #[test]
        fn parses_comments_exports_and_quoted_values() {
            let parsed = parse_environment(
                "\u{feff}# machine configuration\nexport MONGO_URI=\"mongodb://localhost/test\"\nSCADA_CONNECTOR_MASTER_KEY='abc='\nEMPTY=\n",
            )
            .unwrap();
            assert_eq!(parsed.get("MONGO_URI").unwrap(), "mongodb://localhost/test");
            assert_eq!(parsed.get("SCADA_CONNECTOR_MASTER_KEY").unwrap(), "abc=");
            assert_eq!(parsed.get("EMPTY").unwrap(), "");
        }

        #[test]
        fn rejects_duplicate_and_process_control_keys() {
            assert!(parse_environment("A=one\nA=two\n").is_err());
            assert!(parse_environment("NODE_OPTIONS=--require malware.js\n").is_err());
            assert!(parse_environment("NOT-A-KEY=value\n").is_err());
        }

        #[test]
        fn forced_runtime_settings_override_machine_config() {
            let temporary =
                env::temp_dir().join(format!("scamatic-service-test-{}", std::process::id()));
            let layout = RuntimeLayout {
                runtime_root: temporary.clone(),
                node_binary: temporary.join("node.exe"),
                server_entrypoint: temporary.join("server/index.js"),
                isaac_binary: temporary.join("scamatic-data-plane.exe"),
                config_file: temporary.join("runtime.env"),
                log_file: temporary.join("runtime.log"),
            };
            let mut command = Command::new("node.exe");
            command.env("PORT", "9999");
            apply_forced_environment(&mut command, &layout);
            let variables: BTreeMap<_, _> = command
                .get_envs()
                .filter_map(|(key, value)| {
                    value.map(|value| (key.to_os_string(), value.to_os_string()))
                })
                .collect();
            assert_eq!(variables.get(OsStr::new("PORT")).unwrap(), "3001");
            assert_eq!(
                variables.get(OsStr::new("APP_ORIGIN")).unwrap(),
                LOCAL_APP_ORIGINS
            );
            assert_eq!(
                variables
                    .get(OsStr::new("SCAMATIC_CANONICAL_LOCAL_ORIGIN"))
                    .unwrap(),
                "http://127.0.0.1:3001"
            );
            assert_eq!(
                variables
                    .get(OsStr::new("CONNECTOR_EXECUTION_MODE"))
                    .unwrap(),
                "worker"
            );
        }

        #[test]
        fn generated_master_keys_are_valid_32_byte_hex_values() {
            let first = generate_master_key().unwrap();
            let second = generate_master_key().unwrap();
            assert_eq!(first.len(), 64);
            assert!(first.bytes().all(|byte| byte.is_ascii_hexdigit()));
            assert_ne!(first, second);
        }

        #[test]
        fn master_key_validation_accepts_supported_encodings() {
            assert!(valid_master_key(&"ab".repeat(32)));
            assert!(valid_master_key(
                "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
            ));
            assert!(valid_master_key(
                "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
            ));
            assert!(!valid_master_key("short"));
            assert!(!valid_master_key(
                "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA?="
            ));
        }

        #[test]
        fn service_binary_path_quotes_the_executable_but_not_its_mode() {
            let path =
                Path::new(r"C:\Program Files\SCAMATIC Builder Local\scamatic-runtime-service.exe");
            assert_eq!(
                service_binary_path(path),
                r#""C:\Program Files\SCAMATIC Builder Local\scamatic-runtime-service.exe" service"#
            );
        }

        #[test]
        fn readiness_parser_requires_the_ready_json_response() {
            assert!(response_reports_ready(
                b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"ok\":true,\"status\":\"ready\"}"
            ));
            assert!(!response_reports_ready(
                b"HTTP/1.1 503 Service Unavailable\r\n\r\n"
            ));
            assert!(!response_reports_ready(
                b"HTTP/1.1 200 OK\r\n\r\n{\"ok\":true,\"status\":\"starting\"}"
            ));
            assert!(!response_reports_ready(b"not-http"));
        }

        #[test]
        fn generic_probe_parser_requires_success_and_expected_marker() {
            let response =
                b"HTTP/1.1 200 OK\r\n\r\n{\"ok\":true,\"check\":\"master-key-compatibility\"}";
            assert!(response_reports_success(
                response,
                br#""check":"master-key-compatibility""#
            ));
            assert!(!response_reports_success(response, br#""status":"ready""#));
        }

        #[test]
        fn readiness_timeout_is_bounded() {
            let parsed = parse_readiness_timeout(
                [OsString::from("--timeout-seconds"), OsString::from("45")].into_iter(),
            )
            .unwrap();
            assert_eq!(parsed, Duration::from_secs(45));
            assert!(
                parse_readiness_timeout(
                    [OsString::from("--timeout-seconds"), OsString::from("0")].into_iter()
                )
                .is_err()
            );
        }

        #[test]
        fn port_preflight_rejects_an_existing_listener() {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            assert!(wait_for_port_available(address, Duration::ZERO).is_err());
            drop(listener);
            assert!(wait_for_port_available(address, Duration::ZERO).is_ok());
        }
    }
}

#[cfg(windows)]
fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    windows_host::main()
}
