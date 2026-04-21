const { useMemo, useState } = React;
const REFERENCE_EXAMPLE = "7,0,1,2,0,3,0,4,2,3,0,3,0,3,2,1,2,0,1,7,0,1";

function parseReferenceString(value) {
  return value
    .split(/[\s,]+/)
    .map((token) => token.trim().toUpperCase())
    .filter(Boolean)
    .map((token) => {
      const match = token.match(/^(-?\d+)([RW])?$/);
      if (!match) return null;
      return {
        page: Number(match[1]),
        write: match[2] === "W",
      };
    })
    .filter((entry) => entry && Number.isFinite(entry.page));
}

function formatRequest(request) {
  return request.write ? `${request.page}W` : `${request.page}`;
}

function simulateFIFO(reference, frameCount) {
  const frames = Array(frameCount).fill("-");
  const steps = [];
  let pointer = 0;
  let hits = 0;
  let faults = 0;

  reference.forEach((request) => {
    const page = request.page;
    const hit = frames.includes(page);
    if (hit) {
      hits += 1;
    } else {
      faults += 1;
      frames[pointer] = page;
      pointer = (pointer + 1) % frameCount;
    }
    steps.push({ page: formatRequest(request), hit, frames: [...frames] });
  });

  return { steps, hits, faults };
}

function simulateLRU(reference, frameCount) {
  const frames = [];
  const recentUse = new Map();
  const steps = [];
  let hits = 0;
  let faults = 0;

  reference.forEach((request, index) => {
    const page = request.page;
    const hit = frames.includes(page);

    if (hit) {
      hits += 1;
    } else {
      faults += 1;
      if (frames.length < frameCount) {
        frames.push(page);
      } else {
        let lruIndex = 0;
        let minUse = Infinity;
        frames.forEach((p, i) => {
          const last = recentUse.get(p) ?? -1;
          if (last < minUse) {
            minUse = last;
            lruIndex = i;
          }
        });
        frames[lruIndex] = page;
      }
    }

    recentUse.set(page, index);
    const padded = [...frames, ...Array(Math.max(0, frameCount - frames.length)).fill("-")];
    steps.push({ page: formatRequest(request), hit, frames: padded });
  });

  return { steps, hits, faults };
}

function simulateOptimal(reference, frameCount) {
  const frames = [];
  const steps = [];
  let hits = 0;
  let faults = 0;

  reference.forEach((request, currentIndex) => {
    const page = request.page;
    const hit = frames.includes(page);

    if (hit) {
      hits += 1;
    } else {
      faults += 1;
      if (frames.length < frameCount) {
        frames.push(page);
      } else {
        let victimIndex = -1;
        let farthestUse = -1;

        frames.forEach((framePage, i) => {
          const nextUse = reference.slice(currentIndex + 1).findIndex((r) => r.page === framePage);
          if (nextUse === -1) {
            victimIndex = i;
            farthestUse = Infinity;
            return;
          }
          if (nextUse > farthestUse) {
            farthestUse = nextUse;
            victimIndex = i;
          }
        });

        frames[victimIndex] = page;
      }
    }

    const padded = [...frames, ...Array(Math.max(0, frameCount - frames.length)).fill("-")];
    steps.push({ page: formatRequest(request), hit, frames: padded });
  });

  return { steps, hits, faults };
}

function simulateSecondChance(reference, frameCount) {
  const frames = Array(frameCount).fill("-");
  const refBits = Array(frameCount).fill(0);
  const steps = [];
  let pointer = 0;
  let hits = 0;
  let faults = 0;

  reference.forEach((request) => {
    const page = request.page;
    const hitIndex = frames.indexOf(page);
    const hit = hitIndex !== -1;

    if (hit) {
      hits += 1;
      refBits[hitIndex] = 1;
    } else {
      faults += 1;
      while (refBits[pointer] === 1) {
        refBits[pointer] = 0;
        pointer = (pointer + 1) % frameCount;
      }
      frames[pointer] = page;
      refBits[pointer] = 1;
      pointer = (pointer + 1) % frameCount;
    }

    steps.push({ page: formatRequest(request), hit, frames: [...frames] });
  });

  return { steps, hits, faults };
}

