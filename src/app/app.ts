import { CommonModule } from '@angular/common';
import { Component, ElementRef, HostListener, ViewChild, afterNextRender, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MindMapService } from './mindmap.service';

@Component({
  selector: 'app-root',
  imports: [CommonModule, FormsModule],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  protected service = inject(MindMapService);

  @ViewChild('canvasRef') private canvasRef?: ElementRef<HTMLElement>;

  activeDropdown: 'layout' | 'theme' | 'lineStyle' | 'shape' | 'export' | null = null;
  showProps = false;

  constructor() {
    afterNextRender(() => {
      this.service.setCanvas(this.canvasRef?.nativeElement);
    });
  }

  @HostListener('window:keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    const isTyping = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.getAttribute('contenteditable') === 'true';

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      event.shiftKey ? this.service.redo() : this.service.undo();
      return;
    }

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      this.service.exportJson();
      return;
    }

    if (isTyping) return;

    if (event.key === 'Tab') { event.preventDefault(); this.service.addChild(); }
    if (event.key === 'Enter') { event.preventDefault(); this.service.addSibling(); }
    if (event.key === 'Backspace' || event.key === 'Delete') { event.preventDefault(); this.service.deleteSelected(); }
    if (event.key === 'Escape') { this.activeDropdown = null; this.service.hideContextMenu(); }
  }

  @HostListener('document:click')
  closeDropdowns(): void { this.activeDropdown = null; }

  fitView(): void { this.service.fitView(this.canvasRef?.nativeElement); }

  toggleDropdown(name: 'layout' | 'theme' | 'lineStyle' | 'shape' | 'export'): void {
    this.activeDropdown = this.activeDropdown === name ? null : name;
  }

  shapeLabel(shape: string): string {
    const labels: Record<string, string> = {
      rounded: '圆角',
      pill: '胶囊',
      cloud: '云朵',
      hexagon: '六边形',
      badge: '徽章',
      tag: '标签',
    };
    return labels[shape] || shape;
  }
}
