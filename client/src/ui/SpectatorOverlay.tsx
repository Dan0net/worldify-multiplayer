/**
 * Home / pause menu overlay.
 *
 * Shown whenever gameMode is MainMenu:
 * - Before starting: Multiplayer (disabled while the server is down) + Play Local.
 * - Play Local generates the world client-side, then drops into Playing once
 *   terrain is ready.
 * - After a game has started (e.g. returned here via the pause button): Resume.
 *
 * Landscape-first and compact so it fits any phone orientation.
 */

import { useEffect, useState } from 'react';
import { useGameStore } from '../state/store';
import { GameMode } from '@worldify/shared';
import { createGame } from '../game/createGame';

type Phase = 'menu' | 'starting' | 'started';

export function SpectatorOverlay() {
  const gameMode = useGameStore((s) => s.gameMode);
  const spawnReady = useGameStore((s) => s.spawnReady);
  const setGameMode = useGameStore((s) => s.setGameMode);
  const [phase, setPhase] = useState<Phase>('menu');

  // Once the local world is generated and a spawn is found, enter Playing.
  useEffect(() => {
    if (phase === 'starting' && spawnReady) {
      setGameMode(GameMode.Playing);
      setPhase('started');
    }
  }, [phase, spawnReady, setGameMode]);

  if (gameMode !== GameMode.MainMenu) return null;

  const startLocal = () => {
    if (phase === 'starting') return;
    setPhase('starting');
    createGame('local').catch((err) => {
      console.error('[Local] failed to start local game:', err);
      setPhase('menu');
    });
  };

  const resume = () => setGameMode(GameMode.Playing);

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-6 bg-gradient-to-b from-black/30 to-black/60 px-6 pointer-events-none">
      <img src="/wrldy-logo-white.svg" alt="wrldy" className="h-16 pointer-events-none" />

      <div className="flex flex-col items-center gap-3 w-full max-w-xs pointer-events-auto">
        {phase === 'starting' ? (
          <div className="text-white/80 text-base py-3">Generating world…</div>
        ) : phase === 'started' ? (
          <button
            onClick={resume}
            className="w-full py-3 rounded-xl text-base font-semibold bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-400 text-white shadow-lg transition-colors"
          >
            ▶  Resume
          </button>
        ) : (
          <>
            <button
              disabled
              title="Multiplayer server is offline"
              className="w-full py-3 rounded-xl text-base font-semibold bg-white/10 text-white/40 border border-white/10 cursor-not-allowed"
            >
              Multiplayer <span className="text-xs">(offline)</span>
            </button>
            <button
              onClick={startLocal}
              className="w-full py-3 rounded-xl text-base font-semibold bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-400 text-white shadow-lg transition-colors"
            >
              ▶  Play Local
            </button>
          </>
        )}
      </div>
    </div>
  );
}
