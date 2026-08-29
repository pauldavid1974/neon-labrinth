import type { Snap } from "../game/types";

interface UIProps {
  snap: Snap;
  onStart: () => void;
  onResume: () => void;
  onRestart: () => void;
  onAbandon: () => void;
}

function ControlsGuide({ compact }: { compact?: boolean }) {
  const rows: [string, string][] = [
    ["W A S D", "MOVE / MELEE"],
    ["MOUSE", "AIM"],
    ["LMB", "PLASMA BOLT"],
    ["SPACE", "PHASE DASH"],
    ["R", "VENT — WAIT + ENERGY"],
    ["E", "DESCEND SECTOR"],
    ["ESC", "PAUSE"],
    ["M", "SOUND"],
  ];
  return (
    <div className={`grid gap-x-8 gap-y-1.5 ${compact ? "grid-cols-2" : "grid-cols-1 sm:grid-cols-2"}`}>
      {rows.map(([k, v]) => (
        <div key={k} className="flex items-center gap-3">
          <span className="key-cap min-w-[64px] text-center">{k}</span>
          <span className="text-[13px] tracking-[0.18em] text-cyan-100/70 font-semibold">{v}</span>
        </div>
      ))}
    </div>
  );
}

function Bar({
  value,
  max,
  from,
  to,
  ghost,
  label,
}: {
  value: number;
  max: number;
  from: string;
  to: string;
  ghost?: boolean;
  label: string;
}) {
  const frac = Math.max(0, Math.min(1, value / max));
  return (
    <div className="flex items-center gap-2">
      <span className="font-display text-[10px] tracking-[0.25em] text-cyan-100/60 w-7">{label}</span>
      <div className="bar-shell notch-sm flex-1">
        {ghost && <div className="bar-ghost" style={{ transform: `scaleX(${frac})` }} />}
        <div
          className="bar-fill"
          style={{ transform: `scaleX(${frac})`, background: `linear-gradient(90deg, ${from}, ${to})` }}
        />
        <div className="bar-stripes" />
      </div>
      <span className="font-display text-[11px] text-cyan-50 w-14 text-right tabular-nums">
        {value}
        <span className="text-cyan-100/40">/{max}</span>
      </span>
    </div>
  );
}

function StatChip({ label, value, accent }: { label: string; value: string | number; accent?: boolean }) {
  return (
    <div className="flex flex-col items-start px-3 py-1.5 border-l-2" style={{ borderColor: accent ? "#ff2bd6" : "rgba(0,240,255,0.4)" }}>
      <span className="text-[10px] tracking-[0.3em] text-cyan-100/50 font-semibold">{label}</span>
      <span className={`font-display text-base leading-tight tabular-nums ${accent ? "text-[#ff9df0]" : "text-cyan-50"}`}>
        {value}
      </span>
    </div>
  );
}

