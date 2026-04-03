/**
 * On-screen debug console overlay.
 * Captures logger output and displays it over the game screen.
 * Toggle with backtick (`) key.
 */

interface LogEntry {
  level: string;
  message: string;
  time: string;
}

const MAX_ENTRIES = 200;

const LEVEL_COLORS: Record<string, string> = {
  error: '#ff6b6b',
  warn: '#ffd93d',
  info: '#e0e0e0',
  debug: '#888',
};

export class DebugConsole {
  private entries: LogEntry[] = [];
  private el!: HTMLElement;
  private logBody!: HTMLElement;
  private visible = false;

  mount(container: HTMLElement): void {
    this.el = document.createElement('div');
    this.el.className = 'debug-console';

    const header = document.createElement('div');
    header.className = 'debug-console-header';
    header.innerHTML = '<span>Debug Console</span><span class="debug-console-hint">` to toggle</span>';
    this.el.appendChild(header);

    this.logBody = document.createElement('div');
    this.logBody.className = 'debug-console-body';
    this.el.appendChild(this.logBody);

    container.appendChild(this.el);
  }

  toggle(): void {
    this.visible = !this.visible;
    this.el.classList.toggle('open', this.visible);
    if (this.visible) {
      this._scrollToBottom();
    }
  }

  log(level: string, message: string): void {
    const now = new Date();
    const time = `${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}.${now.getMilliseconds().toString().padStart(3, '0')}`;

    this.entries.push({ level, message, time });
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.shift();
    }

    if (this.visible) {
      this._appendEntry(this.entries[this.entries.length - 1]);
      // Trim DOM nodes to match ring buffer
      while (this.logBody.children.length > MAX_ENTRIES) {
        this.logBody.removeChild(this.logBody.firstChild!);
      }
      this._scrollToBottom();
    }
  }

  private _appendEntry(entry: LogEntry): void {
    const line = document.createElement('div');
    line.className = 'debug-console-line';

    const color = LEVEL_COLORS[entry.level] || '#e0e0e0';
    const levelTag = entry.level.toUpperCase().padEnd(5);

    line.innerHTML =
      `<span class="debug-console-time">${entry.time}</span>` +
      `<span style="color:${color}">${levelTag}</span> ` +
      `<span class="debug-console-msg">${this._escape(entry.message)}</span>`;

    this.logBody.appendChild(line);
  }

  private _scrollToBottom(): void {
    this.logBody.scrollTop = this.logBody.scrollHeight;
  }

  private _escape(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}
