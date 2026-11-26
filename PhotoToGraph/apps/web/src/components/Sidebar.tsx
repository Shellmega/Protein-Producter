import { DiagnosticsPanel } from './DiagnosticsPanel';
import { NodeList } from './NodeList';
import { ReferencePanel } from './ReferencePanel';
import { GraphEditorPanel } from './GraphEditorPanel';
import { PersistencePanel } from './PersistencePanel';
import { DeliveryPanel } from './DeliveryPanel';

export function Sidebar() {
  return (
    <aside className="ptg-sidebar" data-testid="sidebar">
      <GraphEditorPanel />
      <ReferencePanel />
      <PersistencePanel />
      <DeliveryPanel />
      <NodeList />
      <DiagnosticsPanel />
    </aside>
  );
}
