//! External fixtures for core-shell tests when acceptance stand-ins are omitted.
use futures::FutureExt;
use shell_engine::{
    executor::{Budget, Cancel},
    io::{Endpoint, MemoryFs, OpenOptions},
    process::{InProcessHost, SpawnRequest},
};

pub fn register_utilities(host: &InProcessHost, fs: &MemoryFs, with_seq: bool) {
    let files = fs.clone();
    host.register("/home/guest/cat", move |request, cancel| {
        cat(request, cancel, files.clone()).boxed_local()
    });
    let files = fs.clone();
    host.register("/home/guest/mkdir", move |request, cancel| {
        mkdir(request, cancel, files.clone()).boxed_local()
    });
    if with_seq {
        host.register("/home/guest/seq", |request, cancel| {
            seq(request, cancel).boxed_local()
        });
    }
}

fn absolute(cwd: &str, path: &str) -> String {
    if path.is_empty() {
        return String::new();
    }
    let source = if path.starts_with('/') {
        path.to_owned()
    } else {
        format!("{cwd}/{path}")
    };
    let mut components = Vec::new();
    for component in source.split('/') {
        match component {
            "" | "." => {}
            ".." => {
                components.pop();
            }
            component => components.push(component),
        }
    }
    format!("/{}", components.join("/"))
}

fn input(request: &SpawnRequest, fs: &MemoryFs, operand: &str) -> Result<Endpoint, i32> {
    if operand == "-" {
        return request.fds.get(0).ok_or(1);
    }
    if let Some(descriptor) = operand.strip_prefix("/dev/fd/") {
        let descriptor = descriptor.parse::<u32>().map_err(|_| 1)?;
        return request.fds.get(descriptor).ok_or(1);
    }
    fs.open(&absolute(&request.cwd, operand), &OpenOptions::default())
        .map_err(|error| error.status())
}

async fn copy(input: Endpoint, output: Endpoint, cancel: &Cancel) -> i32 {
    let mut buffer = [0u8; 8192];
    let mut budget = Budget::default();
    loop {
        if budget.checkpoint(cancel).await.is_err() {
            return 130;
        }
        let count = match input.read_cancelled(&mut buffer, cancel).await {
            Ok(0) => return 0,
            Ok(count) => count,
            Err(error) => return error.status(),
        };
        if let Err(error) = output.write_all(&buffer[..count], cancel).await {
            return error.status();
        }
    }
}

async fn cat(request: SpawnRequest, cancel: Cancel, fs: MemoryFs) -> i32 {
    let output = request.fds.get(1).unwrap();
    if request.argv.len() == 1 {
        return copy(request.fds.get(0).unwrap(), output, &cancel).await;
    }
    for operand in request.argv.iter().skip(1) {
        let input = match input(&request, &fs, operand) {
            Ok(input) => input,
            Err(status) => return status,
        };
        let status = copy(input, output.clone(), &cancel).await;
        if status != 0 {
            return status;
        }
    }
    0
}

fn mkdir_operands(args: &[String]) -> Result<(bool, Vec<&str>), i32> {
    let mut parents = false;
    let mut options = true;
    let mut operands = Vec::new();
    for argument in args {
        match argument.as_str() {
            "--" if options => options = false,
            "-p" if options => parents = true,
            argument if options && argument.starts_with('-') && argument != "-" => return Err(2),
            argument => operands.push(argument),
        }
    }
    if operands.is_empty() {
        return Err(2);
    }
    Ok((parents, operands))
}

async fn mkdir(request: SpawnRequest, cancel: Cancel, fs: MemoryFs) -> i32 {
    let (parents, operands) = match mkdir_operands(&request.argv[1..]) {
        Ok(parsed) => parsed,
        Err(status) => return status,
    };
    let mut status = 0;
    for operand in operands {
        let Err(error) = fs.mkdir(&absolute(&request.cwd, operand), parents) else {
            continue;
        };
        status = 1;
        let Some(stderr) = request.fds.get(2) else {
            continue;
        };
        let diagnostic = format!("mkdir: {operand}: {error}\n");
        if stderr
            .write_all(diagnostic.as_bytes(), &cancel)
            .await
            .is_err()
        {
            return 1;
        }
    }
    status
}

async fn seq(request: SpawnRequest, cancel: Cancel) -> i32 {
    let (start, end) = match request.argv[1..]
        .iter()
        .map(|value| value.parse::<i64>())
        .collect::<Result<Vec<_>, _>>()
    {
        Ok(values) => match values.as_slice() {
            [end] => (1, *end),
            [start, end] => (*start, *end),
            _ => return 2,
        },
        Err(_) => return 2,
    };
    let output = request.fds.get(1).unwrap();
    let mut budget = Budget::default();
    for value in start..=end {
        if budget.checkpoint(&cancel).await.is_err() {
            return 130;
        }
        if let Err(error) = output
            .write_all(format!("{value}\n").as_bytes(), &cancel)
            .await
        {
            return error.status();
        }
    }
    0
}
