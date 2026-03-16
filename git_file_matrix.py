#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import tempfile
import threading
import webbrowser
from collections import OrderedDict
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate a git file/commit matrix, optionally serve an interactive UI."
    )
    parser.add_argument(
        "rev_range",
        nargs="?",
        default="origin/main..HEAD",
        help='Git revision range (default: "origin/main..HEAD")',
    )
    parser.add_argument(
        "--out",
        type=Path,
        help="Output path for JSON data. Defaults to stdout unless --serve is used.",
    )
    parser.add_argument(
        "--serve",
        action="store_true",
        help="Generate matrix data and serve the bundled web UI.",
    )
    parser.add_argument(
        "--host",
        default="127.0.0.1",
        help='Host to bind when serving (default: "127.0.0.1").',
    )
    parser.add_argument(
        "--port",
        type=int,
        default=8765,
        help="Port to bind when serving (default: 8765).",
    )
    parser.add_argument(
        "--open-browser",
        action="store_true",
        help="Open the served UI in your default browser.",
    )
    return parser.parse_args()


def load_git_log(rev_range: str) -> str:
    cmd = [
        "git",
        "log",
        "--reverse",
        "--name-only",
        "--format=COMMIT\t%h\t%s",
        rev_range,
    ]
    return subprocess.check_output(cmd, text=True, encoding="utf-8", errors="replace")


def build_matrix_data(git_log_output: str, rev_range: str) -> dict[str, Any]:
    commits: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None

    for line in git_log_output.splitlines():
        if line.startswith("COMMIT\t"):
            _, short_sha, subject = line.split("\t", 2)
            current = {"sha": short_sha, "subject": subject, "files": []}
            commits.append(current)
        elif line.strip() and current is not None:
            current["files"].append(line.strip())

    all_files = list(OrderedDict.fromkeys(f for c in commits for f in c["files"]))

    return {
        "rev_range": rev_range,
        "commits": [{"sha": c["sha"], "subject": c["subject"]} for c in commits],
        "files": all_files,
        "touches": {c["sha"]: {f: True for f in c["files"]} for c in commits},
    }


def render_data_json(data: dict[str, Any]) -> str:
    return json.dumps(data, indent=2)


def write_data(data: dict[str, Any], out_path: Path | None) -> None:
    json_output = render_data_json(data)
    if out_path is None:
        print(json_output)
        return
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        dir=out_path.parent,
        delete=False,
        prefix=f".{out_path.name}.",
        suffix=".tmp",
    ) as temp_file:
        temp_file.write(f"{json_output}\n")
        temp_path = Path(temp_file.name)
    temp_path.replace(out_path)


def bundle_dir() -> Path:
    return Path(__file__).resolve().parent


def web_dist_dir() -> Path:
    return bundle_dir() / "web" / "dist"


def copy_bundle_assets(target_dir: Path) -> None:
    dist_dir = web_dist_dir()
    if not dist_dir.exists():
        raise FileNotFoundError(
            "Built web assets not found. Expected directory: "
            f"{dist_dir}\n"
            "Build the web UI first:\n"
            f'  cd "{bundle_dir() / "web"}" && npm install && npm run build'
        )
    if not (dist_dir / "index.html").exists():
        raise FileNotFoundError(
            f"Built web assets are incomplete: missing {(dist_dir / 'index.html')}"
        )
    shutil.copytree(dist_dir, target_dir, dirs_exist_ok=True)


def load_data_from_git(rev_range: str, cwd: Path | None = None) -> dict[str, Any]:
    git_log_output = load_git_log(rev_range) if cwd is None else load_git_log_with_cwd(rev_range, cwd)
    return build_matrix_data(git_log_output, rev_range)


def load_git_log_with_cwd(rev_range: str, cwd: Path) -> str:
    cmd = [
        "git",
        "log",
        "--reverse",
        "--name-only",
        "--format=COMMIT\t%h\t%s",
        rev_range,
    ]
    return subprocess.check_output(
        cmd,
        text=True,
        encoding="utf-8",
        errors="replace",
        cwd=str(cwd),
    )


