import { useEffect, useRef } from 'react';

/** Hairlines on the rulers that follow the pointer across the drawing, as in the prototype (.mk.m). */
export function RulerCursor() {
  const x = useRef<HTMLElement>(null);
  const y = useRef<HTMLElement>(null);

  useEffect(() => {
    let frame = 0;
    let pointer: { x: number; y: number } | null = null;
    const place = () => {
      frame = 0;
      const root = getComputedStyle(document.documentElement);
      const left = Number.parseFloat(root.getPropertyValue('--rul')) || 22;
      const top = (Number.parseFloat(root.getPropertyValue('--hdr')) || 64) + left;
      const inX = !!pointer && pointer.x >= left;
      const inY = !!pointer && pointer.y >= top;
      if (x.current) {
        x.current.style.display = inX ? 'block' : 'none';
        if (pointer) x.current.style.transform = `translateX(${pointer.x}px)`;
      }
      if (y.current) {
        y.current.style.display = inY ? 'block' : 'none';
        if (pointer) y.current.style.transform = `translateY(${pointer.y}px)`;
      }
    };
    const onMove = (event: PointerEvent) => {
      pointer = { x: event.clientX, y: event.clientY };
      frame ||= requestAnimationFrame(place);
    };
    const onLeave = () => {
      pointer = null;
      place();
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    document.documentElement.addEventListener('pointerleave', onLeave);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', onMove);
      document.documentElement.removeEventListener('pointerleave', onLeave);
    };
  }, []);

  return (
    <>
      <i ref={x} aria-hidden="true" className="f-cursor x" style={{ display: 'none' }} />
      <i ref={y} aria-hidden="true" className="f-cursor y" style={{ display: 'none' }} />
    </>
  );
}
