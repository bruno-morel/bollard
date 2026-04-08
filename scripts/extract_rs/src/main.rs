mod extract;

use std::env;
use std::process;

const VERSION: &str = "0.1.0";

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();

    if args.is_empty() {
        eprintln!("usage: bollard-extract-rs [--version] <file1.rs> [<file2.rs> ...>");
        process::exit(1);
    }

    if args[0] == "--version" {
        println!("bollard-extract-rs {}", VERSION);
        return;
    }

    let cwd = env::current_dir().unwrap_or_else(|e| {
        eprintln!("error: cannot determine working directory: {}", e);
        process::exit(1);
    });

    let result = extract::extract_files(&args, &cwd);

    let json = serde_json::to_string_pretty(&result).unwrap_or_else(|e| {
        eprintln!("error: failed to serialize JSON: {}", e);
        process::exit(1);
    });

    println!("{}", json);
}
