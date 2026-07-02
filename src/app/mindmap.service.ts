import { Injectable, computed, signal } from '@angular/core';

/* ── types ── */
type BranchSide = 'left' | 'right';
type LayoutMode = 'balanced' | 'right' | 'logic' | 'orgchart' | 'tree' | 'timeline' | 'fishbone';
type ThemeName = 'ocean' | 'forest' | 'sunset' | 'mono' | 'dark';
type LineStyleType = 'curve' | 'straight' | 'polyline';

export interface MindNode {
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
  width: number;
  tags: string[];
  hyperlink: string;
}

export interface MindMapDoc {
  title: string;
  layout: LayoutMode;
  theme: ThemeName;
  lineStyle: LineStyleType;
  nodes: MindNode[];
}

export interface Connector { id: string; path: string; color: string; }
export interface LayoutTemplate { mode: LayoutMode; name: string; description: string }
export interface ThemeTemplate { theme: ThemeName; name: string; description: string; colors: string[] }

interface DragNodeState {
  mode: 'node'; id: string; startX: number; startY: number;
  originalX: number; originalY: number;
  descendants: { id: string; origX: number; origY: number }[];
}
interface DragPanState { mode: 'pan'; startX: number; startY: number; originalX: number; originalY: number }
interface DragResizeState { mode: 'resize'; id: string; startX: number; originalWidth: number }
type DragState = DragNodeState | DragPanState | DragResizeState | null;

/* ── constants ── */
const STORAGE_KEY = 'mindmap-angular-v3';
const BRANCH_COLORS = ['#4A90D9', '#E74C3C', '#2ECC71', '#F39C12', '#9B59B6', '#1ABC9C', '#E67E22', '#3498DB'];
const ICONS = ['none', 'star', 'flag', 'check', 'idea', 'warn'];
const NODE_H = 36;
const DEFAULT_W = 160;

export {
  type BranchSide, type LayoutMode, type ThemeName, type LineStyleType,
  BRANCH_COLORS, ICONS,
};

export const LAYOUT_TEMPLATES: LayoutTemplate[] = [
  { mode: 'balanced', name: '思维导图', description: '中心向左右展开' },
  { mode: 'right', name: '逻辑图', description: '向右推进' },
  { mode: 'logic', name: '组织结构', description: '从上到下分层' },
  { mode: 'orgchart', name: '组织架构图', description: '垂直层次' },
  { mode: 'tree', name: '目录树', description: '单根向下展开' },
  { mode: 'timeline', name: '时间线', description: '水平时间轴' },
  { mode: 'fishbone', name: '鱼骨图', description: '斜向因果分析' },
];

export const THEME_TEMPLATES: ThemeTemplate[] = [
  { theme: 'ocean', name: '海蓝', description: '清爽', colors: ['#4A90D9', '#2ECC71', '#f0f6fa'] },
  { theme: 'forest', name: '森林', description: '沉稳', colors: ['#27AE60', '#D4A017', '#eef8f0'] },
  { theme: 'sunset', name: '暖阳', description: '温暖', colors: ['#E74C3C', '#F39C12', '#fff5ee'] },
  { theme: 'mono', name: '极简', description: '专注', colors: ['#2C3E50', '#7F8C8D', '#f5f5f5'] },
  { theme: 'dark', name: '深色', description: '沉浸', colors: ['#5DADE2', '#48C9B0', '#1a1a2e'] },
];

export const LINE_STYLES: { type: LineStyleType; name: string }[] = [
  { type: 'curve', name: '曲线' },
  { type: 'straight', name: '直线' },
  { type: 'polyline', name: '折线' },
];

/* ── helpers ── */
function mkNode(id: string, pid: string | null, text: string, color: string, side: BranchSide, note = '', icon = 'none'): MindNode {
  return { id, parentId: pid, text, note, x: 0, y: 0, color, icon, progress: 0, collapsed: false, side, width: DEFAULT_W, tags: [], hyperlink: '' };
}

/* ════════════════════════════════════════════════════════════ */
@Injectable({ providedIn: 'root' })
export class MindMapService {
  readonly icons = ICONS;
  readonly layoutTemplates = LAYOUT_TEMPLATES;
  readonly themeTemplates = THEME_TEMPLATES;
  readonly lineStyles = LINE_STYLES;
  readonly branchColors = BRANCH_COLORS;

  readonly doc = signal<MindMapDoc>(this.loadDoc());
  readonly selectedId = signal('root');
  readonly searchText = signal('');
  readonly replaceText = signal('');
  readonly zoom = signal(0.9);
  readonly pan = signal({ x: 500, y: 400 });
  readonly layoutBusy = signal(false);
  readonly importError = signal('');
  readonly editingId = signal<string | null>(null);
  readonly contextMenu = signal<{ x: number; y: number; nodeId: string } | null>(null);

