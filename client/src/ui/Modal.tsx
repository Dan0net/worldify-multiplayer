/**
 * Modal — a small centered dialog: dimmed scrim + card. Reused for the new-world
 * prompt and (via the same visual language) other desktop dialogs. Click the scrim
 * or press Escape to dismiss.
 */

import { useEffect, type ReactNode } from 'react';
import { X } from 'lucide-react';

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Optional footer (e.g. action buttons), rendered below the body. */
  footer?: ReactNode;
}

export function Modal({ title, onClose, children, footer }: ModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[110] bg-black/70 backdrop-blur-sm pointer-events-auto flex items-center justify-center p-4"
      onPointerDown={onClose}
    >
      <div
        className="w-[min(92vw,26rem)] rounded-2xl bg-neutral-900/95 border border-white/10 shadow-2xl flex flex-col"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
          <span className="text-white font-semibold">{title}</span>
          <button
            onClick={onClose}
            aria-label="Close"
            className="w-7 h-7 rounded-lg text-white/50 hover:text-white hover:bg-white/10 flex items-center justify-center cursor-pointer"
          >
            <X size={18} />
          </button>
        </div>
        <div className="px-4 py-3 flex flex-col gap-3">{children}</div>
        {footer && <div className="px-4 py-3 border-t border-white/10 flex justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}
