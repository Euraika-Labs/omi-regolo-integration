import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

type BackendHealth = {
  reachable: boolean;
  status: number | null;
  body: string | null;
  error: string | null;
};

type BackendStatus = {
  spawned: boolean;
  pid: number | null;
  exited: boolean;
  exit_code: number | null;
};

const POLL_MS = 1500;
const PROVIDERS = ["regolo", "claude", "openai", "gemini"] as const;
type Provider = (typeof PROVIDERS)[number];

const consoleStyle = {
  background: "#111",
  color: "#ddd",
  padding: "1em 1.2em",
  borderRadius: 8,
  fontFamily: "Consolas, monospace",
  fontSize: 13,
  textAlign: "left" as const,
  margin: "1em 0",
  lineHeight: 1.5,
};

function maskKey(v: string): string {
  if (v.length <= 10) return "•".repeat(v.length);
  return `${v.slice(0, 4)}…${"•".repeat(v.length - 8)}…${v.slice(-4)}`;
}

function App() {
  const [health, setHealth] = useState<BackendHealth | null>(null);
  const [status, setStatus] = useState<BackendStatus | null>(null);
  const [greetMsg, setGreetMsg] = useState("");
  const [name, setName] = useState("");

  // BYOK panel state
  const [provider, setProvider] = useState<Provider>("regolo");
  const [byokInput, setByokInput] = useState("");
  const [byokDisplay, setByokDisplay] = useState<string | null>(null);
  const [byokMsg, setByokMsg] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      while (!cancelled) {
        try {
          const [h, s] = await Promise.all([
            invoke<BackendHealth>("get_backend_health"),
            invoke<BackendStatus>("get_backend_status"),
          ]);
          if (!cancelled) {
            setHealth(h);
            setStatus(s);
          }
        } catch (e) {
          console.error("poll err:", e);
        }
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
    }
    poll();
    return () => {
      cancelled = true;
    };
  }, []);

  async function greet() {
    setGreetMsg(await invoke<string>("greet", { name }));
  }

  async function byokSave() {
    setByokMsg("saving…");
    try {
      await invoke("set_byok_key", { provider, value: byokInput });
      setByokMsg(`saved ${byokInput.length}-byte key for ${provider}`);
      setByokInput("");
    } catch (e) {
      setByokMsg(`save failed: ${e}`);
    }
  }

  async function byokLoad() {
    setByokMsg("loading…");
    try {
      const v = await invoke<string | null>("get_byok_key", { provider });
      if (v == null) {
        setByokDisplay(null);
        setByokMsg(`no key stored for ${provider}`);
      } else {
        setByokDisplay(maskKey(v));
        setByokMsg(`loaded ${v.length}-byte key for ${provider}`);
      }
    } catch (e) {
      setByokMsg(`load failed: ${e}`);
    }
  }

  async function byokDelete() {
    setByokMsg("deleting…");
    try {
      await invoke("delete_byok_key", { provider });
      setByokDisplay(null);
      setByokMsg(`deleted key for ${provider}`);
    } catch (e) {
      setByokMsg(`delete failed: ${e}`);
    }
  }

  const healthBadge = !health
    ? { text: "checking…", color: "#aaa" }
    : health.reachable
    ? { text: `up (HTTP ${health.status})`, color: "#3c3" }
    : { text: "unreachable", color: "#c33" };

  return (
    <main className="container">
      <h1>Omi for Windows</h1>
      <p style={{ color: "#888", marginTop: "-0.5em" }}>
        Tauri shell · backend hosted as child process · BYOK in Credential Manager
      </p>

      <section style={consoleStyle}>
        <div>
          backend health:{" "}
          <span style={{ color: healthBadge.color, fontWeight: 600 }}>
            {healthBadge.text}
          </span>
        </div>
        <div>
          process:{" "}
          {status?.spawned
            ? status.exited
              ? `exited (code ${status.exit_code ?? "?"})`
              : `running (pid ${status.pid ?? "?"})`
            : "not spawned"}
        </div>
        {health?.error && (
          <div style={{ color: "#c66", marginTop: "0.5em" }}>err: {health.error}</div>
        )}
        {health?.body && (
          <div style={{ marginTop: "0.5em" }}>
            body: <code>{health.body.slice(0, 120)}</code>
          </div>
        )}
      </section>

      <section style={consoleStyle}>
        <div style={{ fontWeight: 600, marginBottom: "0.5em" }}>
          BYOK key storage (Windows Credential Manager)
        </div>
        <div className="row" style={{ gap: "0.5em", marginBottom: "0.5em" }}>
          <label>
            provider:{" "}
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value as Provider)}
            >
              {PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="row" style={{ gap: "0.5em", marginBottom: "0.5em" }}>
          <input
            type="password"
            placeholder="paste key…"
            value={byokInput}
            onChange={(e) => setByokInput(e.target.value)}
            style={{ flex: 1 }}
          />
          <button type="button" onClick={byokSave} disabled={!byokInput}>
            save
          </button>
          <button type="button" onClick={byokLoad}>
            load
          </button>
          <button type="button" onClick={byokDelete}>
            delete
          </button>
        </div>
        {byokDisplay && (
          <div style={{ fontFamily: "monospace" }}>stored: {byokDisplay}</div>
        )}
        <div style={{ marginTop: "0.5em", color: "#9ad" }}>{byokMsg}</div>
      </section>

      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          greet();
        }}
      >
        <input
          id="greet-input"
          onChange={(e) => setName(e.currentTarget.value)}
          placeholder="Enter a name…"
        />
        <button type="submit">Greet (stub)</button>
      </form>
      <p>{greetMsg}</p>
    </main>
  );
}

export default App;
