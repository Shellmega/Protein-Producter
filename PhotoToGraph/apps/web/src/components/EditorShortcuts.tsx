import { useEffect } from 'react';
import { usePtgStore } from '../domain/store';

export function EditorShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('input,textarea,select,[contenteditable="true"]')) return;
      const state = usePtgStore.getState();
      if (e.key === 'Escape') state.cancelDrag();
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) state.redo(); else state.undo();
      } else if (e.ctrlKey && e.key.toLowerCase() === 'y') {
        e.preventDefault(); state.redo();
      } else if (e.key === 'Delete' && state.selectedNodeId) {
        e.preventDefault(); state.deleteNode(state.selectedNodeId);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return null;
}