  private history: MindMapDoc[] = [];
  private future: MindMapDoc[] = [];
  private drag: DragState = null;
  private canvasElement?: HTMLElement;

  /* ── computed ── */
  readonly visibleNodes = computed(() => {
    const nodes = this.doc().nodes;
    const hidden = new Set<string>();
    const collapsed = new Set(nodes.filter(n => n.collapsed).map(n => n.id));
    for (const id of collapsed) this.collectDescInto(id, nodes, hidden);
    return nodes.filter(n => !hidden.has(n.id));
  });

  readonly connectors = computed<Connector[]>(() => {
    const vis = new Set(this.visibleNodes().map(n => n.id));
    const nm = new Map(this.doc().nodes.map(n => [n.id, n]));
    const ls = this.doc().lineStyle || 'curve';
    const out: Connector[] = [];
    for (const n of this.doc().nodes) {
      if (!n.parentId || !vis.has(n.id) || !vis.has(n.parentId)) continue;
      const p = nm.get(n.parentId);
      if (!p) continue;
      out.push({ id: n.id, path: this.buildPath(p, n, ls), color: n.color });
    }
    return out;
  });

  readonly selectedNode = computed(() => this.doc().nodes.find(n => n.id === this.selectedId()) ?? this.doc().nodes[0]);
  readonly outline = computed(() => this.buildOutline('root'));
  readonly stats = computed(() => {
    const ns = this.doc().nodes;
    return { total: ns.length, visible: this.visibleNodes().length, done: ns.filter(n => n.progress === 100).length };
  });
  readonly matchedIds = computed(() => {
    const q = this.searchText().trim().toLowerCase();
    if (!q) return new Set<string>();
    return new Set(this.doc().nodes.filter(n => `${n.text} ${n.note}`.toLowerCase().includes(q)).map(n => n.id));
  });
  readonly canvasTransform = computed(() => {
    const p = this.pan(); return `translate(${p.x}px, ${p.y}px) scale(${this.zoom()})`;
  });
  readonly themeColor = computed(() => THEME_TEMPLATES.find(t => t.theme === this.doc().theme)?.colors[0] ?? '#4A90D9');
  readonly currentLineStyleName = computed(() => LINE_STYLES.find(l => l.type === (this.doc().lineStyle || 'curve'))?.name ?? '曲线');

  readonly connectorSvgStyle = computed(() => {
    const ns = this.visibleNodes();
    if (!ns.length) return { left: '-2000px', top: '-2000px', width: '4000px', height: '4000px' };
    const pad = 600;
    const xs = ns.map(n => n.x), ys = ns.map(n => n.y);
    const minX = Math.min(...xs) - pad, minY = Math.min(...ys) - pad;
    return { left: `${minX}px`, top: `${minY}px`, width: `${Math.max(...xs) + pad - minX}px`, height: `${Math.max(...ys) + pad - minY}px` };
  });
  readonly connectorViewBox = computed(() => {
    const s = this.connectorSvgStyle();
    return `${parseInt(s.left)} ${parseInt(s.top)} ${parseInt(s.width)} ${parseInt(s.height)}`;
  });

  /* ── lifecycle ── */
  constructor() {
    // Always re-layout on startup to guarantee correct positions
    this.runLayout(this.doc(), false);
    this.saveDoc();
  }

  setCanvas(el?: HTMLElement): void {
    this.canvasElement = el;
    // Fit view once canvas is available
    setTimeout(() => this.fitView(el), 50);
  }

  /* ── editing helpers ── */
  startEdit(id: string): void { this.editingId.set(id); }
  endEdit(): void { this.editingId.set(null); }
  selectNode(id: string): void { this.selectedId.set(id); }
  updateTitle(t: string): void { this.mutate(d => ({ ...d, title: t })); }

  updateSelected(patch: Partial<MindNode>): void {
    const sid = this.selectedId();
    this.mutate(d => ({ ...d, nodes: d.nodes.map(n => n.id === sid ? { ...n, ...patch } : n) }));
  }
  updateNodeText(id: string, text: string): void {
    this.mutate(d => ({ ...d, nodes: d.nodes.map(n => n.id === id ? { ...n, text } : n) }));
  }

