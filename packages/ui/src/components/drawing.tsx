import { type ComponentProps, type CSSProperties, useLayoutEffect, useRef, useState } from 'react';
import { cn } from '../lib/cn';

const pad = (n: number) => String(n).padStart(2, '0');
const letter = (i: number) => String.fromCharCode(65 + i);

export const DRAWING_COLUMNS = 8;
export const DRAWING_ROWS = 24;

/** The top ruler: a corner cell, then columns lettered A–H. `active` lights the column in use. */
export function RulerX({
  columns = DRAWING_COLUMNS,
  active,
  className,
  style,
  ...props
}: ComponentProps<'div'> & { columns?: number; active?: number }) {
  return (
    <div
      aria-hidden="true"
      data-slot="ruler-x"
      className={cn('c-ruler-x', className)}
      style={{ '--cols': columns, ...style } as CSSProperties}
      {...props}
    >
      <div className="k">0</div>
      {Array.from({ length: columns }, (_, i) => (
        <div key={letter(i)} className={cn('c', i === active && 'on')}>
          {letter(i)}
        </div>
      ))}
    </div>
  );
}

/** The side ruler: rows numbered 01–24. `active` lights the row in use. */
export function RulerY({
  rows = DRAWING_ROWS,
  active,
  className,
  style,
  ...props
}: ComponentProps<'div'> & { rows?: number; active?: number }) {
  return (
    <div
      aria-hidden="true"
      data-slot="ruler-y"
      className={cn('c-ruler-y', className)}
      style={{ '--rows': rows, ...style } as CSSProperties}
      {...props}
    >
      {Array.from({ length: rows }, (_, i) => (
        <div key={pad(i + 1)} className={cn('r', i === active && 'on')}>
          {pad(i + 1)}
        </div>
      ))}
    </div>
  );
}

function gridPaths(width: number, height: number, columns: number, rows: number) {
  const cw = width / columns;
  const rh = height / rows;
  let col = '';
  let row = '';
  let cross = '';
  for (let i = 1; i < columns; i++) col += `M${Math.round(i * cw) + 0.5} 0V${height}`;
  for (let j = 1; j < rows; j++) row += `M0 ${Math.round(j * rh) + 0.5}H${width}`;
  for (let i = 0; i <= columns; i++) {
    for (let j = 0; j <= rows; j++) {
      const x = Math.round(i * cw) + 0.5;
      const y = Math.round(j * rh) + 0.5;
      cross += `M${x - 4} ${y}H${x + 4}M${x} ${y - 4}V${y + 4}`;
    }
  }
  return { col, row, cross };
}

/** The exposed grid behind the sheets: column and row lines with a cross at every intersection. */
export function DrawingGrid({
  columns = DRAWING_COLUMNS,
  rows = DRAWING_ROWS,
  className,
  ...props
}: ComponentProps<'div'> & { columns?: number; rows?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() =>
      setSize({ width: element.clientWidth, height: element.clientHeight }),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const paths = size.width && size.height ? gridPaths(size.width, size.height, columns, rows) : null;
  return (
    <div ref={ref} aria-hidden="true" data-slot="drawing-grid" className={cn('c-grid', className)} {...props}>
      {paths && (
        <svg viewBox={`0 0 ${size.width} ${size.height}`} role="presentation">
          <path className="gr" d={paths.row} />
          <path className="gc" d={paths.col} />
          <path className="gx" d={paths.cross} />
        </svg>
      )}
    </div>
  );
}

export interface DrawingProps extends ComponentProps<'div'> {
  columns?: number;
  rows?: number;
  /** The column and row to light on the rulers (zero-based), e.g. where the caret is. */
  active?: { column?: number; row?: number };
}

/**
 * A technical drawing: rulers along the top and left, the exposed grid, and the sheets laid on it.
 * Children are placed on the grid's field; use an 8-column CSS grid inside to align with the rulers.
 */
export function Drawing({
  columns = DRAWING_COLUMNS,
  rows = DRAWING_ROWS,
  active,
  className,
  children,
  ...props
}: DrawingProps) {
  return (
    <div data-slot="drawing" className={cn('c-drawing', className)} {...props}>
      <RulerX columns={columns} active={active?.column} />
      <RulerY rows={rows} active={active?.row} />
      <div className="c-drawing-field">
        <DrawingGrid columns={columns} rows={rows} />
        <div className="c-drawing-content">{children}</div>
      </div>
    </div>
  );
}

/** A dimension line spanning its box, with a mono label (e.g. "B–E · Daily Note · 753"). */
export function DimensionLine({ className, children, ...props }: ComponentProps<'div'>) {
  return (
    <div aria-hidden="true" data-slot="dimension-line" className={cn('c-dim', className)} {...props}>
      <span>{children}</span>
    </div>
  );
}