export function UI({ snap, onStart, onResume, onRestart, onAbandon }: UIProps) {
  const inGame = snap.state === "playing" || snap.state === "paused" || snap.state === "dying" || snap.state === "transition";
  return (
    <div className="absolute inset-0 pointer-events-none select-none" style={{ zIndex: 40 }}>
      {/* damage vignette pulse */}
      {snap.dmgPulse > 0 && <div key={snap.dmgPulse} className="absolute inset-0 dmg-flash" />}

      {/* ------------------------------------------------ HUD */}
      {inGame && (
        <>
          <div className="absolute top-4 left-4 flex flex-col gap-2 w-[340px] max-w-[44vw]">
            <div className="hud-panel notch px-4 py-3 flex flex-col gap-2">
              <Bar
                label="HP"
                value={snap.hp}
                max={snap.maxHp}
                from={snap.hp / snap.maxHp < 0.3 ? "#ff2244" : "#00f0ff"}
                to={snap.hp / snap.maxHp < 0.3 ? "#ff6b3d" : "#46ffa6"}
                ghost
              />
              <Bar label="EN" value={snap.en} max={snap.maxEn} from="#ff2bd6" to="#ffe14d" />
              <div className="flex items-center justify-between mt-0.5">
                <span className="font-display text-[11px] tracking-[0.2em] text-cyan-200/90">
                  {snap.weapon}
                </span>
                {snap.armor > 0 && (
                  <span className="font-display text-[10px] tracking-[0.15em] text-[#ff9df0]">
                    ARMOR {"▮".repeat(Math.min(8, Math.ceil(snap.armor / 2)))} {snap.armor}
                  </span>
                )}
              </div>
            </div>
            <div className="hud-panel notch-sm px-1 py-1 flex gap-1">
              <StatChip label="SECTOR" value={String(snap.floor).padStart(2, "0")} />
              <StatChip label="KILLS" value={snap.kills} accent />
              <StatChip label="SCORE" value={snap.score.toLocaleString()} />
            </div>
          </div>

          <div className="absolute bottom-3 left-4 text-[11px] tracking-[0.2em] text-cyan-100/35 font-semibold">
            {snap.muted ? "SOUND OFF — [M]" : "SOUND ON — [M]"}
          </div>

          {snap.prompt && (
            <div className="absolute bottom-16 left-1/2 -translate-x-1/2 prompt-pop">
              <div className="hud-panel notch-sm px-6 py-2.5 font-display text-sm tracking-[0.25em] text-[#aef6ff] glow-cyan pulse-soft">
                {snap.prompt}
              </div>
            </div>
          )}

          {snap.banner && (snap.state === "playing" || snap.state === "transition") && (
            <div key={snap.bannerKey} className="absolute top-[22%] left-0 right-0 flex justify-center">
              <div className="banner-anim font-display text-5xl font-800 tracking-[0.3em] text-cyan-50 glow-cyan" style={{ fontWeight: 800 }}>
                {snap.banner}
              </div>
            </div>
          )}
        </>
      )}

      {/* ------------------------------------------------ TITLE */}
      {snap.state === "title" && (
        <div className="absolute inset-0 pointer-events-auto fade-in flex items-center justify-center"
          style={{ background: "radial-gradient(ellipse at 50% 40%, rgba(4,5,12,0.55) 0%, rgba(4,5,12,0.92) 78%)" }}
        >
          <div className="flex flex-col items-center gap-8 px-6">
            <div className="rise-in flex flex-col items-center" style={{ animationDelay: "0.05s" }}>
              <div className="font-display text-[11px] tracking-[0.7em] text-[#ff9df0] glow-magenta mb-3">
                PROCEDURAL DEATH PROTOCOL
              </div>
              <h1 className="title-flicker font-display leading-none text-center">
                <span className="block text-6xl sm:text-7xl font-black tracking-[0.12em] text-cyan-50 glow-cyan">NEON</span>
                <span className="block text-4xl sm:text-5xl font-black tracking-[0.42em] text-[#ff2bd6] glow-magenta mt-2">
                  LABYRINTH
                </span>
              </h1>
              <p className="mt-5 max-w-md text-center text-[15px] font-semibold tracking-[0.08em] text-cyan-100/60 leading-relaxed">
                The sectors regenerate every descent. The machines do not.
                <br />
                <span className="text-cyan-100/85">How deep can you burn?</span>
              </p>
            </div>

            <div className="rise-in flex flex-col items-center gap-5" style={{ animationDelay: "0.18s" }}>
              <button className="neon-btn notch px-12 py-4 text-lg" onClick={onStart}>
                JACK IN
              </button>
              <div className="text-[12px] tracking-[0.3em] text-cyan-100/40 font-semibold">OR PRESS ENTER</div>
            </div>

            <div className="rise-in hud-panel notch px-8 py-5" style={{ animationDelay: "0.3s" }}>
              <div className="font-display text-[11px] tracking-[0.4em] text-cyan-200/80 mb-3 text-center">
                CONTROL INTERFACE
              </div>
              <ControlsGuide />
            </div>

            <div className="rise-in text-[11px] tracking-[0.25em] text-cyan-100/30 font-semibold" style={{ animationDelay: "0.42s" }}>
              PERMADEATH · TURN-BASED TACTICS · INFINITE SECTORS
            </div>
          </div>
        </div>
      )}

      {/* ------------------------------------------------ PAUSE */}
      {snap.state === "paused" && (
        <div className="absolute inset-0 pointer-events-auto fade-in flex items-center justify-center"
          style={{ background: "rgba(3,4,10,0.78)" }}
        >
          <div className="flex flex-col items-center gap-7">
            <h2 className="font-display text-4xl font-black tracking-[0.4em] text-cyan-50 glow-cyan">PAUSED</h2>
            <div className="hud-panel notch px-8 py-5">
              <ControlsGuide compact />
            </div>
            <div className="flex gap-4">
              <button className="neon-btn notch-sm px-8 py-3" onClick={onResume}>
                RESUME
              </button>
              <button className="neon-btn notch-sm px-8 py-3" onClick={onRestart}>
                RESTART
              </button>
              <button className="neon-btn magenta notch-sm px-8 py-3" onClick={onAbandon}>
                ABANDON
              </button>
            </div>
            <div className="text-[12px] tracking-[0.3em] text-cyan-100/40 font-semibold">ESC TO RESUME</div>
          </div>
        </div>
      )}

      {/* ------------------------------------------------ DEATH */}
      {snap.state === "dead" && snap.death && (
        <div className="absolute inset-0 pointer-events-auto fade-in flex items-center justify-center"
          style={{ background: "radial-gradient(ellipse at center, rgba(30,3,12,0.72) 0%, rgba(3,4,10,0.94) 75%)" }}
        >
          <div className="flex flex-col items-center gap-7">
            <div className="rise-in flex flex-col items-center">
              <div className="font-display text-[11px] tracking-[0.6em] text-[#ff9df0] mb-3">SIGNAL LOST</div>
              <h2 className="title-flicker font-display text-6xl font-black tracking-[0.18em] text-[#ff2bd6] glow-magenta">
                FLATLINED
              </h2>
            </div>
            <div className="rise-in hud-panel notch px-10 py-6 grid grid-cols-2 sm:grid-cols-4 gap-x-10 gap-y-4" style={{ animationDelay: "0.15s" }}>
              <div className="flex flex-col">
                <span className="text-[10px] tracking-[0.3em] text-cyan-100/50 font-semibold">SECTOR</span>
                <span className="font-display text-3xl text-cyan-50 tabular-nums">{String(snap.death.floor).padStart(2, "0")}</span>
              </div>
              <div className="flex flex-col">
                <span className="text-[10px] tracking-[0.3em] text-cyan-100/50 font-semibold">KILLS</span>
                <span className="font-display text-3xl text-[#ff9df0] tabular-nums">{snap.death.kills}</span>
              </div>
              <div className="flex flex-col">
                <span className="text-[10px] tracking-[0.3em] text-cyan-100/50 font-semibold">SCORE</span>
                <span className="font-display text-3xl text-cyan-50 tabular-nums">{snap.death.score.toLocaleString()}</span>
              </div>
              <div className="flex flex-col">
                <span className="text-[10px] tracking-[0.3em] text-cyan-100/50 font-semibold">SURVIVED</span>
                <span className="font-display text-3xl text-cyan-50 tabular-nums">{snap.death.time}</span>
              </div>
            </div>
            <div className="rise-in text-[12px] tracking-[0.25em] text-cyan-100/45 font-semibold" style={{ animationDelay: "0.25s" }}>
              FINAL WEAPON — {snap.death.weapon}
            </div>
            <div className="rise-in flex flex-col items-center gap-3" style={{ animationDelay: "0.35s" }}>
              <button className="neon-btn magenta notch px-12 py-4 text-lg" onClick={onRestart}>
                RE-DEPLOY
              </button>
              <div className="text-[12px] tracking-[0.3em] text-cyan-100/40 font-semibold">OR PRESS ENTER</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