  addChild(): void {
    const par = this.selectedNode();
    const ch = this.childrenOf(par.id);
    const side = par.id === 'root' ? this.nextSide() : par.side;
    const color = par.id === 'root' ? BRANCH_COLORS[ch.length % BRANCH_COLORS.length] : par.color;
    const c: MindNode = {
      id: this.uid(), parentId: par.id, text: '新主题', note: '',
      x: par.x, y: par.y, color, icon: 'none', progress: 0,
      collapsed: false, side, width: DEFAULT_W, tags: [], hyperlink: '',
    };
    this.mutate(d => ({ ...d, nodes: [...d.nodes, c] }));
    this.selectedId.set(c.id);
    this.autoLayout(false);
  }

  addSibling(): void {
    const cur = this.selectedNode();
    if (!cur.parentId) { this.addChild(); return; }
    const s: MindNode = { ...cur, id: this.uid(), text: '同级主题', note: '', y: cur.y + 60, collapsed: false };
    this.mutate(d => ({ ...d, nodes: [...d.nodes, s] }));
    this.selectedId.set(s.id);
    this.autoLayout(false);
  }

  deleteSelected(): void {
    const sel = this.selectedNode();
    if (!sel.parentId) return;
    const ids = this.collectDesc(sel.id);
    this.mutate(d => ({ ...d, nodes: d.nodes.filter(n => !ids.has(n.id)) }));
    this.selectedId.set(sel.parentId);
    this.autoLayout(false);
  }

  toggleCollapse(id = this.selectedId()): void {
    this.mutate(d => ({ ...d, nodes: d.nodes.map(n => n.id === id ? { ...n, collapsed: !n.collapsed } : n) }));
  }

  setLayout(layout: LayoutMode): void {
    this.mutate(d => ({ ...d, layout }));
    this.autoLayout();
    setTimeout(() => this.fitView(this.canvasElement), 160);
  }
  setTheme(theme: ThemeName): void { this.mutate(d => ({ ...d, theme })); }
  setLineStyle(ls: LineStyleType): void { this.mutate(d => ({ ...d, lineStyle: ls })); }

  resetDemo(): void {
    this.mutate(() => this.createDemoDoc());
    this.selectedId.set('root');
    this.autoLayout(false);
    setTimeout(() => this.fitView(), 50);
  }

  /* ══════════════════════════════════════════════════════════
     LAYOUT ENGINE — 保证无重叠的专业布局
     ══════════════════════════════════════════════════════════ */

  autoLayout(record = true): void {
    if (record) this.pushHistory();
    this.layoutBusy.set(true);
    const d = structuredClone(this.doc());
    this.runLayout(d, true);
    this.doc.set(d);
    this.saveDoc();
    setTimeout(() => { this.layoutBusy.set(false); this.fitView(this.canvasElement); }, 120);
  }

  /** 核心布局调度 — 对 doc 原地修改节点坐标 */
  private runLayout(doc: MindMapDoc, _propagateColors: boolean): void {
    const root = doc.nodes.find(n => n.id === 'root');
    if (!root) return;
    root.x = 0; root.y = 0;

    // 传播分支颜色
    this.propagateColors(doc);

    switch (doc.layout) {
      case 'balanced': this.doBalanced(doc); break;
      case 'right': this.doRight(doc); break;
      case 'logic': this.doVertical(doc, 240, 120); break;
      case 'orgchart': this.doVertical(doc, 260, 140); break;
      case 'tree': this.doVertical(doc, 220, 110); break;
      case 'timeline': this.doTimeline(doc); break;
      case 'fishbone': this.doFishbone(doc); break;
      default: this.doBalanced(doc);
    }
  }

  /** balanced: 根居中，左右对称展开 */
  private doBalanced(doc: MindMapDoc): void {
    const root = doc.nodes.find(n => n.id === 'root')!;
    const R = doc.nodes.filter(n => n.parentId === 'root' && n.side === 'right');
    const L = doc.nodes.filter(n => n.parentId === 'root' && n.side === 'left');
    // 如果没有分配side，自动分配
    if (!R.length && !L.length) {
      const ch = doc.nodes.filter(n => n.parentId === 'root');
      ch.forEach((n, i) => { n.side = i % 2 === 0 ? 'right' : 'left'; });
      R.push(...ch.filter(n => n.side === 'right'));
      L.push(...ch.filter(n => n.side === 'left'));
    }
    const hGap = 280;
    const vGap = 16;
    this.layoutH(doc.nodes, R, 1, root.width / 2 + hGap, vGap);
    this.layoutH(doc.nodes, L, -1, -(root.width / 2 + hGap), vGap);
  }

  /** right: 全部向右 */
  private doRight(doc: MindMapDoc): void {
    const root = doc.nodes.find(n => n.id === 'root')!;
    const ch = doc.nodes.filter(n => n.parentId === 'root');
    ch.forEach(n => n.side = 'right');
    this.layoutH(doc.nodes, ch, 1, root.width / 2 + 280, 16);
  }

