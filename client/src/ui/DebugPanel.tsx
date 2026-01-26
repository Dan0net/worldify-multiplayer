import { useGameStore } from '../state/store';

export function DebugPanel() {
  const { ping, fps, tickMs, connectionStatus, serverTick, playerCount } = useGameStore();

  return (
    <div
      style={{
        position: 'fixed',
        top: '20px',
        left: '20px',
        padding: '10px 15px',
        background: 'rgba(0,0,0,0.6)',
        color: '#0f0',
        fontFamily: 'monospace',
        fontSize: '12px',
        borderRadius: '8px',
        zIndex: 50,
      }}
    >
      <div>Status: {connectionStatus}</div>
      <div>Players: {playerCount}</div>
      <div>Ping: {ping}ms</div>
      <div>FPS: {fps}</div>
      <div>Tick: {tickMs.toFixed(1)}ms</div>
      <div>Server: {serverTick}</div>
    </div>
  );
}
