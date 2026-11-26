import { useEffect } from 'react';
import { Header } from './components/Header';
import { HelpSection } from './components/HelpSection';
import { Sidebar } from './components/Sidebar';
import { StatusBar } from './components/StatusBar';
import { ViewportOverlay } from './components/ViewportOverlay';
import { Scene } from './scene/Scene';
import { installWindowApi } from './windowApi';
import { EditorShortcuts } from './components/EditorShortcuts';
import { bootstrapPersistence, stopPersistence } from './persistence/session';
import { bootstrapDelivery, stopDelivery } from './delivery/session';

export function App() {
  useEffect(() => installWindowApi(), []);

  // Local draft bootstrap runs after the first paint, so the initial empty
  // in-memory draft can never be written over an existing stored record.
  // Delivery records are opened only after the shared database is ready.
  useEffect(() => {
    void bootstrapPersistence().then(() => bootstrapDelivery());
    return () => {
      stopDelivery();
      stopPersistence();
    };
  }, []);

  return (
    <div className="ptg-app">
      <EditorShortcuts />
      <Header />
      <main className="ptg-main">
        <Sidebar />
        <section className="ptg-viewport" data-testid="viewport">
          <Scene />
          <ViewportOverlay />
        </section>
      </main>
      <StatusBar />
      <HelpSection />
    </div>
  );
}