  /** horizontal 布局核心 */
  private layoutH(nodes: MindNode[], roots: MindNode[], dir: 1 | -1, startX: number, vGap: number): void {
    if (!roots.length) return;
    const hGap = 280;
    const total = this.subtreeHeight(roots, nodes, vGap);
    let cy = -total / 2;
    for (const r of roots) {
      const h = this.subtreeHeight([r], nodes, vGap);
      this.placeH(nodes, r, dir, startX, cy + h / 2, vGap, hGap);
      cy += h + vGap;
    }
  }

  private placeH(nodes: MindNode[], node: MindNode, dir: 1 | -1, x: number, cy: number, vGap: number, hGap: number): void {
    node.x = x;
    node.y = cy;
    node.side = dir === 1 ? 'right' : 'left';
    const ch = nodes.filter(n => n.parentId === node.id);
    if (!ch.length) return;
    const total = this.subtreeHeight(ch, nodes, vGap);
    let cursor = cy - total / 2;
    const childX = x + dir * hGap;
    for (const c of ch) {
      const h = this.subtreeHeight([c], nodes, vGap);
      this.placeH(nodes, c, dir, childX, cursor + h / 2, vGap, hGap);
      cursor += h + vGap;
    }
  }

  /** 计算子树总高度 */
  private subtreeHeight(roots: MindNode[], all: MindNode[], gap: number): number {
    if (!roots.length) return 0;
    let total = 0;
    roots.forEach((n, i) => {
      if (i > 0) total += gap;
      const ch = all.filter(c => c.parentId === n.id);
      total += ch.length ? this.subtreeHeight(ch, all, gap) : NODE_H;
    });
    return total;
  }

  /** vertical 布局 (logic / orgchart / tree) */
  private doVertical(doc: MindMapDoc, hGap: number, vGap: number): void {
    const root = doc.nodes.find(n => n.id === 'root')!;
    const ch = doc.nodes.filter(n => n.parentId === root.id);
    if (!ch.length) return;
    const subGap = 40;
    const total = this.subtreeWidth(ch, doc.nodes, subGap);
    let cx = -total / 2;
    for (const c of ch) {
      const w = this.subtreeWidth([c], doc.nodes, subGap);
      this.placeV(doc.nodes, c, cx + w / 2, vGap, hGap, vGap, subGap);
      cx += w + subGap;
    }
  }

  private placeV(nodes: MindNode[], node: MindNode, cx: number, y: number, hGap: number, vGap: number, subGap: number): void {
    node.x = cx; node.y = y;
    node.side = cx >= 0 ? 'right' : 'left';
    const ch = nodes.filter(n => n.parentId === node.id);
    if (!ch.length) return;
    const total = this.subtreeWidth(ch, nodes, subGap);
    let cursor = cx - total / 2;
    for (const c of ch) {
      const w = this.subtreeWidth([c], nodes, subGap);
      this.placeV(nodes, c, cursor + w / 2, y + vGap, hGap, vGap, subGap);
      cursor += w + subGap;
    }
  }

  private subtreeWidth(roots: MindNode[], all: MindNode[], gap: number): number {
    if (!roots.length) return 0;
    let total = 0;
    roots.forEach((n, i) => {
      if (i > 0) total += gap;
      const ch = all.filter(c => c.parentId === n.id);
      const cw = ch.length ? this.subtreeWidth(ch, all, gap) : DEFAULT_W;
      total += Math.max(cw, DEFAULT_W);
    });
    return total;
  }

  /** timeline 布局 */
  private doTimeline(doc: MindMapDoc): void {
    const root = doc.nodes.find(n => n.id === 'root')!;
    const ch = doc.nodes.filter(n => n.parentId === root.id);
    if (!ch.length) return;
    const hGap = 300;
    const total = (ch.length - 1) * hGap;
    ch.forEach((c, i) => {
      c.x = -total / 2 + i * hGap;
      c.y = 160;
      c.side = 'right';
      this.placeTimelineSub(doc.nodes, c, 110);
    });
  }
  private placeTimelineSub(nodes: MindNode[], parent: MindNode, startY: number): void {
    const ch = nodes.filter(n => n.parentId === parent.id);
    if (!ch.length) return;
    ch.forEach((c, j) => {
      c.x = parent.x; c.y = startY + j * 100; c.side = 'right';
      this.placeTimelineSub(nodes, c, c.y + 100);
    });
  }

