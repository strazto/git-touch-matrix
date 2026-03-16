import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";

const STALE_GAP_THRESHOLD = 20;
const POLL_INTERVAL_MS = 4000;

type MatrixCommit = {
  sha: string;
  subject: string;
};

type TouchMap = Record<string, Record<string, boolean>>;

type MatrixData = {
  rev_range: string;
  commits: MatrixCommit[];
  files: string[];
  touches: TouchMap;
};

type SourceMode = "remote" | "manual";

type Row =
  | {
      type: "file";
      path: string;
      parts: string[];
      name: string;
      depth: number;
    }
  | {
      type: "folder";
      path: string;
      parts: string[];
      name: string;
      depth: number;
    };

function getDataPath(): string {
  const params = new URLSearchParams(window.location.search);
  return params.get("data") || "./matrix_data.json";
}

function getFolders(paths: string[]): Set<string> {
  const folders = new Set<string>();
  for (const filePath of paths) {
    const parts = filePath.split("/");
    let current = "";
    for (let i = 0; i < parts.length - 1; i += 1) {
      current += (current ? "/" : "") + parts[i];
      folders.add(current);
    }
  }
  return folders;
}

function buildFolderTouches(data: MatrixData): TouchMap {
  const folderTouches: TouchMap = {};
  for (const commit of data.commits) {
    folderTouches[commit.sha] = {};
    for (const filePath of Object.keys(data.touches[commit.sha] || {})) {
      const parts = filePath.split("/");
      let current = "";
      for (let i = 0; i < parts.length - 1; i += 1) {
        current += (current ? "/" : "") + parts[i];
        folderTouches[commit.sha][current] = true;
      }
    }
  }
  return folderTouches;
}

function buildTouchIndexes(
  paths: string[],
  commits: MatrixCommit[],
  touchesByCommit: TouchMap,
): Record<string, number[]> {
  const byPath: Record<string, number[]> = {};
  for (const path of paths) {
    const indexes: number[] = [];
    for (let index = 0; index < commits.length; index += 1) {
      const commit = commits[index];
      if (touchesByCommit[commit.sha]?.[path]) {
        indexes.push(index);
      }
    }
    byPath[path] = indexes;
  }
  return byPath;
}

function findPrevAndNextHit(
  indexes: number[],
  commitIndex: number,
): { prev: number | null; next: number | null } {
  let prev: number | null = null;
  let next: number | null = null;
  for (let i = 0; i < indexes.length; i += 1) {
    const value = indexes[i];
    if (value < commitIndex) {
      prev = value;
      continue;
    }
    if (value > commitIndex) {
      next = value;
    }
    break;
  }
  return { prev, next };
}

function buildPreHitHints(
  touchIndexesByPath: Record<string, number[]>,
): Record<string, Record<number, number>> {
  const hintsByPath: Record<string, Record<number, number>> = {};
  for (const [path, indexes] of Object.entries(touchIndexesByPath)) {
    const hints: Record<number, number> = {};
    for (let i = 0; i < indexes.length; i += 1) {
      const hitIndex = indexes[i];
      const prevHitIndex = i === 0 ? null : indexes[i - 1];
      const untouchedCount =
        prevHitIndex === null ? hitIndex : Math.max(0, hitIndex - prevHitIndex - 1);
      if (untouchedCount > STALE_GAP_THRESHOLD && hitIndex > 0) {
        hints[hitIndex - 1] = untouchedCount;
      }
    }
    hintsByPath[path] = hints;
  }
  return hintsByPath;
}

