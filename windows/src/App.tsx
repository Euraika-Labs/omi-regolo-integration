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

function App() {
  const [health, setHealth] = useState<BackendHealth | null>(null);
  const [status, setStatus] = useState<BackendStatus | null>(null);
  const [greetMsg, setGreetMsg] = useState("");
  const [name, setName] = useState("");

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

  const healthBadge = !health
    ? { text: "checking…", color: "#aaa" }
    : health.reachable
    ? { text: `up (HTTP ${health.status})`, color: "#3c3" }
    : { text: "unreachable", color: "#c33" };

  return (
    <main className="container">
      <h1>Omi for Windows</h1>
      <p style={{ color: "#888", marginTop: "-0.5em" }}>
        Tauri shell · backend hosted as child process
      </p>

      <section
        style={{
          background: "#111",
          color: "#ddd",
          padding: "1em 1.2em",
          borderRadius: 8,
          fontFamily: "Consolas, monospace",
          fontSize: 13,
          textAlign: "left",
          margin: "1em 0",
          lineHeight: 1.5,
        }}
      >
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
          <div style={{ color: "#c66", marginTop: "0.5em" }}>
            err: {health.error}
          </div>
        )}
        {health?.body && (
          <div style={{ marginTop: "0.5em" }}>
            body: <code>{health.body.slice(0, 120)}</code>
          </div>
        )}
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