  /** fishbone 布局 */
  private doFishbone(doc: MindMapDoc): void {
    const root = doc.nodes.find(n => n.id === 'root')!;
    const ch = doc.nodes.filter(n => n.parentId === root.id);
    if (!ch.length) return;
    const hGap = 260;
    const total = (ch.length - 1) * hGap;
    ch.forEach((c, i) => {
      const upper = i % 2 === 0;
      c.x = -total / 2 + i * hGap;
      c.y = upper ? -170 : 170;
      c.side = upper ? 'right' : 'left';
      this.placeFishSub(doc.nodes, c, upper ? 1 : -1);
    });
  }
  private placeFishSub(nodes: MindNode[], parent: MindNode, dir: number): void {
    const ch = nodes.filter(n => n.parentId === parent.id);
    if (!ch.length) return;
    ch.forEach((c, j) => {
      c.x = parent.x + dir * 200;
      c.y = parent.y + dir * (j - (ch.length - 1) / 2) * 80;
      c.side = parent.side;
      this.placeFishSub(nodes, c, dir);
    });
  }

  /** 分支颜色传播 */
  private propagateColors(doc: MindMapDoc): void {
    const ch = doc.nodes.filter(n => n.parentId === 'root');
    ch.forEach((c, i) => {
      const color = BRANCH_COLORS[i % BRANCH_COLORS.length];
      c.color = color;
      this.colorSub(c.id, color, doc.nodes);
    });
  }
  private colorSub(pid: string, color: string, nodes: MindNode[]): void {
    for (const n of nodes) {
      if (n.parentId === pid) { n.color = color; this.colorSub(n.id, color, nodes); }
    }
  }

  /* ── connector path ── */
  private buildPath(p: MindNode, c: MindNode, ls: string): string {
    const dx = c.x - p.x;
    const dy = c.y - p.y;
    const horiz = Math.abs(dx) >= Math.abs(dy);
    const half = NODE_H / 2;

    if (horiz) {
      const sx = p.x + (dx > 0 ? p.width / 2 : -p.width / 2);
      const ex = c.x + (dx > 0 ? -c.width / 2 : c.width / 2);
      if (ls === 'straight') return `M${sx},${p.y} L${ex},${c.y}`;
      if (ls === 'polyline') { const mx = (sx + ex) / 2; return `M${sx},${p.y} L${mx},${p.y} L${mx},${c.y} L${ex},${c.y}`; }
      // curve
      const cp = Math.max(40, Math.abs(ex - sx) * 0.45);
      return `M${sx},${p.y} C${sx + (dx > 0 ? cp : -cp)},${p.y} ${ex - (dx > 0 ? cp : -cp)},${c.y} ${ex},${c.y}`;
    } else {
      const sy = p.y + (dy > 0 ? half : -half);
      const ey = c.y + (dy > 0 ? -half : half);
      if (ls === 'straight') return `M${p.x},${sy} L${c.x},${ey}`;
      if (ls === 'polyline') { const my = (sy + ey) / 2; return `M${p.x},${sy} L${p.x},${my} L${c.x},${my} L${c.x},${ey}`; }
      const cp = Math.max(30, Math.abs(ey - sy) * 0.45);
      return `M${p.x},${sy} C${p.x},${sy + (dy > 0 ? cp : -cp)} ${c.x},${ey - (dy > 0 ? cp : -cp)} ${c.x},${ey}`;
    }
  }

