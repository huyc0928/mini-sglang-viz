//! CLI 入口。

use anyhow::Result;
use clap::{Parser, Subcommand};
use minisgl_viz::extract;
use std::path::PathBuf;

#[derive(Parser)]
#[command(name = "minisgl-viz", about = "mini-sglang 源码可视化")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// 静态抽取，写出 data/*.json
    Extract {
        /// mini-sglang 仓库根目录
        #[arg(long)]
        src: PathBuf,
        /// 输出目录
        #[arg(long)]
        out: PathBuf,
    },
    /// 起 HTTP 服务
    Serve {
        /// 数据目录（extract 的输出）
        #[arg(long, default_value = "../data")]
        data: PathBuf,
        /// 前端构建产物目录，存在则一并托管
        #[arg(long)]
        dist: Option<PathBuf>,
        #[arg(long, default_value_t = 8787)]
        port: u16,
    },
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.cmd {
        Cmd::Extract { src, out } => {
            let dir = extract::extract(&src, &out)?;
            println!("写出到 {}", dir.display());
            Ok(())
        }
        Cmd::Serve { data, dist, port } => minisgl_viz::api::serve(data, dist, port),
    }
}
