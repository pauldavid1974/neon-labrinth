import { useState, useEffect } from "react";
import type { Snap } from "../game/types";

interface UIProps {
  snap: Snap;
  onStart: () => void;
  onResume: () => void;
  onRestart: () => void;
  onAbandon: () => void;
  onMove?: (dx: number, dy: number) => void;
  onAction?: (action: "shoot" | "dash" | "ability" | "wait" | "descend") => void;
  onToggleSound?: () => void;
}

function ControlsGuide({ compact }: { compact?: boolean }) {
  const rows: [string, string][] = [
    ["W A S D", "MOVE / MELEE"],
    ["MOUSE", "AIM"],
    ["LMB", "PLASMA BOLT"],
    ["SPACE", "PHASE DASH"],
    ["Q / F", "EMP SHOCKWAVE"],
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

function StatChip({ label, value, sub, accent }: { label: string; value: string | number; sub?: string; accent?: boolean }) {
  return (
    <div className="flex flex-col items-start px-3 py-1.5 border-l-2 flex-1 min-w-0" style={{ borderColor: accent ? "#ff2bd6" : "rgba(0,240,255,0.4)" }}>
      <span className="text-[10px] tracking-[0.3em] text-cyan-100/50 font-semibold">{label}</span>
      <span className={`font-display text-base leading-tight tabular-nums truncate w-full ${accent ? "text-[#ff9df0]" : "text-cyan-50"}`}>
        {value}
      </span>
      {sub && <span className="text-[9px] tracking-[0.1em] text-cyan-200/60 truncate w-full">{sub}</span>}
    </div>
  );
}

function TouchControls({
  snap,
  onMove,
  onAction,
}: {
  snap: Snap;
  onMove?: (dx: number, dy: number) => void;
  onAction?: (action: "shoot" | "dash" | "ability" | "wait" | "descend") => void;
}) {
  const haptic = () => {
    try {
      if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate(15);
    } catch {}
  };

  const handleMove = (dx: number, dy: number) => {
    haptic();
    onMove?.(dx, dy);
  };

  const handleAction = (act: "shoot" | "dash" | "ability" | "wait" | "descend") => {
    haptic();
    onAction?.(act);
  };

  return (
    <div className="absolute inset-0 pointer-events-none z-30 flex items-end justify-between p-3 sm:p-6 select-none">
      {/* Left: D-PAD */}
      <div className="pointer-events-auto flex flex-col items-center gap-1.5 pb-2" onPointerDown={(e) => e.stopPropagation()}>
        <button
          className="touch-btn notch-sm w-14 h-14 text-xl font-bold"
          onClick={() => handleMove(0, -1)}
          aria-label="Up"
        >
          ▲
        </button>
        <div className="flex items-center gap-1.5">
          <button
            className="touch-btn notch-sm w-14 h-14 text-xl font-bold"
            onClick={() => handleMove(-1, 0)}
            aria-label="Left"
          >
            ◀
          </button>
          <button
            className="touch-btn amber notch-sm w-14 h-14 text-[10px] tracking-[0.1em] font-bold"
            onClick={() => handleAction("wait")}
            aria-label="Vent"
          >
            VENT
          </button>
          <button
            className="touch-btn notch-sm w-14 h-14 text-xl font-bold"
            onClick={() => handleMove(1, 0)}
            aria-label="Right"
          >
            ▶
          </button>
        </div>
        <button
          className="touch-btn notch-sm w-14 h-14 text-xl font-bold"
          onClick={() => handleMove(0, 1)}
          aria-label="Down"
        >
          ▼
        </button>
      </div>

      {/* Right: ACTION DIAMOND */}
      <div className="pointer-events-auto flex flex-col items-end gap-2 pb-2" onPointerDown={(e) => e.stopPropagation()}>
        {/* Stairs button when prompt active */}
        {snap.prompt && (
          <button
            className="touch-btn magenta notch-sm w-full py-2.5 px-4 mb-1 text-xs font-bold tracking-[0.2em] pulse-soft flex items-center justify-center gap-2"
            onClick={() => handleAction("descend")}
          >
            <span>DESCEND ⬇</span>
          </button>
        )}

        <div className="grid grid-cols-2 gap-2">
          <button
            className="touch-btn magenta notch w-16 h-16 text-[11px] font-black tracking-[0.1em] flex flex-col items-center justify-center leading-tight"
            onClick={() => handleAction("ability")}
            disabled={snap.abilityCd > 0}
            style={{ opacity: snap.abilityCd > 0 ? 0.45 : 1 }}
          >
            <span>EMP</span>
            <span className="text-[8px] opacity-80 tabular-nums">
              {snap.abilityCd > 0 ? `${snap.abilityCd.toFixed(1)}s` : "READY"}
            </span>
          </button>

          <button
            className="touch-btn amber notch w-16 h-16 text-[11px] font-black tracking-[0.1em] flex flex-col items-center justify-center leading-tight"
            onClick={() => handleAction("dash")}
          >
            <span>DASH</span>
            <span className="text-[8px] opacity-80">PHASE</span>
          </button>
        </div>

        {/* FIRE BUTTON - PRIMARY */}
        <button
          className="touch-btn notch w-[138px] h-16 text-base font-black tracking-[0.25em] bg-cyan-500/20 border-cyan-400 text-cyan-100 shadow-[0_0_24px_rgba(0,240,255,0.35)]"
          onClick={() => handleAction("shoot")}
        >
          🎯 FIRE
        </button>
      </div>
    </div>
  );
}

export function UI({
  snap,
  onStart,
  onResume,
  onRestart,
  onAbandon,
  onMove,
  onAction,
  onToggleSound,
}: UIProps) {
  const [showTouch, setShowTouch] = useState<boolean>(() => {
    try {
      return (
        "ontouchstart" in window ||
        (typeof navigator !== "undefined" && navigator.maxTouchPoints > 0)
      );
    } catch {
      return false;
    }
  });

  const inGame =
    snap.state === "playing" ||
    snap.state === "paused" ||
    snap.state === "dying" ||
    snap.state === "transition";

  return (
    <div className="absolute inset-0 pointer-events-none select-none" style={{ zIndex: 40 }}>
      {/* damage vignette pulse */}
      {snap.dmgPulse > 0 && <div key={snap.dmgPulse} className="absolute inset-0 dmg-flash" />}

      {/* ------------------------------------------------ HUD */}
      {inGame && (
        <>
          <div className="absolute top-4 left-4 flex flex-col gap-2 w-[340px] max-w-[44vw] pointer-events-auto">
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
              <div className="flex items-center justify-between pt-1 border-t border-cyan-500/20 text-[10px] tracking-[0.15em]">
                <div className="flex items-center gap-1.5">
                  <span className="key-cap text-[9px] px-1 py-0.5 min-w-0">Q</span>
                  <span className={snap.abilityCd > 0 ? "text-cyan-100/40" : "text-[#46ffa6] font-semibold"}>
                    EMP {snap.abilityCd > 0 ? `(${snap.abilityCd.toFixed(1)}s)` : "READY"}
                  </span>
                </div>
                {snap.relics.length > 0 && (
                  <span className="text-[#ff9df0] font-semibold truncate max-w-[150px]">
                    ★ {snap.relics.length} RELIC{snap.relics.length > 1 ? "S" : ""}
                  </span>
                )}
              </div>
            </div>
            <div className="hud-panel notch-sm px-1 py-1 flex gap-1">
              <StatChip label="SECTOR" value={String(snap.floor).padStart(2, "0")} sub={snap.biomeName} />
              <StatChip label="KILLS" value={snap.kills} accent />
              <StatChip label="SCORE" value={snap.score.toLocaleString()} />
            </div>
          </div>

          {/* Bottom Toolbar */}
          <div className="absolute bottom-3 left-4 flex items-center gap-3 pointer-events-auto">
            <button
              onClick={onToggleSound}
              className="text-[11px] tracking-[0.2em] text-cyan-100/60 hover:text-cyan-100 font-semibold px-2.5 py-1 rounded bg-black/40 border border-cyan-500/30 transition-colors"
            >
              {snap.muted ? "🔇 SOUND OFF" : "🔊 SOUND ON"}
            </button>

            <button
              onClick={() => setShowTouch((prev) => !prev)}
              className={`text-[11px] tracking-[0.2em] font-semibold px-2.5 py-1 rounded border transition-colors ${
                showTouch
                  ? "bg-cyan-500/20 text-cyan-200 border-cyan-400"
                  : "bg-black/40 text-cyan-100/50 border-cyan-500/20"
              }`}
            >
              TOUCH {showTouch ? "ON" : "OFF"}
            </button>
          </div>

          {/* Active Touch Controls */}
          {showTouch && snap.state === "playing" && (
            <TouchControls snap={snap} onMove={onMove} onAction={onAction} />
          )}

          {snap.prompt && (
            <div className="absolute bottom-16 left-1/2 -translate-x-1/2 prompt-pop">
              <div className="hud-panel notch-sm px-6 py-2.5 font-display text-sm tracking-[0.25em] text-[#aef6ff] glow-cyan pulse-soft">
                {snap.prompt}
              </div>
            </div>
          )}

          {snap.boss && (
            <div className="absolute top-4 left-1/2 -translate-x-1/2 w-[420px] max-w-[85vw] flex flex-col items-center gap-1">
              <div className="hud-panel notch-sm px-4 py-2 w-full flex flex-col gap-1.5 border border-[#ff0055]/50 bg-[#16040a]/90">
                <div className="flex items-center justify-between">
                  <span className="font-display text-[11px] tracking-[0.25em] text-[#ff6699] font-black glow-magenta">
                    ⚠ {snap.boss.name}
                  </span>
                  <span className="font-display text-[11px] text-red-100 tabular-nums">
                    {snap.boss.hp} / {snap.boss.maxHp}
                  </span>
                </div>
                <div className="bar-shell notch-sm h-3 w-full bg-[#300a14]">
                  <div
                    className="bar-fill h-full transition-all duration-150"
                    style={{
                      transform: `scaleX(${Math.max(0, Math.min(1, snap.boss.hp / snap.boss.maxHp))})`,
                      background: "linear-gradient(90deg, #ff0055, #ff6600)",
                    }}
                  />
                </div>
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
      {snap.state === "dead" && snap.death && (() => {
        const storedBest = Number(localStorage.getItem("neon_high_score") || "0");
        const isNewBest = snap.death.score > storedBest;
        if (isNewBest) {
          try {
            localStorage.setItem("neon_high_score", String(snap.death.score));
          } catch { /* ignore */ }
        }
        const bestScore = Math.max(storedBest, snap.death.score);

        let rank = "CYBER OPERATIVE // RANK C";
        let rankColor = "#38bdf8";
        if (snap.death.floor >= 10) {
          rank = "APEX TERMINATOR // RANK S";
          rankColor = "#fbbf24";
        } else if (snap.death.floor >= 7) {
          rank = "CYBER VANGUARD // RANK A";
          rankColor = "#ff2bd6";
        } else if (snap.death.floor >= 4) {
          rank = "FIELD SPECIALIST // RANK B";
          rankColor = "#22c55e";
        }

        return (
          <div className="absolute inset-0 pointer-events-auto fade-in flex items-center justify-center"
            style={{ background: "radial-gradient(ellipse at center, rgba(30,3,12,0.78) 0%, rgba(3,4,10,0.96) 75%)" }}
          >
            <div className="flex flex-col items-center gap-6 max-w-xl w-full px-6">
              <div className="rise-in flex flex-col items-center">
                <div className="font-display text-[11px] tracking-[0.6em] text-[#ff9df0] mb-2">SIGNAL LOST</div>
                <h2 className="title-flicker font-display text-5xl sm:text-6xl font-black tracking-[0.18em] text-[#ff2bd6] glow-magenta">
                  FLATLINED
                </h2>
                <div className="font-display text-[12px] tracking-[0.3em] font-bold mt-2" style={{ color: rankColor }}>
                  {rank}
                </div>
              </div>

              <div className="rise-in hud-panel notch px-8 py-5 w-full grid grid-cols-2 sm:grid-cols-4 gap-4" style={{ animationDelay: "0.12s" }}>
                <div className="flex flex-col">
                  <span className="text-[10px] tracking-[0.3em] text-cyan-100/50 font-semibold">SECTOR</span>
                  <span className="font-display text-2xl sm:text-3xl text-cyan-50 tabular-nums">{String(snap.death.floor).padStart(2, "0")}</span>
                </div>
                <div className="flex flex-col">
                  <span className="text-[10px] tracking-[0.3em] text-cyan-100/50 font-semibold">KILLS</span>
                  <span className="font-display text-2xl sm:text-3xl text-[#ff9df0] tabular-nums">{snap.death.kills}</span>
                </div>
                <div className="flex flex-col">
                  <span className="text-[10px] tracking-[0.3em] text-cyan-100/50 font-semibold">SCORE</span>
                  <span className="font-display text-2xl sm:text-3xl text-cyan-50 tabular-nums">{snap.death.score.toLocaleString()}</span>
                  {isNewBest && <span className="text-[9px] text-[#fbbf24] font-bold tracking-[0.1em]">★ NEW RECORD</span>}
                </div>
                <div className="flex flex-col">
                  <span className="text-[10px] tracking-[0.3em] text-cyan-100/50 font-semibold">SURVIVED</span>
                  <span className="font-display text-2xl sm:text-3xl text-cyan-50 tabular-nums">{snap.death.time}</span>
                </div>
              </div>

              {snap.death.relics && snap.death.relics.length > 0 && (
                <div className="rise-in flex flex-wrap justify-center gap-2 max-w-md" style={{ animationDelay: "0.2s" }}>
                  {snap.death.relics.map((r, i) => (
                    <span key={i} className="text-[10px] tracking-[0.15em] font-semibold px-2.5 py-1 rounded bg-[#ff2bd6]/15 border border-[#ff2bd6]/40 text-[#ff9df0]">
                      ★ {r}
                    </span>
                  ))}
                </div>
              )}

              <div className="rise-in flex flex-col items-center gap-1 text-[12px] tracking-[0.2em] text-cyan-100/60 font-semibold" style={{ animationDelay: "0.26s" }}>
                <div>FINAL WEAPON — <span className="text-cyan-200">{snap.death.weapon}</span></div>
                <div className="text-[11px] text-cyan-100/40">BEST RUN: {bestScore.toLocaleString()} PTS</div>
              </div>

              <div className="rise-in flex flex-col items-center gap-3" style={{ animationDelay: "0.35s" }}>
                <button className="neon-btn magenta notch px-12 py-4 text-lg" onClick={onRestart}>
                  RE-DEPLOY
                </button>
                <div className="text-[12px] tracking-[0.3em] text-cyan-100/40 font-semibold">OR PRESS ENTER</div>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