function simulateEnhancedSecondChance(reference, frameCount) {
  const frames = Array(frameCount).fill(null);
  const steps = [];
  let pointer = 0;
  let hits = 0;
  let faults = 0;

  function pickVictimIndex() {
    for (let pass = 0; pass < 2; pass += 1) {
      for (let checked = 0; checked < frameCount; checked += 1) {
        const idx = (pointer + checked) % frameCount;
        const item = frames[idx];
        if (!item) return idx;
        if (item.r === 0 && item.m === pass) {
          return idx;
        }
        if (item.r === 1) item.r = 0;
      }
    }
    return pointer;
  }

  reference.forEach((request) => {
    const page = request.page;
    const write = request.write;
    const hitIndex = frames.findIndex((item) => item && item.page === page);
    const hit = hitIndex !== -1;

    if (hit) {
      hits += 1;
      frames[hitIndex].r = 1;
      if (write) frames[hitIndex].m = 1;
    } else {
      faults += 1;
      let idx = frames.findIndex((item) => item === null);
      if (idx === -1) {
        idx = pickVictimIndex();
      }
      frames[idx] = { page, r: 1, m: write ? 1 : 0 };
      pointer = (idx + 1) % frameCount;
    }

    const snapshot = frames.map((item) => (item ? item.page : "-"));
    steps.push({ page: formatRequest(request), hit, frames: snapshot });
  });

  return { steps, hits, faults };
}

function simulatePageBuffering(reference, frameCount, bufferSize) {
  const frames = Array(frameCount).fill("-");
  const buffer = [];
  const steps = [];
  let pointer = 0;
  let hits = 0;
  let faults = 0;
  let bufferHits = 0;
  let diskReads = 0;

  function pushToBuffer(page) {
    if (page === "-" || page === undefined) return;
    if (!buffer.includes(page)) buffer.push(page);
    if (buffer.length > bufferSize) buffer.shift();
  }

  reference.forEach((request) => {
    const page = request.page;
    const hit = frames.includes(page);

    if (hit) {
      hits += 1;
    } else {
      faults += 1;
      const bufIndex = buffer.indexOf(page);
      if (bufIndex !== -1) {
        bufferHits += 1;
        buffer.splice(bufIndex, 1);
      } else {
        diskReads += 1;
      }

      const evicted = frames[pointer];
      frames[pointer] = page;
      pushToBuffer(evicted);
      pointer = (pointer + 1) % frameCount;
    }

    steps.push({ page: formatRequest(request), hit, frames: [...frames] });
  });

  return { steps, hits, faults, extra: { bufferHits, diskReads, bufferSize } };
}

function runSimulation(algorithm, reference, frameCount, bufferSize) {
  if (!reference.length || frameCount <= 0) {
    return { steps: [], hits: 0, faults: 0, extra: null };
  }

  switch (algorithm) {
    case "FIFO":
      return simulateFIFO(reference, frameCount);
    case "LRU":
      return simulateLRU(reference, frameCount);
    case "OPTIMAL":
      return simulateOptimal(reference, frameCount);
    case "SECOND_CHANCE":
      return simulateSecondChance(reference, frameCount);
    case "ENHANCED_SECOND_CHANCE":
      return simulateEnhancedSecondChance(reference, frameCount);
    case "PAGE_BUFFERING":
      return simulatePageBuffering(reference, frameCount, bufferSize);
    default:
      return { steps: [], hits: 0, faults: 0, extra: null };
  }
}

