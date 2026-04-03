import './styles/base.css';
import './styles/shell.css';
import './styles/components.css';
import './styles/animations.css';
import './styles/debug-console.css';
import { App } from './frontend/App.js';

const root = document.getElementById('app')!;
const app = new App(root);

// Expose for debugging
(window as any).app = app;
