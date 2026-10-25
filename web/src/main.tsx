import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';
import '@fontsource-variable/fredoka';
import '@fontsource-variable/nunito';
import './styles.css';

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
