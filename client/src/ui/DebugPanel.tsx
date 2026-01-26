import { useGameStore } from '../state/store';

export function DebugPanel() {
  const { ping, fps, tickMs, connectionStatus, serverTick, playerCount } = useGameStore();

  return (
    <div className="fixed top-5 left-5 py-2.5 px-4 bg-black/60 text-green-500 font-mono text-xs rounded-lg z-50">
      <div>Status: {connectionStatus}</div>
      <div>Players: {playerCount}</div>
      <div>Ping: {ping}ms</div>
      <div>FPS: {fps}</div>
      <div>Tick: {tickMs.toFixed(1)}ms</div>
      <div>Server: {serverTick}</div>
    </div>
  );
}