  /* ── drag / pan / zoom ── */
  startNodeDrag(event: PointerEvent, id: string): void {
    event.stopPropagation();
    const node = this.doc().nodes.find(n => n.id === id);
    if (!node) return;
    this.selectNode(id);
    this.pushHistory();
    this.future = [];
    const descIds = this.collectDesc(id); descIds.delete(id);
    const descendants = this.doc().nodes.filter(n => descIds.has(n.id)).map(n => ({ id: n.id, origX: n.x, origY: n.y }));
    this.drag = { mode: 'node', id, startX: event.clientX, startY: event.clientY, originalX: node.x, originalY: node.y, descendants };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  startNodeResize(event: PointerEvent, id: string): void {
    event.stopPropagation();
    const node = this.doc().nodes.find(n => n.id === id);
    if (!node) return;
    this.pushHistory(); this.future = [];
    this.drag = { mode: 'resize', id, startX: event.clientX, originalWidth: node.width };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  startPan(event: PointerEvent): void {
    if ((event.target as HTMLElement).closest('.mind-node')) return;
    this.drag = { mode: 'pan', startX: event.clientX, startY: event.clientY, originalX: this.pan().x, originalY: this.pan().y };
  }

  movePointer(event: PointerEvent): void {
    if (!this.drag) return;
    const z = this.zoom();
    if (this.drag.mode === 'resize') {
      this.updateNodeW(this.drag.id, Math.max(80, this.drag.originalWidth + (event.clientX - this.drag.startX) / z));
      return;
    }
    const dx = event.clientX - this.drag.startX, dy = event.clientY - this.drag.startY;
    if (this.drag.mode === 'pan') {
      this.pan.set({ x: this.drag.originalX + dx, y: this.drag.originalY + dy });
      return;
    }
    this.dragNode(this.drag.id, this.drag.originalX + dx / z, this.drag.originalY + dy / z);
  }

  endPointer(): void {
    if (this.drag?.mode === 'node' || this.drag?.mode === 'resize') this.saveDoc();
    this.drag = null;
  }

  zoomCanvas(delta: number): void {
    this.zoom.set(Math.min(2, Math.max(0.2, Number((this.zoom() + delta).toFixed(2)))));
  }
  onCanvasWheel(event: WheelEvent): void {
    event.preventDefault();
    // Ctrl / Meta + 滚轮 = 缩放
    if (event.ctrlKey || event.metaKey) {
      this.zoomCanvas(event.deltaY > 0 ? -0.06 : 0.06);
      return;
    }
    // 普通滚轮 = 平移视图
    const speed = 1.2;
    const p = this.pan();
    this.pan.set({ x: p.x - event.deltaX * speed, y: p.y - event.deltaY * speed });
  }

  fitView(canvas?: HTMLElement): void {
    const ns = this.visibleNodes();
    if (!canvas || !ns.length) { this.zoom.set(0.9); this.pan.set({ x: 500, y: 400 }); return; }
    const b = this.mapBounds(ns);
    const vw = canvas.clientWidth, vh = canvas.clientHeight;
    const z = Math.min(1.2, Math.max(0.25, Math.min((vw - 100) / b.width, (vh - 80) / b.height)));
    this.zoom.set(Number(z.toFixed(2)));
    this.pan.set({ x: Math.round(vw / 2 - (b.minX + b.width / 2) * z), y: Math.round(vh / 2 - (b.minY + b.height / 2) * z) });
  }

  /* ── export / import ── */
  exportJson(): void { this.dl(`${this.doc().title || 'mindmap'}.json`, JSON.stringify(this.doc(), null, 2), 'application/json'); }
  exportSvg(): void { this.dl(`${this.doc().title || 'mindmap'}.svg`, this.buildSvgStr(), 'image/svg+xml'); }
  exportPng(): void {
    const svg = this.buildSvgStr();
    const ns = this.visibleNodes();
    const pad = 100;
    const xs = ns.map(n => n.x), ys = ns.map(n => n.y);
    const minX = Math.min(...xs) - pad, minY = Math.min(...ys) - pad;
    const w = Math.max(...xs) + pad - minX, h = Math.max(...ys) + pad - minY;
    const canvas = document.createElement('canvas');
    canvas.width = w * 2; canvas.height = h * 2;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(2, 2);
    const img = new Image();
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    img.onload = () => {
      ctx.drawImage(img, 0, 0, w, h); URL.revokeObjectURL(url);
      canvas.toBlob(pb => {
        if (!pb) return;
        const a = document.createElement('a'); a.href = URL.createObjectURL(pb);
        a.download = `${this.doc().title || 'mindmap'}.png`; a.click(); URL.revokeObjectURL(a.href);
      }, 'image/png');
    };
    img.src = url;
  }
  exportMarkdown(): void { this.dl(`${this.doc().title || 'mindmap'}.md`, this.buildMd('root', 0), 'text/markdown'); }

  importJson(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const next = JSON.parse(String(reader.result)) as MindMapDoc;
        if (!next.nodes?.some(n => n.id === 'root')) throw new Error('invalid');
        this.mutate(() => this.ensureDefaults(next));
        this.selectedId.set('root'); this.importError.set('');
        this.autoLayout(false);
      } catch { this.importError.set('文件格式不正确'); }
      finally { input.value = ''; }
    };
    reader.readAsText(file);
  }

  undo(): void {
    const p = this.history.pop(); if (!p) return;
    this.future.push(structuredClone(this.doc()));
    this.doc.set(p);
    this.selectedId.set(p.nodes.some(n => n.id === this.selectedId()) ? this.selectedId() : 'root');
    this.saveDoc();
  }
  redo(): void {
    const n = this.future.pop(); if (!n) return;
    this.history.push(structuredClone(this.doc()));
    this.doc.set(n); this.saveDoc();
  }

