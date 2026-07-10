use std::{env, fs, path::PathBuf};

fn main() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let repo_dir = manifest_dir.parent().expect("hud has a parent repo");
    let dashboard_html = repo_dir.join("dashboard").join("dashboard.html");
    let hud_js = manifest_dir.join("frontend").join("hud.js");
    let dist_dir = manifest_dir.join("dist");

    println!("cargo:rerun-if-changed={}", dashboard_html.display());
    println!("cargo:rerun-if-changed={}", hud_js.display());

    fs::create_dir_all(&dist_dir).expect("create dist dir");
    fs::copy(&dashboard_html, dist_dir.join("index.html")).expect("copy dashboard html");
    fs::copy(&hud_js, dist_dir.join("hud.js")).expect("copy hud bridge");

    tauri_build::build();
}
