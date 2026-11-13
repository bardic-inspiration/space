import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { FolderFiles } from './project/files.ts';
import { App } from './ui/App.tsx';
import { studio } from './ui/studio.ts';
import './ui/styles.css';

// For the browser tests, and for poking at a session from the console.
Object.assign(window, { studio, FolderFiles });

const preferred = window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
studio.setTheme((localStorage.getItem('studio.theme') as 'light' | 'dark' | null) ?? preferred);
void studio.openExamples();

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