function buildVisibleRows(dataFiles: string[], collapsedFolders: Set<string>): Row[] {
  const folders = getFolders(dataFiles);
  const allNodes: Array<{ type: "file" | "folder"; path: string; parts: string[] }> = [];

  for (const filePath of dataFiles) {
    allNodes.push({ type: "file", path: filePath, parts: filePath.split("/") });
  }
  for (const folderPath of folders) {
    allNodes.push({ type: "folder", path: folderPath, parts: folderPath.split("/") });
  }

  allNodes.sort((a, b) => {
    const minLen = Math.min(a.parts.length, b.parts.length);
    for (let i = 0; i < minLen; i += 1) {
      if (a.parts[i] !== b.parts[i]) {
        return a.parts[i].localeCompare(b.parts[i]);
      }
    }
    if (a.type !== b.type) {
      return a.type === "folder" ? -1 : 1;
    }
    return a.parts.length - b.parts.length;
  });

  const visibleRows: Row[] = [];
  const collapsedStack: string[] = [];
  for (const node of allNodes) {
    while (
      collapsedStack.length > 0 &&
      !node.path.startsWith(`${collapsedStack[collapsedStack.length - 1]}/`)
    ) {
      collapsedStack.pop();
    }

    if (collapsedStack.length > 0) {
      continue;
    }

    const depth = node.parts.length - 1;
    const name = node.parts[node.parts.length - 1];
    visibleRows.push({ ...node, name, depth } as Row);

    if (node.type === "folder" && collapsedFolders.has(node.path)) {
      collapsedStack.push(node.path);
    }
  }

  return visibleRows;
}

