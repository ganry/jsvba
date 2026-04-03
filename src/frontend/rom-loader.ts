/**
 * ROM Loader — handles file picking and drag-and-drop for .gba files.
 */

export type RomLoadCallback = (data: ArrayBuffer, filename: string) => void;

export class RomLoader {
  private onLoad: RomLoadCallback | null = null;
  private dropZone: HTMLElement | null = null;

  /** Set the callback for when a ROM is loaded */
  setCallback(cb: RomLoadCallback): void {
    this.onLoad = cb;
  }

  /** Create and attach a file input (hidden) */
  createFileInput(): HTMLInputElement {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.gba,.bin,.rom';
    input.style.display = 'none';

    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (file) this._loadFile(file);
      input.value = ''; // Reset so same file can be re-selected
    });

    document.body.appendChild(input);
    return input;
  }

  /** Set up drag-and-drop on an element */
  setupDropZone(element: HTMLElement): void {
    this.dropZone = element;

    element.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      element.classList.add('drag-over');
    });

    element.addEventListener('dragleave', (e) => {
      e.preventDefault();
      e.stopPropagation();
      element.classList.remove('drag-over');
    });

    element.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      element.classList.remove('drag-over');

      const file = e.dataTransfer?.files[0];
      if (file) this._loadFile(file);
    });
  }

  private async _loadFile(file: File): Promise<void> {
    const data = await file.arrayBuffer();
    if (this.onLoad) {
      this.onLoad(data, file.name);
    }
  }
}