function App() {
  const [algorithm, setAlgorithm] = useState("FIFO");
  const [frameCount, setFrameCount] = useState(3);
  const [bufferSize, setBufferSize] = useState(3);
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState({ steps: [], hits: 0, faults: 0, extra: null });

  const total = result.hits + result.faults;
  const hitRatio = total ? ((result.hits / total) * 100).toFixed(2) : "0.00";
  const faultRatio = total ? ((result.faults / total) * 100).toFixed(2) : "0.00";

  const frameRows = useMemo(() => {
    const rows = [];
    for (let i = 0; i < Number(frameCount); i += 1) {
      rows.push(
        result.steps.map((s) => ({
          value: s.frames[i] !== undefined ? s.frames[i] : "-",
          hit: s.hit,
        }))
      );
    }
    return rows;
  }, [result.steps, frameCount]);
  const referenceLabels = useMemo(() => result.steps.map((s) => s.page), [result.steps]);

  function handleSimulate() {
    if (!algorithm) {
      setError("Algorithm is required.");
      setResult({ steps: [], hits: 0, faults: 0, extra: null });
      return;
    }
    if (!String(input).trim()) {
      setError("Reference string is required.");
      setResult({ steps: [], hits: 0, faults: 0, extra: null });
      return;
    }
    const parsed = parseReferenceString(input);
    if (!parsed.length) {
      setError("Enter a valid reference string (numbers separated by spaces/commas).");
      setResult({ steps: [], hits: 0, faults: 0, extra: null });
      return;
    }
    if (Number(frameCount) < 1 || Number(frameCount) > 10) {
      setError("Frame count must be between 1 and 10.");
      setResult({ steps: [], hits: 0, faults: 0, extra: null });
      return;
    }
    if (algorithm === "PAGE_BUFFERING" && (Number(bufferSize) < 1 || Number(bufferSize) > 10)) {
      setError("Buffer size must be between 1 and 10.");
      setResult({ steps: [], hits: 0, faults: 0, extra: null });
      return;
    }

    setError("");
    setResult(runSimulation(algorithm, parsed, Number(frameCount), Number(bufferSize)));
  }

  function handleReset() {
    setAlgorithm("FIFO");
    setFrameCount(3);
    setBufferSize(3);
    setInput("");
    setError("");
    setResult({ steps: [], hits: 0, faults: 0, extra: null });
  }

  return (
    <div className="container">
      <h1 className="title">Page Replacement Simulator (OS)</h1>
      <p className="subtitle">
        Compare page-fault behavior on first access and re-access with FIFO, LRU, Optimal and advanced variants.
      </p>

      <div className="card">
        <div className="grid">
          <div>
            <label>Algorithm</label>
            <select value={algorithm} onChange={(e) => setAlgorithm(e.target.value)}>
              <option value="FIFO">FIFO</option>
              <option value="LRU">LRU</option>
              <option value="OPTIMAL">Optimal</option>
              <option value="SECOND_CHANCE">Second-Chance</option>
              <option value="ENHANCED_SECOND_CHANCE">Enhanced Second-Chance</option>
              <option value="PAGE_BUFFERING">Page-Buffering</option>
            </select>
          </div>
          <div>
            <label>Number of Frames</label>
            <input
              type="number"
              min="1"
              max="10"
              value={frameCount}
              required
              onChange={(e) => setFrameCount(Number(e.target.value))}
            />
          </div>
          {algorithm === "PAGE_BUFFERING" && (
            <div>
              <label>Buffer Size</label>
              <input
                type="number"
                min="1"
                max="10"
                value={bufferSize}
                required
                onChange={(e) => setBufferSize(Number(e.target.value))}
              />
            </div>
          )}
          <div style={{ gridColumn: "1 / -1" }}>
            <label>Reference String (page numbers only, spaces or commas)</label>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              required
            />
          </div>
        </div>

        <div className="btn-row" style={{ marginTop: "10px" }}>
          <button onClick={handleSimulate}>Run Simulation</button>
          <button className="secondary" onClick={handleReset}>
            Reset
          </button>
        </div>
        {error && <p style={{ color: "#fca5a5", marginBottom: 0 }}>{error}</p>}
      </div>

      <div className="card">
        <div className="stats">
          <div className="stat-box">
            <div>Hits</div>
            <div className="stat-value">{result.hits}</div>
          </div>
          <div className="stat-box">
            <div>Faults</div>
            <div className="stat-value">{result.faults}</div>
          </div>
          <div className="stat-box">
            <div>Hit Ratio</div>
            <div className="stat-value">{hitRatio}%</div>
          </div>
          <div className="stat-box">
            <div>Fault Ratio</div>
            <div className="stat-value">{faultRatio}%</div>
          </div>
          {result.extra && (
            <>
              <div className="stat-box">
                <div>Buffer Hits</div>
                <div className="stat-value">{result.extra.bufferHits}</div>
              </div>
              <div className="stat-box">
                <div>Disk Reads</div>
                <div className="stat-value">{result.extra.diskReads}</div>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="card table-wrap">
        <table className="matrix-table">
          <tbody>
            <tr className="sequence-row">
              <td className="strip-cell strip-head">Initial</td>
              {referenceLabels.map((item, i) => (
                <td key={`ref-strip-${i}`} className="strip-cell">
                  {item}
                </td>
              ))}
            </tr>
            {frameRows.map((row, frameIndex) => (
              <tr key={`frame-${frameIndex}`}>
                <td>-</td>
                {row.map((cell, i) => (
                  <td key={`cell-${frameIndex}-${i}`}>{cell.value}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="fault-note">No. of page fault = {result.faults}</p>
        <table>
          <tbody>
            <tr>
              <td>Status</td>
              {result.steps.map((s, i) => (
                <td key={`status-${i}`} className={s.hit ? "hit" : "fault"}>
                  {s.hit ? "Hit" : "Fault"}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>

      <p className="footer-note">
        Tip: For your class sequence with 3 frames, Optimal should produce the lowest page-fault count.
      </p>
      <p className="credits-note">Done by AFSHEEN FATHIMA AKBAR ALI, AKSHAYA A, BARATHWAJ R</p>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