function Matrix({ data }: { data: MatrixData }) {
  const [sortMode, setSortMode] = useState<"tree" | "alphabetical" | "chronological">("tree");
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());
  const [showFreshness, setShowFreshness] = useState(true);

  const folderTouches = useMemo(() => buildFolderTouches(data), [data]);
  const allFolders = useMemo(() => getFolders(data.files), [data.files]);
  const fileTouchIndexes = useMemo(
    () => buildTouchIndexes(data.files, data.commits, data.touches),
    [data.commits, data.files, data.touches],
  );
  const folderTouchIndexes = useMemo(
    () => buildTouchIndexes([...allFolders], data.commits, folderTouches),
    [allFolders, data.commits, folderTouches],
  );
  const preHitHints = useMemo(() => buildPreHitHints(fileTouchIndexes), [fileTouchIndexes]);
  const folderPreHitHints = useMemo(
    () => buildPreHitHints(folderTouchIndexes),
    [folderTouchIndexes],
  );

  const rows = useMemo(() => {
    if (sortMode === "chronological") {
      return data.files.map(
        (path) => ({ type: "file", path, parts: [path], name: path, depth: 0 }) as Row,
      );
    }
    if (sortMode === "alphabetical") {
      return [...data.files]
        .sort((a, b) => a.localeCompare(b))
        .map((path) => ({ type: "file", path, parts: [path], name: path, depth: 0 }) as Row);
    }
    return buildVisibleRows(data.files, collapsedFolders);
  }, [data.files, collapsedFolders, sortMode]);

  const toggleFolder = (folderPath: string): void => {
    const next = new Set(collapsedFolders);
    if (next.has(folderPath)) {
      next.delete(folderPath);
    } else {
      next.add(folderPath);
    }
    setCollapsedFolders(next);
  };

  return (
    <div>
      <h1>Git file/commit matrix</h1>
      <p>Range: {data.rev_range}</p>
      <div className="controls">
        <label htmlFor="sort-mode">Sort by:</label>
        <select
          id="sort-mode"
          value={sortMode}
          onChange={(e) =>
            setSortMode(e.currentTarget.value as "tree" | "alphabetical" | "chronological")
          }
        >
          <option value="tree">Tree</option>
          <option value="alphabetical">Path (Alphabetical)</option>
          <option value="chronological">Chronological (Appearance)</option>
        </select>
        <label className="toggle">
          <input
            type="checkbox"
            checked={showFreshness}
            onChange={(e) => setShowFreshness(e.currentTarget.checked)}
          />
          Freshness shading
        </label>
        {sortMode === "tree" && (
          <>
            <button onClick={() => setCollapsedFolders(new Set())}>Expand All</button>
            <button onClick={() => setCollapsedFolders(new Set(allFolders))}>Collapse All</button>
          </>
        )}
      </div>
      <div className="legend" aria-label="Matrix legend">
        <span className="legend-item">
          <span className="legend-swatch legend-hit"></span>
          <span>File hit</span>
        </span>
        <span className="legend-item">
          <span className="legend-swatch legend-folder-thin"></span>
          <span>Folder line (expanded)</span>
        </span>
        <span className="legend-item">
          <span className="legend-swatch legend-hit"></span>
          <span>Folder hit (collapsed)</span>
        </span>
        <span className="legend-item">
          <span className="legend-swatch legend-outside"></span>
          <span>Before first / after last touch</span>
        </span>
        <span className="legend-item">
          <span className="legend-swatch legend-fresh"></span>
          <span>Freshness gap (between touches)</span>
        </span>
      </div>
      <table>
        <thead>
          <tr>
            <th className="file-header">File</th>
            {data.commits.map((commit) => (
              <th key={commit.sha} className="rotate" title={`${commit.sha} ${commit.subject}`}>
                {commit.sha}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            if (row.type === "folder") {
              const isCollapsed = collapsedFolders.has(row.path);
              return (
                <tr key={row.path}>
                  <td
                    className="file folder"
                    onClick={() => toggleFolder(row.path)}
                    style={{ paddingLeft: `${row.depth * 16 + 6}px` }}
                  >
                    <span className="folder-icon">{isCollapsed ? "▶" : "▼"}</span>
                    <span className="file-name">{row.name}/</span>
                  </td>
                  {data.commits.map((commit, commitIndex) => {
                    const hit = Boolean(folderTouches[commit.sha][row.path]);
                    const indexes = folderTouchIndexes[row.path] || [];
                    const classes = [isCollapsed && hit ? "hit" : "miss"];
                    const styles: Record<string, string> = {};
                    const untouchedCount = folderPreHitHints[row.path]?.[commitIndex] || null;
                    let isOutsideRange = false;
                    let freshAlpha: number | null = null;

                    if (!hit && indexes.length > 0) {
                      if (commitIndex < indexes[0] || commitIndex > indexes[indexes.length - 1]) {
                        classes.push("outside-range");
                        isOutsideRange = true;
                      } else if (showFreshness) {
                        const { prev, next } = findPrevAndNextHit(indexes, commitIndex);
                        if (prev !== null && next !== null) {
                          const age = commitIndex - prev;
                          const alpha = Math.min(0.36, 0.06 + age * 0.0135);
                          styles["--fresh-alpha"] = alpha.toFixed(3);
                          classes.push("fresh-gap");
                          freshAlpha = alpha;
                        }
                      }
                    }

                    if (isCollapsed) {
                      if (untouchedCount !== null) {
                        classes.push("pre-hit-anchor");
                      }
                    } else {
                      classes.push("folder-expanded-cell");
                      if (hit) {
                        styles["--folder-line-color"] = "var(--hit-fill)";
                      } else if (isOutsideRange) {
                        styles["--folder-line-color"] = "var(--range-gray)";
                      } else if (freshAlpha !== null) {
                        const lineAlpha = Math.min(0.75, freshAlpha + 0.25);
                        styles["--folder-line-color"] = `rgba(var(--fresh-rgb), ${lineAlpha.toFixed(3)})`;
                      } else {
                        styles["--folder-line-color"] = "var(--folder-line-neutral)";
                      }
                      if (untouchedCount !== null) {
                        classes.push("pre-hit-anchor");
                      }
                    }

                    return (
                      <td
                        key={commit.sha}
                        className={classes.join(" ")}
                        style={styles as JSX.CSSProperties}
                      >
                        {untouchedCount !== null ? (
                          <span className="pre-hit-label">
                            {untouchedCount} commits · {row.name}/
                          </span>
                        ) : null}
                      </td>
                    );
                  })}
                </tr>
              );
            }

            return (
              <tr key={row.path}>
                <td
                  className="file"
                  style={{
                    paddingLeft: sortMode === "tree" ? `${row.depth * 16 + 20}px` : "6px",
                  }}
                  title={row.path}
                >
                  <span className="file-name">{row.name}</span>
                </td>
                {data.commits.map((commit, commitIndex) => {
                  const hit = Boolean(data.touches[commit.sha]?.[row.path]);
                  const indexes = fileTouchIndexes[row.path] || [];
                  const classes = [hit ? "hit" : "miss"];
                  const styles: Record<string, string> = {};
                  const untouchedCount = preHitHints[row.path]?.[commitIndex] || null;

                  if (!hit && indexes.length > 0) {
                    if (commitIndex < indexes[0] || commitIndex > indexes[indexes.length - 1]) {
                      classes.push("outside-range");
                    } else if (showFreshness) {
                      const { prev, next } = findPrevAndNextHit(indexes, commitIndex);
                      if (prev !== null && next !== null) {
                        const age = commitIndex - prev;
                        const alpha = Math.min(0.36, 0.06 + age * 0.0135);
                        styles["--fresh-alpha"] = alpha.toFixed(3);
                        classes.push("fresh-gap");
                      }
                    }
                  }
                  if (untouchedCount !== null) {
                    classes.push("pre-hit-anchor");
                  }
                  return (
                    <td
                      key={commit.sha}
                      className={classes.join(" ")}
                      style={styles as JSX.CSSProperties}
                    >
                      {untouchedCount !== null ? (
                        <span className="pre-hit-label">
                          {untouchedCount} commits · {row.name}
                        </span>
                      ) : null}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

async function loadData(): Promise<MatrixData> {
  const path = getDataPath();
  const separator = path.includes("?") ? "&" : "?";
  const requestPath = `${path}${separator}_ts=${Date.now().toString()}`;
  const response = await fetch(requestPath, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Failed to load matrix data from ${path} (${response.status})`);
  }
  return (await response.json()) as MatrixData;
}

function parseRawGitLog(raw: string, revRange: string): MatrixData {
  const commits: Array<{ sha: string; subject: string; files: string[] }> = [];
  let current: { sha: string; subject: string; files: string[] } | null = null;

  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("COMMIT\t")) {
      const [marker, sha, ...subjectParts] = line.split("\t");
      if (!marker || !sha) {
        throw new Error("Invalid COMMIT line in pasted git log output.");
      }
      current = { sha, subject: subjectParts.join("\t"), files: [] };
      commits.push(current);
      continue;
    }

    const filePath = line.trim();
    if (!filePath || current === null) {
      continue;
    }
    current.files.push(filePath);
  }

  if (commits.length === 0) {
    throw new Error(
      "No commits found. Paste output generated with: git log --reverse --name-only --format=COMMIT\\t%h\\t%s <rev_range>",
    );
  }

  const files: string[] = [];
  const seen = new Set<string>();
  for (const commit of commits) {
    for (const filePath of commit.files) {
      if (!seen.has(filePath)) {
        seen.add(filePath);
        files.push(filePath);
      }
    }
  }

  const touches: TouchMap = {};
  for (const commit of commits) {
    touches[commit.sha] = {};
    for (const filePath of commit.files) {
      touches[commit.sha][filePath] = true;
    }
  }

  return {
    rev_range: revRange.trim() || "manual-input",
    commits: commits.map(({ sha, subject }) => ({ sha, subject })),
    files,
    touches,
  };
}

function matrixSignature(data: MatrixData): string {
  return JSON.stringify(data);
}

function DataInputPanel({
  dataPath,
  remoteLoading,
  remoteAvailable,
  remoteMessage,
  collapsed,
  onToggleCollapsed,
  sourceMode,
  onUseRemote,
  manualRevRange,
  onManualRevRangeChange,
  manualInput,
  onManualInputChange,
  onSubmitManual,
  manualError,
}: {
  dataPath: string;
  remoteLoading: boolean;
  remoteAvailable: boolean;
  remoteMessage: string | null;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  sourceMode: SourceMode;
  onUseRemote: () => void;
  manualRevRange: string;
  onManualRevRangeChange: (value: string) => void;
  manualInput: string;
  onManualInputChange: (value: string) => void;
  onSubmitManual: () => void;
  manualError: string | null;
}) {
  const command = `git log --reverse --name-only --format=COMMIT\\t%h\\t%s ${
    manualRevRange.trim() || "<rev_range>"
  }`;

  return (
    <section className="data-input-panel">
      <div className="data-input-header">
        <h2>Data source</h2>
        <button onClick={onToggleCollapsed}>{collapsed ? "Show" : "Hide"}</button>
      </div>
      <p className="data-source-status">
        {remoteLoading
          ? `Checking served data at ${dataPath}...`
          : remoteAvailable
            ? `Served data found at ${dataPath}.`
            : `No served data found at ${dataPath}.`}
      </p>
      {!collapsed ? (
        <>
          <p>
            Paste raw git log output below. If entered, pasted data takes precedence over served{" "}
            <code>matrix_data.json</code>.
          </p>
          {remoteMessage ? <p className="error">{remoteMessage}</p> : null}
          <div className="manual-input-controls">
            <label htmlFor="manual-rev-range">Revision range label</label>
            <input
              id="manual-rev-range"
              type="text"
              value={manualRevRange}
              onInput={(e) => onManualRevRangeChange(e.currentTarget.value)}
              placeholder="origin/main..HEAD"
            />
          </div>
          <p className="command-hint">
            Expected command: <code>{command}</code>
          </p>
          <textarea
            className="manual-data-input"
            value={manualInput}
            onInput={(e) => onManualInputChange(e.currentTarget.value)}
            placeholder="Paste command output here..."
            rows={8}
          />
          <div className="manual-actions">
            <button onClick={onSubmitManual}>Load pasted data</button>
            <button onClick={onUseRemote} disabled={!remoteAvailable || sourceMode === "remote"}>
              Use served data
            </button>
          </div>
        </>
      ) : null}
      {sourceMode === "manual" ? <p className="mode-pill">Using pasted data</p> : null}
      {manualError ? <p className="error">{manualError}</p> : null}
    </section>
  );
}

export default function App() {
  const path = getDataPath();
  const [remoteData, setRemoteData] = useState<MatrixData | null>(null);
  const [remoteLoading, setRemoteLoading] = useState(true);
  const [remoteMessage, setRemoteMessage] = useState<string | null>(null);
  const [sourceMode, setSourceMode] = useState<SourceMode>("remote");
  const [manualRevRange, setManualRevRange] = useState("origin/main..HEAD");
  const [manualInput, setManualInput] = useState("");
  const [manualData, setManualData] = useState<MatrixData | null>(null);
  const [manualError, setManualError] = useState<string | null>(null);
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const remoteSignatureRef = useRef<string | null>(null);
  const autoCollapsedForRemoteRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    const refresh = async (isInitial: boolean): Promise<void> => {
      try {
        const data = await loadData();
        const nextSignature = matrixSignature(data);
        if (nextSignature !== remoteSignatureRef.current) {
          remoteSignatureRef.current = nextSignature;
          if (!cancelled) {
            setRemoteData(data);
          }
        }
        if (!cancelled) {
          setRemoteMessage(null);
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        if (!cancelled) {
          setRemoteMessage(message);
        }
      } finally {
        if (isInitial && !cancelled) {
          setRemoteLoading(false);
        }
      }
    };

    void refresh(true);
    const intervalId = window.setInterval(() => {
      void refresh(false);
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    if (!autoCollapsedForRemoteRef.current && remoteData !== null) {
      setPanelCollapsed(true);
      autoCollapsedForRemoteRef.current = true;
    }
  }, [remoteData]);

  const activeData = sourceMode === "manual" ? manualData : remoteData;

  const handleManualSubmit = (): void => {
    setManualError(null);
    try {
      const parsed = parseRawGitLog(manualInput, manualRevRange);
      setManualData(parsed);
      setSourceMode("manual");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      setManualError(message);
    }
  };

  return (
    <div>
      <DataInputPanel
        dataPath={path}
        remoteLoading={remoteLoading}
        remoteAvailable={remoteData !== null}
        remoteMessage={remoteMessage}
        collapsed={panelCollapsed}
        onToggleCollapsed={() => setPanelCollapsed((value) => !value)}
        sourceMode={sourceMode}
        onUseRemote={() => setSourceMode("remote")}
        manualRevRange={manualRevRange}
        onManualRevRangeChange={setManualRevRange}
        manualInput={manualInput}
        onManualInputChange={setManualInput}
        onSubmitManual={handleManualSubmit}
        manualError={manualError}
      />
      {activeData ? (
        <Matrix data={activeData} />
      ) : (
        <p>No data loaded yet. Paste raw git log output or provide served matrix data.</p>
      )}
    </div>
  );
}