def git_output(repo_dir: Path, *args: str) -> str:
    return subprocess.check_output(
        ["git", *args],
        text=True,
        encoding="utf-8",
        errors="replace",
        cwd=str(repo_dir),
    ).strip()


def resolve_git_dir(repo_dir: Path) -> Path:
    raw_git_dir = git_output(repo_dir, "rev-parse", "--git-dir")
    git_dir = Path(raw_git_dir)
    if not git_dir.is_absolute():
        git_dir = (repo_dir / git_dir).resolve()
    return git_dir


def current_head_sha(repo_dir: Path) -> str:
    return git_output(repo_dir, "rev-parse", "HEAD")


def rebase_in_progress(git_dir: Path) -> bool:
    return (git_dir / "rebase-merge").exists() or (git_dir / "rebase-apply").exists()


def refresh_matrix_json(repo_dir: Path, rev_range: str, out_path: Path) -> str:
    data = load_data_from_git(rev_range, cwd=repo_dir)
    write_data(data, out_path)
    return current_head_sha(repo_dir)


def watch_git_and_refresh(
    repo_dir: Path,
    rev_range: str,
    out_path: Path,
    stop_event: threading.Event,
    poll_interval_s: float = 2.0,
) -> None:
    try:
        git_dir = resolve_git_dir(repo_dir)
        last_head_sha = current_head_sha(repo_dir)
    except subprocess.CalledProcessError as error:
        print(f"Live refresh disabled: unable to read git state ({error}).")
        return

    paused_for_rebase = False

    while not stop_event.wait(poll_interval_s):
        in_rebase = rebase_in_progress(git_dir)
        if in_rebase:
            paused_for_rebase = True
            continue

        should_refresh = False
        try:
            head_sha = current_head_sha(repo_dir)
        except subprocess.CalledProcessError as error:
            print(f"Live refresh warning: unable to read HEAD ({error}).")
            continue

        if paused_for_rebase:
            should_refresh = True
            paused_for_rebase = False
        elif head_sha != last_head_sha:
            should_refresh = True

        if not should_refresh:
            continue

        try:
            last_head_sha = refresh_matrix_json(repo_dir, rev_range, out_path)
            print("Refreshed matrix_data.json")
        except subprocess.CalledProcessError as error:
            print(f"Live refresh warning: failed to regenerate matrix data ({error}).")


def serve_ui(
    data: dict[str, Any],
    rev_range: str,
    host: str,
    port: int,
    open_browser: bool,
    repo_dir: Path,
) -> None:
    with tempfile.TemporaryDirectory(prefix="git-file-matrix-") as temp_dir:
        temp_path = Path(temp_dir)
        copy_bundle_assets(temp_path)
        matrix_data_path = temp_path / "matrix_data.json"
        write_data(data, matrix_data_path)
        url = f"http://{host}:{port}/index.html"

        handler = partial(SimpleHTTPRequestHandler, directory=str(temp_path))
        server = ThreadingHTTPServer((host, port), handler)
        stop_event = threading.Event()
        refresh_thread = threading.Thread(
            target=watch_git_and_refresh,
            args=(repo_dir, rev_range, matrix_data_path, stop_event),
            daemon=True,
        )
        refresh_thread.start()
        print(f"Serving matrix UI at {url}")
        print("Live refresh enabled: updates on HEAD changes (paused during rebase).")
        print("Press Ctrl+C to stop.")

        if open_browser:
            webbrowser.open(url)

        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("\nServer stopped.")
        finally:
            stop_event.set()
            refresh_thread.join(timeout=2.0)
            server.server_close()


def run(args: argparse.Namespace) -> None:
    repo_dir = Path.cwd()
    data = load_data_from_git(args.rev_range, cwd=repo_dir)

    if args.serve:
        if args.out is not None:
            write_data(data, args.out)
        serve_ui(
            data,
            rev_range=args.rev_range,
            host=args.host,
            port=args.port,
            open_browser=args.open_browser,
            repo_dir=repo_dir,
        )
        return

    json_output = render_data_json(data)
    if args.out is None:
        print(json_output)
        return
    write_data(data, args.out)


def main() -> None:
    args = parse_args()
    run(args)


if __name__ == "__main__":
    main()