  moveNode(nodeId: string, newParentId: string): void {
    if (nodeId === 'root' || nodeId === newParentId) return;
    if (this.collectDesc(newParentId).has(nodeId)) return;
    this.mutate(d => ({ ...d, nodes: d.nodes.map(n =>
      n.id === nodeId ? { ...n, parentId: newParentId, side: n.parentId === 'root' ? n.side : d.nodes.find(p => p.id === newParentId)?.side || n.side } : n
    )}));
    this.autoLayout(false);
  }

  searchReplaceAll(): void {
    const q = this.searchText().trim(), r = this.replaceText();
    if (!q) return;
    this.mutate(d => ({ ...d, nodes: d.nodes.map(n => ({ ...n, text: n.text.replaceAll(q, r), note: n.note.replaceAll(q, r) })) }));
  }

  showContextMenu(event: MouseEvent, nodeId: string): void {
    event.preventDefault(); event.stopPropagation();
    this.selectNode(nodeId);
    this.contextMenu.set({ x: event.clientX, y: event.clientY, nodeId });
  }
  hideContextMenu(): void { this.contextMenu.set(null); }

  addTag(tag: string): void {
    if (!tag.trim()) return;
    const id = this.selectedId();
    this.mutate(d => ({ ...d, nodes: d.nodes.map(n => n.id === id ? { ...n, tags: [...n.tags, tag.trim()] } : n) }));
  }
  removeTag(tag: string): void {
    const id = this.selectedId();
    this.mutate(d => ({ ...d, nodes: d.nodes.map(n => n.id === id ? { ...n, tags: n.tags.filter(t => t !== tag) } : n) }));
  }

  /* ── helpers ── */
  childrenOf(pid: string): MindNode[] { return this.doc().nodes.filter(n => n.parentId === pid); }
  hasChildren(id: string): boolean { return this.doc().nodes.some(n => n.parentId === id); }

  nodeClasses(node: MindNode): Record<string, boolean> {
    return { selected: node.id === this.selectedId(), matched: this.matchedIds().has(node.id), root: node.id === 'root', collapsed: node.collapsed };
  }

  outlineLevelStyle(level: number): Record<string, string> {
    return { '--guide-left': `${8 + level * 14}px`, 'padding-left': `${6 + level * 14}px` };
  }

  iconLabel(icon: string): string {
    return ({ star: '★', flag: '⚑', check: '✓', idea: '!', warn: '?' } as Record<string, string>)[icon] ?? '';
  }

  /* ── private ── */
  private mutate(updater: (doc: MindMapDoc) => MindMapDoc): void {
    this.pushHistory();
    this.doc.set(this.ensureDefaults(updater(structuredClone(this.doc()))));
    this.future = [];
    this.saveDoc();
  }
  private pushHistory(): void { this.history.push(structuredClone(this.doc())); this.history = this.history.slice(-60); }

  private ensureDefaults(doc: MindMapDoc): MindMapDoc {
    return {
      ...doc,
      lineStyle: doc.lineStyle || 'curve',
      nodes: doc.nodes.map(n => ({ ...n, width: n.width || DEFAULT_W, tags: n.tags || [], hyperlink: n.hyperlink || '' })),
    };
  }

  private dragNode(id: string, x: number, y: number): void {
    const drag = this.drag;
    this.doc.update(d => ({
      ...d,
      nodes: d.nodes.map(n => {
        if (n.id === id) return { ...n, x, y };
        if (drag?.mode === 'node') {
          const desc = drag.descendants.find(dd => dd.id === n.id);
          if (desc) return { ...n, x: desc.origX + (x - drag.originalX), y: desc.origY + (y - drag.originalY) };
        }
        return n;
      }),
    }));
  }
  private updateNodeW(id: string, w: number): void {
    this.doc.update(d => ({ ...d, nodes: d.nodes.map(n => n.id === id ? { ...n, width: w } : n) }));
  }

  private buildOutline(pid: string, level = 0): Array<MindNode & { level: number }> {
    return this.childrenOf(pid).flatMap(n => [{ ...n, level }, ...(n.collapsed ? [] : this.buildOutline(n.id, level + 1))]);
  }

  private nextSide(): BranchSide {
    const ch = this.childrenOf('root');
    return ch.filter(n => n.side === 'right').length <= ch.filter(n => n.side === 'left').length ? 'right' : 'left';
  }

