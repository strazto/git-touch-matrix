# Git File Matrix

`git_file_matrix.py` generates file/commit matrix data from `git log` and can serve an interactive UI.

## Build the web UI

```bash
cd git_file_matrix/web
npm install
npm run build
```

This produces static assets in `git_file_matrix/web/dist`.

## Generate JSON

```bash
python3 git_file_matrix/git_file_matrix.py origin/main..HEAD --out git_file_matrix/matrix_data.json
```

Without `--out`, JSON is written to stdout.

## Generate + serve UI

```bash
python3 git_file_matrix/git_file_matrix.py origin/main..HEAD --serve
```

Optional flags:

- `--host 127.0.0.1`
- `--port 8765`
- `--open-browser`

If assets are not built, the script prints an instruction to run the web build.

While serving, `matrix_data.json` is refreshed automatically when `HEAD` changes.
During an active rebase, refresh is paused to avoid noisy churn, then refreshed once after rebase completes.

## Frontend-only development loop

Terminal 1:

```bash
python3 git_file_matrix/git_file_matrix.py origin/main..HEAD --out git_file_matrix/web/public/matrix_data.json
```

Terminal 2:

```bash
cd git_file_matrix/web
npm run dev
```

Open the dev URL from Vite. The app loads `./matrix_data.json` by default.

You can override the data path with `?data=...`, for example:

`http://localhost:5173/?data=./matrix_data.json`

## Static demo mode (no served JSON)

The UI always shows a data input panel.
If `matrix_data.json` is unavailable (for example on static hosting like GitHub Pages), paste raw output from:

```bash
git log --reverse --name-only --format=COMMIT\t%h\t%s origin/main..HEAD
```

Click **Load pasted data** to parse and render the matrix entirely in-browser.
