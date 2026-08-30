// Neon Labyrinth App Shell - Production Live on Minisforum
import { useEffect, useRef, useState } from "react";
import { Game } from "./game/game";
import { INITIAL_SNAP, type Snap } from "./game/types";
import { UI } from "./ui/ui";

export default function App() {
  const hostRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<Game | null>(null);
  const [snap, setSnap] = useState<Snap>(INITIAL_SNAP);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const game = new Game(host, setSnap);
    gameRef.current = game;
    void game.boot();
    return () => {
      game.destroy();
      gameRef.current = null;
    };
  }, []);

  return (
    <div className="scanlines relative h-full w-full overflow-hidden" style={{ background: "#04050c" }}>
      <div ref={hostRef} className="absolute inset-0" />
      <div className="crt-vignette" />
      <UI
        snap={snap}
        onStart={() => gameRef.current?.startRun()}
        onResume={() => gameRef.current?.setState("playing")}
        onRestart={() => gameRef.current?.startRun()}
        onAbandon={() => gameRef.current?.abandonRun()}
        onMove={(dx, dy) => gameRef.current?.triggerMove(dx, dy)}
        onAction={(act) => gameRef.current?.triggerAction(act)}
        onToggleSound={() => gameRef.current?.toggleMute()}
      />
    </div>
  );
}
