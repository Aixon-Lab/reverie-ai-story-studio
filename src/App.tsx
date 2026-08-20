import { Route, Routes, Navigate } from 'react-router-dom';
import { Shell } from './components/Shell';
import { VaultGate } from './components/VaultGate';
import { ConfirmProvider } from './components/ConfirmDialog';
import { Home } from './pages/Home';
import { ChatPage } from './pages/ChatPage';
import { Connections } from './pages/Connections';
import { CharacterCreator } from './pages/CharacterCreator';
import { PresetComposer } from './pages/PresetComposer';
import { MindIndex, MindPage } from './pages/MindPage';
import { ChatMindPage } from './pages/ChatMindPage';
import { SkillsPage } from './pages/SkillsPage';

export default function App() {
  return (
    <VaultGate>
      {/* Wraps the whole app so any page can ask for a real confirmation dialog
          instead of the browser's "127.0.0.1 says…" popup. */}
      <ConfirmProvider>
      <Shell>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/chat/:chatId" element={<ChatPage />} />
          <Route path="/presets" element={<PresetComposer />} />
          <Route path="/connections" element={<Connections />} />
          <Route path="/mind" element={<MindIndex />} />
          {/* A mind belongs to a conversation, not to a character in the abstract:
              the whole cast's memory, then one character's in full. */}
          <Route path="/mind/:chatId" element={<ChatMindPage />} />
          <Route path="/mind/:chatId/:characterId" element={<MindPage />} />
          <Route path="/skills" element={<SkillsPage />} />
          <Route path="/creator" element={<CharacterCreator />} />
          <Route path="/creator/:id" element={<CharacterCreator />} />
          {/* legacy studio paths */}
          <Route path="/character" element={<Navigate to="/creator" replace />} />
          <Route path="/character/:id" element={<CharacterCreator />} />
        </Routes>
      </Shell>
      </ConfirmProvider>
    </VaultGate>
  );
}
