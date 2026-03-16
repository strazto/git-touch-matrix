# Git File Matrix

Visualise which files were touched by which commits so you can untangle long branches and spot logical change groups.

Demo: [https://straz.to/git-touch-matrix/](https://straz.to/git-touch-matrix/)

# About

Git File Matrix is a visual tool for understanding how a branch evolved.

Large branches often start cleanly, then grow across dozens of commits and files. Even with decent commit hygiene, it becomes hard to see where one piece of work ends and another begins, especially when later commits revisit earlier architectural changes.

Git File Matrix makes that easier by turning Git history into an interactive file-by-commit matrix.

- **Columns** represent commits
- **Rows** represent files
- **Cells** show when a file was touched by a commit

This makes it much easier to spot related change clusters, follow the spread of a refactor or feature through the codebase, and identify clean boundaries for branch splitting, rebasing, or cherry-picking.

You can use it in two modes:

- **Paste raw `git log` output** into the browser for a fully static workflow
- **Run the local Python server** to generate and refresh matrix data automatically from a repository

Git File Matrix is useful for refactoring, stacked branches, code archaeology, branch cleanup, and any situation where you need to answer: "what actually changed together?"

# Running it yourself

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
