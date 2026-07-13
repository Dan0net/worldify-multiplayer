/**
 * NewWorldDialog — prompts for a world name + seed (both pre-filled) when creating
 * a new world. Seed defaults to a fresh random value (the same one createWorld would
 * pick); name defaults to "World N".
 */

import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal';
import { nextWorldName, randomWorldSeed } from '../game/world/WorldManager';

interface NewWorldDialogProps {
  onCancel: () => void;
  onCreate: (name: string, seed: number) => void;
}

export function NewWorldDialog({ onCancel, onCreate }: NewWorldDialogProps) {
  const [name, setName] = useState('');
  const [seed, setSeed] = useState(() => String(randomWorldSeed()));
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nextWorldName().then(setName);
    nameRef.current?.focus();
  }, []);

  const submit = () => {
    const parsedSeed = parseInt(seed, 10);
    onCreate(name.trim(), Number.isFinite(parsedSeed) ? parsedSeed : randomWorldSeed());
  };

  const inputCls =
    'w-full rounded-lg bg-black/50 border border-white/15 px-3 py-2 text-sm text-white ' +
    'outline-none focus:border-indigo-400';
  const btn = (primary: boolean) =>
    `px-4 py-2 rounded-lg text-sm font-semibold cursor-pointer transition-colors ${
      primary ? 'bg-indigo-600 hover:bg-indigo-500 text-white' : 'bg-white/10 hover:bg-white/20 text-white/80'
    }`;

  return (
    <Modal
      title="New World"
      onClose={onCancel}
      footer={
        <>
          <button className={btn(false)} onClick={onCancel}>Cancel</button>
          <button className={btn(true)} onClick={submit}>Create</button>
        </>
      }
    >
      <label className="flex flex-col gap-1">
        <span className="text-white/60 text-xs">Name</span>
        <input
          ref={nameRef}
          className={inputCls}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          maxLength={40}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-white/60 text-xs">Seed</span>
        <div className="flex gap-2">
          <input
            className={inputCls}
            value={seed}
            inputMode="numeric"
            onChange={(e) => setSeed(e.target.value.replace(/[^0-9]/g, ''))}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          />
          <button
            className="px-3 rounded-lg bg-white/10 hover:bg-white/20 text-white/70 text-xs cursor-pointer whitespace-nowrap"
            onClick={() => setSeed(String(randomWorldSeed()))}
          >
            Random
          </button>
        </div>
      </label>
    </Modal>
  );
}
