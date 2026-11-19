import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/figtree';
import '@fontsource-variable/jetbrains-mono';
import '@fontsource/fredoka/600.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/ui.css';
import './styles/layout.css';
import './styles/chat.css';
import './styles/pickers.css';
import './styles/calls.css';
import './styles/screens.css';
import './styles/glass.css';
import { App } from './App';
import { initPlatform } from './lib/boot';

initPlatform();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
