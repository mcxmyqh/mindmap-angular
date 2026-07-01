import { CommonModule } from '@angular/common';
import { Component, ElementRef, HostListener, ViewChild, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

type BranchSide = 'left' | 'right';
type LayoutMode = 'balanced' | 'right' | 'logic';
type ThemeName = 'ocean' | 'forest' | 'sunset' | 'mono';

interface MindNode {
  id: string;
  parentId: string | null;
  text: string;
  note: string;
  x: number;
  y: number;
  color: string;
  icon: string;
  progress: number;
  collapsed: boolean;
  side: BranchSide;
}

interface MindMapDoc {
  title: string;
  layout: LayoutMode;
  theme: ThemeName;
  nodes: MindNode[];
}

interface Connector {
  id: string;
  path: string;
  color: string;
}

interface LayoutTemplate {
  mode: LayoutMode;
  name: string;
  description: string;
}

interface ThemeTemplate {
  theme: ThemeName;
  name: string;
  description: string;
  colors: string[];
}

const STORAGE_KEY = 'codex-angular-mindmap-v1';
const PALETTE = ['#1d7afc', '#13a68f', '#f05f42', '#d79a0b', '#8b5cf6', '#334155'];
const ICONS = ['none', 'star', 'flag', 'check', 'idea', 'warn'];

@Component({
  selector: 'app-root',
  imports: [CommonModule, FormsModule],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  readonly colors = PALETTE;
  readonly icons = ICONS;
  readonly layoutTemplates: LayoutTemplate[] = [
    { mode: 'balanced', name: '平衡思维导图', description: '中心向左右展开，适合发散梳理' },
    { mode: 'right', name: '右侧导图', description: '所有主题向右推进，适合流程和清单' },
    { mode: 'logic', name: '逻辑结构图', description: '从上到下分层，适合组织结构和拆解' },
  ];
  readonly themeTemplates: ThemeTemplate[] = [
    { theme: 'ocean', name: '海蓝', description: '清爽产品风', colors: ['#1d7afc', '#13a68f', '#eef6f4'] },
    { theme: 'forest', name: '森林', description: '沉稳研究风', colors: ['#18865f', '#b78916', '#eef8f0'] },
    { theme: 'sunset', name: '晨光', description: '温暖创意风', colors: ['#e35d34', '#d79a0b', '#fff2e6'] },
    { theme: 'mono', name: '极简', description: '专注阅读风', colors: ['#25364a', '#6a7b8e', '#f2f4f5'] },
  ];

  @ViewChild('canvasRef') private canvasRef?: ElementRef<HTMLElement>;

  doc = signal<MindMapDoc>(this.loadInitialDoc());
  selectedId = signal('root');
  searchText = signal('');
  zoom = signal(0.78);
  pan = signal({ x: 440, y: 370 });
  layoutBusy = signal(false);
  importError = signal('');

  private history: MindMapDoc[] = [];
  private future: MindMapDoc[] = [];
  private drag:
    | { mode: 'node'; id: string; startX: number; startY: number; originalX: number; originalY: number }
    | { mode: 'pan'; startX: number; startY: number; originalX: number; originalY: number }
    | null = null;

  visibleNodes = computed(() => {
    const doc = this.doc();
    return doc.nodes.filter((node) => this.isVisible(node.id, doc.nodes));
  });

  connectors = computed<Connector[]>(() => {
    const visibleIds = new Set(this.visibleNodes().map((node) => node.id));
    const nodes = this.doc().nodes;

    return nodes
      .filter((node) => node.parentId && visibleIds.has(node.id) && visibleIds.has(node.parentId))
      .map((node) => {
        const parent = nodes.find((item) => item.id === node.parentId);
        if (!parent) {
          return null;
        }

        const startX = parent.x + (node.x >= parent.x ? 118 : -118);
        const endX = node.x + (node.x >= parent.x ? -118 : 118);
        const offset = Math.max(70, Math.abs(endX - startX) * 0.52);
        const path = `M ${startX} ${parent.y} C ${startX + (node.x >= parent.x ? offset : -offset)} ${parent.y}, ${endX - (node.x >= parent.x ? offset : -offset)} ${node.y}, ${endX} ${node.y}`;

        return { id: node.id, path, color: node.color };
      })
      .filter((connector): connector is Connector => Boolean(connector));
  });

  selectedNode = computed(() => {
    return this.doc().nodes.find((node) => node.id === this.selectedId()) ?? this.doc().nodes[0];
  });

  outline = computed(() => this.buildOutline('root'));

  stats = computed(() => {
    const nodes = this.doc().nodes;
    return {
      total: nodes.length,
      visible: this.visibleNodes().length,
      completed: nodes.filter((node) => node.progress === 100).length,
    };
  });

  matchedIds = computed(() => {
    const query = this.searchText().trim().toLowerCase();
    if (!query) {
      return new Set<string>();
    }

    return new Set(
      this.doc()
        .nodes.filter((node) => `${node.text} ${node.note}`.toLowerCase().includes(query))
        .map((node) => node.id),
    );
  });

  constructor() {
    this.saveDoc();
  }

  @HostListener('window:keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    const isTyping = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA';

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      event.shiftKey ? this.redo() : this.undo();
      return;
    }

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      this.exportJson();
      return;
    }

    if (isTyping) {
      return;
    }

    if (event.key === 'Tab') {
      event.preventDefault();
      this.addChild();
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      this.addSibling();
    }

    if (event.key === 'Backspace' || event.key === 'Delete') {
      event.preventDefault();
      this.deleteSelected();
    }
  }

  selectNode(id: string): void {
    this.selectedId.set(id);
  }

  updateTitle(title: string): void {
    this.mutate((doc) => ({ ...doc, title }));
  }

  updateSelected(patch: Partial<MindNode>): void {
    const selectedId = this.selectedId();
    this.mutate((doc) => ({
      ...doc,
      nodes: doc.nodes.map((node) => (node.id === selectedId ? { ...node, ...patch } : node)),
    }));
  }

  addChild(): void {
    const parent = this.selectedNode();
    const children = this.childrenOf(parent.id);
    const side = parent.id === 'root' ? this.nextRootSide() : parent.side;
    const child: MindNode = {
      id: this.createId(),
      parentId: parent.id,
      text: '新主题',
      note: '',
      x: parent.x + (side === 'right' ? 300 : -300),
      y: parent.y + (children.length - 0.5) * 92,
      color: PALETTE[(children.length + 1) % PALETTE.length],
      icon: 'none',
      progress: 0,
      collapsed: false,
      side,
    };

    this.mutate((doc) => ({ ...doc, nodes: [...doc.nodes, child] }));
    this.selectedId.set(child.id);
    this.autoLayout(false);
  }

  addSibling(): void {
    const current = this.selectedNode();
    if (!current.parentId) {
      this.addChild();
      return;
    }

    const siblings = this.childrenOf(current.parentId);
    const sibling: MindNode = {
      ...current,
      id: this.createId(),
      text: '同级主题',
      note: '',
      y: current.y + 92,
      color: PALETTE[siblings.length % PALETTE.length],
      collapsed: false,
    };

    this.mutate((doc) => ({ ...doc, nodes: [...doc.nodes, sibling] }));
    this.selectedId.set(sibling.id);
    this.autoLayout(false);
  }

  deleteSelected(): void {
    const id = this.selectedId();
    const selected = this.selectedNode();
    if (!selected.parentId) {
      return;
    }

    const removeIds = this.collectDescendants(id);
    this.mutate((doc) => ({ ...doc, nodes: doc.nodes.filter((node) => !removeIds.has(node.id)) }));
    this.selectedId.set(selected.parentId);
    this.autoLayout(false);
  }

  toggleCollapse(id = this.selectedId()): void {
    this.mutate((doc) => ({
      ...doc,
      nodes: doc.nodes.map((node) =>
        node.id === id ? { ...node, collapsed: !node.collapsed } : node,
      ),
    }));
  }

  setLayout(layout: LayoutMode): void {
    this.mutate((doc) => ({ ...doc, layout }));
    this.autoLayout();
    window.setTimeout(() => this.fitView(), 160);
  }

  setTheme(theme: ThemeName): void {
    this.mutate((doc) => ({ ...doc, theme }));
  }

  resetDemo(): void {
    this.mutate(() => this.createDemoDoc());
    this.selectedId.set('root');
    window.setTimeout(() => this.fitView(), 0);
  }

  autoLayout(record = true): void {
    if (record) {
      this.pushHistory();
    }

    this.layoutBusy.set(true);
    const doc = structuredClone(this.doc());
    const root = doc.nodes.find((node) => node.id === 'root');
    if (!root) {
      return;
    }

    root.x = 0;
    root.y = 0;

    if (doc.layout === 'logic') {
      this.positionLogicLayout(doc.nodes, root);
      this.doc.set(doc);
      this.saveDoc();
      window.setTimeout(() => {
        this.layoutBusy.set(false);
        this.fitView();
      }, 140);
      return;
    }

    const rightRoots = this.rootChildren(doc.nodes, 'right');
    const leftRoots = doc.layout === 'right' ? [] : this.rootChildren(doc.nodes, 'left');
    if (doc.layout === 'right') {
      rightRoots.push(...this.rootChildren(doc.nodes, 'left'));
      rightRoots.forEach((node) => (node.side = 'right'));
    }

    this.positionBranch(doc.nodes, rightRoots, 1, -this.branchHeight(rightRoots, doc.nodes) / 2);
    this.positionBranch(doc.nodes, leftRoots, -1, -this.branchHeight(leftRoots, doc.nodes) / 2);

    this.doc.set(doc);
    this.saveDoc();
    window.setTimeout(() => this.layoutBusy.set(false), 140);
  }

  startNodeDrag(event: PointerEvent, id: string): void {
    event.stopPropagation();
    const node = this.doc().nodes.find((item) => item.id === id);
    if (!node) {
      return;
    }

    this.selectNode(id);
    this.pushHistory();
    this.future = [];
    this.drag = {
      mode: 'node',
      id,
      startX: event.clientX,
      startY: event.clientY,
      originalX: node.x,
      originalY: node.y,
    };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  startPan(event: PointerEvent): void {
    if ((event.target as HTMLElement).closest('.mind-node')) {
      return;
    }

    this.drag = {
      mode: 'pan',
      startX: event.clientX,
      startY: event.clientY,
      originalX: this.pan().x,
      originalY: this.pan().y,
    };
  }

  movePointer(event: PointerEvent): void {
    if (!this.drag) {
      return;
    }

    const dx = event.clientX - this.drag.startX;
    const dy = event.clientY - this.drag.startY;

    if (this.drag.mode === 'pan') {
      this.pan.set({ x: this.drag.originalX + dx, y: this.drag.originalY + dy });
      return;
    }

    const zoom = this.zoom();
    this.updateSelectedPosition(this.drag.id, this.drag.originalX + dx / zoom, this.drag.originalY + dy / zoom);
  }

  endPointer(): void {
    if (this.drag?.mode === 'node') {
      this.saveDoc();
    }
    this.drag = null;
  }

  zoomCanvas(delta: number): void {
    this.zoom.set(Math.min(1.8, Math.max(0.35, Number((this.zoom() + delta).toFixed(2)))));
  }

  fitView(): void {
    const canvas = this.canvasRef?.nativeElement;
    const nodes = this.visibleNodes();
    if (!canvas || !nodes.length) {
      this.zoom.set(0.78);
      this.pan.set({ x: 440, y: 370 });
      return;
    }

    const bounds = this.mapBounds(nodes);
    const viewportWidth = canvas.clientWidth;
    const viewportHeight = canvas.clientHeight;
    const nextZoom = Math.min(
      1,
      Math.max(0.42, Math.min((viewportWidth - 96) / bounds.width, (viewportHeight - 80) / bounds.height)),
    );
    const x = viewportWidth / 2 - ((bounds.minX + bounds.width / 2) * nextZoom);
    const y = viewportHeight / 2 - ((bounds.minY + bounds.height / 2) * nextZoom);

    this.zoom.set(Number(nextZoom.toFixed(2)));
    this.pan.set({ x: Math.round(x), y: Math.round(y) });
  }

  exportJson(): void {
    this.download(`${this.doc().title || 'mindmap'}.json`, JSON.stringify(this.doc(), null, 2), 'application/json');
  }

  exportSvg(): void {
    const nodes = this.visibleNodes();
    const xs = nodes.map((node) => node.x);
    const ys = nodes.map((node) => node.y);
    const minX = Math.min(...xs) - 180;
    const minY = Math.min(...ys) - 90;
    const width = Math.max(...xs) - minX + 220;
    const height = Math.max(...ys) - minY + 140;
    const connectors = this.connectors()
      .map((connector) => `<path d="${connector.path}" fill="none" stroke="${connector.color}" stroke-width="4"/>`)
      .join('');
    const items = nodes
      .map(
        (node) =>
          `<g transform="translate(${node.x - 120}, ${node.y - 30})"><rect width="240" height="60" rx="18" fill="white" stroke="${node.color}" stroke-width="3"/><text x="120" y="37" text-anchor="middle" font-size="18" font-family="sans-serif" fill="#102033">${this.escapeXml(node.text)}</text></g>`,
      )
      .join('');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX} ${minY} ${width} ${height}">${connectors}${items}</svg>`;
    this.download(`${this.doc().title || 'mindmap'}.svg`, svg, 'image/svg+xml');
  }

  importJson(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) {
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      try {
        const next = JSON.parse(String(reader.result)) as MindMapDoc;
        if (!next.nodes?.some((node) => node.id === 'root')) {
          throw new Error('invalid file');
        }
        this.mutate(() => next);
        this.selectedId.set('root');
        this.importError.set('');
      } catch {
        this.importError.set('文件格式不正确');
      } finally {
        input.value = '';
      }
    };
    reader.readAsText(file);
  }

  undo(): void {
    const previous = this.history.pop();
    if (!previous) {
      return;
    }

    this.future.push(structuredClone(this.doc()));
    this.doc.set(previous);
    this.selectedId.set(previous.nodes.some((node) => node.id === this.selectedId()) ? this.selectedId() : 'root');
    this.saveDoc();
  }

  redo(): void {
    const next = this.future.pop();
    if (!next) {
      return;
    }

    this.history.push(structuredClone(this.doc()));
    this.doc.set(next);
    this.saveDoc();
  }

  childrenOf(parentId: string): MindNode[] {
    return this.doc().nodes.filter((node) => node.parentId === parentId);
  }

  hasChildren(id: string): boolean {
    return this.doc().nodes.some((node) => node.parentId === id);
  }

  nodeClasses(node: MindNode): Record<string, boolean> {
    return {
      selected: node.id === this.selectedId(),
      matched: this.matchedIds().has(node.id),
      root: node.id === 'root',
      collapsed: node.collapsed,
    };
  }

  outlineLevelStyle(level: number): Record<string, string> {
    return {
      '--guide-left': `${13 + level * 18}px`,
      'padding-left': `${10 + level * 18}px`,
    };
  }

  canvasTransform(): string {
    const pan = this.pan();
    return `translate(${pan.x}px, ${pan.y}px) scale(${this.zoom()})`;
  }

  iconLabel(icon: string): string {
    return (
      {
        none: '',
        star: '★',
        flag: '⚑',
        check: '✓',
        idea: '!',
        warn: '?',
      }[icon] ?? ''
    );
  }

  private mutate(updater: (doc: MindMapDoc) => MindMapDoc): void {
    this.pushHistory();
    this.doc.set(updater(structuredClone(this.doc())));
    this.future = [];
    this.saveDoc();
  }

  private pushHistory(): void {
    this.history.push(structuredClone(this.doc()));
    this.history = this.history.slice(-60);
  }

  private updateSelectedPosition(id: string, x: number, y: number): void {
    this.doc.update((doc) => ({
      ...doc,
      nodes: doc.nodes.map((node) => (node.id === id ? { ...node, x, y } : node)),
    }));
  }

  private buildOutline(parentId: string, level = 0): Array<MindNode & { level: number }> {
    return this.childrenOf(parentId).flatMap((node) => [
      { ...node, level },
      ...(node.collapsed ? [] : this.buildOutline(node.id, level + 1)),
    ]);
  }

  private positionBranch(nodes: MindNode[], roots: MindNode[], direction: 1 | -1, startY: number): number {
    let cursor = startY;
    for (const root of roots) {
      const height = Math.max(92, this.branchHeight([root], nodes));
      this.placeSubtree(nodes, root, direction, 1, cursor + height / 2);
      cursor += height;
    }
    return cursor;
  }

  private placeSubtree(nodes: MindNode[], node: MindNode, direction: 1 | -1, depth: number, centerY: number): void {
    node.x = direction * (depth * 300);
    node.y = centerY;
    node.side = direction === 1 ? 'right' : 'left';
    const children = nodes.filter((item) => item.parentId === node.id);
    const height = this.branchHeight(children, nodes);
    let cursor = centerY - height / 2;

    for (const child of children) {
      const childHeight = Math.max(86, this.branchHeight([child], nodes));
      this.placeSubtree(nodes, child, direction, depth + 1, cursor + childHeight / 2);
      cursor += childHeight;
    }
  }

  private positionLogicLayout(nodes: MindNode[], root: MindNode): void {
    root.x = 0;
    root.y = -260;
    const children = nodes.filter((node) => node.parentId === root.id);
    const totalWidth = this.logicWidth(children, nodes);
    let cursor = -totalWidth / 2;

    for (const child of children) {
      const width = this.logicWidth([child], nodes);
      this.placeLogicSubtree(nodes, child, cursor + width / 2, -80);
      cursor += width;
    }
  }

  private placeLogicSubtree(
    nodes: MindNode[],
    node: MindNode,
    centerX: number,
    y: number,
  ): void {
    node.x = centerX;
    node.y = y;
    node.side = centerX >= 0 ? 'right' : 'left';
    const children = nodes.filter((item) => item.parentId === node.id);
    const totalWidth = this.logicWidth(children, nodes);
    let cursor = centerX - totalWidth / 2;

    for (const child of children) {
      const width = this.logicWidth([child], nodes);
      this.placeLogicSubtree(nodes, child, cursor + width / 2, y + 140);
      cursor += width;
    }
  }

  private logicWidth(nodes: MindNode[], allNodes: MindNode[]): number {
    if (!nodes.length) {
      return 0;
    }

    return nodes.reduce((total, node) => {
      const children = allNodes.filter((item) => item.parentId === node.id);
      return total + Math.max(280, this.logicWidth(children, allNodes));
    }, 0);
  }

  private branchHeight(nodes: MindNode[], allNodes: MindNode[]): number {
    if (!nodes.length) {
      return 0;
    }

    return nodes.reduce((total, node) => {
      const children = allNodes.filter((item) => item.parentId === node.id);
      return total + Math.max(92, this.branchHeight(children, allNodes));
    }, 0);
  }

  private rootChildren(nodes: MindNode[], side: BranchSide): MindNode[] {
    return nodes.filter((node) => node.parentId === 'root' && node.side === side);
  }

  private nextRootSide(): BranchSide {
    const rootChildren = this.childrenOf('root');
    return rootChildren.filter((node) => node.side === 'right').length <=
      rootChildren.filter((node) => node.side === 'left').length
      ? 'right'
      : 'left';
  }

  private isVisible(id: string, nodes: MindNode[]): boolean {
    let current = nodes.find((node) => node.id === id);
    while (current?.parentId) {
      const parent = nodes.find((node) => node.id === current?.parentId);
      if (parent?.collapsed) {
        return false;
      }
      current = parent;
    }
    return true;
  }

  private collectDescendants(id: string): Set<string> {
    const ids = new Set([id]);
    for (const child of this.childrenOf(id)) {
      for (const item of this.collectDescendants(child.id)) {
        ids.add(item);
      }
    }
    return ids;
  }

  private mapBounds(nodes: MindNode[]): { minX: number; minY: number; width: number; height: number } {
    const minX = Math.min(...nodes.map((node) => node.x - 150));
    const maxX = Math.max(...nodes.map((node) => node.x + 150));
    const minY = Math.min(...nodes.map((node) => node.y - 70));
    const maxY = Math.max(...nodes.map((node) => node.y + 70));

    return {
      minX,
      minY,
      width: Math.max(1, maxX - minX),
      height: Math.max(1, maxY - minY),
    };
  }

  private saveDoc(): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.doc()));
  }

  private loadInitialDoc(): MindMapDoc {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      try {
        return JSON.parse(stored) as MindMapDoc;
      } catch {
        localStorage.removeItem(STORAGE_KEY);
      }
    }
    return this.createDemoDoc();
  }

  private createDemoDoc(): MindMapDoc {
    return {
      title: '产品思维导图',
      layout: 'balanced',
      theme: 'ocean',
      nodes: [
        this.node('root', null, 'Web 思维导图', 0, 0, '#102033', 'idea', 20, 'right', '面向方案梳理、会议记录和知识结构化'),
        this.node('n1', 'root', '快捷创作', 300, -150, '#1d7afc', 'star', 60, 'right', 'Tab 添加子主题，Enter 添加同级主题'),
        this.node('n2', 'n1', '节点编辑', 600, -210, '#1d7afc', 'check', 70, 'right', '标题、备注、图标、颜色、进度都可编辑'),
        this.node('n3', 'n1', '折叠展开', 600, -100, '#13a68f', 'flag', 30, 'right', '聚焦大纲结构'),
        this.node('n4', 'root', '画布体验', 300, 120, '#13a68f', 'idea', 35, 'right', '拖拽、缩放、自动布局、搜索高亮'),
        this.node('n5', 'n4', '平移缩放', 600, 80, '#13a68f', 'none', 50, 'right', ''),
        this.node('n6', 'n4', 'SVG 导出', 600, 190, '#f05f42', 'star', 10, 'right', ''),
        this.node('n7', 'root', '知识沉淀', -300, -120, '#f05f42', 'flag', 25, 'left', '本地保存，不刷新丢失'),
        this.node('n8', 'n7', 'JSON 导入导出', -600, -150, '#f05f42', 'check', 10, 'left', ''),
        this.node('n9', 'n7', '主题切换', -600, -40, '#d79a0b', 'star', 75, 'left', ''),
        this.node('n10', 'root', '项目协作', -300, 150, '#8b5cf6', 'warn', 45, 'left', '用进度和备注承载上下文'),
      ],
    };
  }

  private node(
    id: string,
    parentId: string | null,
    text: string,
    x: number,
    y: number,
    color: string,
    icon: string,
    progress: number,
    side: BranchSide,
    note: string,
  ): MindNode {
    return { id, parentId, text, note, x, y, color, icon, progress, collapsed: false, side };
  }

  private createId(): string {
    return `node-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  }

  private download(filename: string, content: string, type: string): void {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  private escapeXml(value: string): string {
    return value.replace(/[<>&'"]/g, (char) => {
      return { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[char] ?? char;
    });
  }
}