  private collectDescInto(id: string, nodes: MindNode[], result: Set<string>): void {
    for (const n of nodes) { if (n.parentId === id) { result.add(n.id); this.collectDescInto(n.id, nodes, result); } }
  }
  private collectDesc(id: string): Set<string> {
    const ids = new Set([id]);
    for (const c of this.childrenOf(id)) for (const i of this.collectDesc(c.id)) ids.add(i);
    return ids;
  }
  private mapBounds(nodes: MindNode[]): { minX: number; minY: number; width: number; height: number } {
    const hw = Math.max(...nodes.map(n => n.width / 2)) + 30;
    const minX = Math.min(...nodes.map(n => n.x - hw)), maxX = Math.max(...nodes.map(n => n.x + hw));
    const minY = Math.min(...nodes.map(n => n.y - 50)), maxY = Math.max(...nodes.map(n => n.y + 50));
    return { minX, minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
  }

  private saveDoc(): void { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.doc())); }
  private loadDoc(): MindMapDoc {
    const s = localStorage.getItem(STORAGE_KEY);
    if (s) { try { return this.ensureDefaults(JSON.parse(s)); } catch { localStorage.removeItem(STORAGE_KEY); } }
    return this.createDemoDoc();
  }

  private createDemoDoc(): MindMapDoc {
    return {
      title: '产品设计流程',
      layout: 'balanced', theme: 'ocean', lineStyle: 'curve',
      nodes: [
        mkNode('root', null, '产品设计流程', '#2C3E50', 'right', '从需求到上线的完整流程', 'idea'),
        mkNode('n1', 'root', '需求分析', '#4A90D9', 'right', '用户调研与需求梳理', 'star'),
        mkNode('n2', 'n1', '用户访谈', '#4A90D9', 'right', '', 'check'),
        mkNode('n3', 'n1', '竞品分析', '#4A90D9', 'right', '', 'flag'),
        mkNode('n4', 'n1', '需求文档', '#4A90D9', 'right', 'PRD 编写'),
        mkNode('n5', 'root', '设计阶段', '#E74C3C', 'right', '交互与视觉设计', 'idea'),
        mkNode('n6', 'n5', '交互设计', '#E74C3C', 'right', '', 'check'),
        mkNode('n7', 'n5', '视觉设计', '#E74C3C', 'right', '', 'star'),
        mkNode('n8', 'root', '开发实现', '#2ECC71', 'left', '前后端开发', 'flag'),
        mkNode('n9', 'n8', '前端开发', '#2ECC71', 'left', '', 'check'),
        mkNode('n10', 'n8', '后端开发', '#2ECC71', 'left', ''),
        mkNode('n11', 'root', '测试上线', '#F39C12', 'left', '质量保证与发布', 'warn'),
        mkNode('n12', 'n11', '功能测试', '#F39C12', 'left', '', 'check'),
        mkNode('n13', 'n11', '性能测试', '#F39C12', 'left', '', 'flag'),
      ],
    };
  }

  private uid(): string { return `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`; }
  private dl(name: string, content: string, type: string): void {
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([content], { type }));
    a.download = name; a.click(); URL.revokeObjectURL(a.href);
  }
  private escapeXml(v: string): string { return v.replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' } as Record<string, string>)[c] ?? c); }

  private buildSvgStr(): string {
    const ns = this.visibleNodes();
    if (!ns.length) return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"></svg>';
    const pad = 80;
    const xs = ns.map(n => n.x), ys = ns.map(n => n.y);
    const hw = Math.max(...ns.map(n => n.width / 2)) + pad;
    const minX = Math.min(...xs) - hw, minY = Math.min(...ys) - pad;
    const w = Math.max(...xs) + hw - minX, h = Math.max(...ys) + pad - minY;
    const conns = this.connectors().map(c => `<path d="${c.path}" fill="none" stroke="${c.color}" stroke-width="2.5" opacity="0.5"/>`).join('');
    const items = ns.map(n =>
      `<g transform="translate(${n.x - n.width / 2},${n.y - NODE_H / 2})"><rect width="${n.width}" height="${NODE_H}" rx="8" fill="${n.id === 'root' ? n.color : 'white'}" stroke="${n.color}" stroke-width="2"/><text x="${n.width / 2}" y="${NODE_H / 2 + 5}" text-anchor="middle" font-size="13" font-family="system-ui,sans-serif" fill="${n.id === 'root' ? 'white' : '#333'}">${this.escapeXml(n.text)}</text></g>`
    ).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX} ${minY} ${w} ${h}">${conns}${items}</svg>`;
  }

  private buildMd(pid: string, level: number): string {
    const ch = this.doc().nodes.filter(n => n.parentId === pid);
    let r = '';
    for (const c of ch) {
      const pfx = level === 0 ? '# ' : `${'  '.repeat(level - 1)}- `;
      r += `${pfx}${c.text}\n`;
      if (c.note) r += `${'  '.repeat(level)}  ${c.note}\n`;
      r += this.buildMd(c.id, level + 1);
    }
    return r;
  }
}
