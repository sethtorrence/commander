import { attachmentUrl } from '@commander/domain';
import { type DragEvent, type KeyboardEvent, memo, useState } from 'react';
import { imageFiles, readImages } from './block-editor';
import { focusText, neighbour, useControls } from './OutlineView';
import type { Block } from './outline';

/*
  An image Block: the pasted image in place of the editable text. Its Markdown (`![](attachments/…)`)
  is kept as the Block's text but not edited here. The row is still a Block to the outliner keys:
  the arrows move past it, Enter starts a Block below, Backspace or Delete removes it (and undo, with
  Ctrl+Z, brings it back), Tab and Alt+Shift+arrows move it. The image comes from attachment://, which
  the main process serves from the attachments folder alone.
*/

interface BlockImageProps {
  day: string;
  block: Block;
  /** The attachment's file name. */
  name: string;
}

export const BlockImage = memo(function BlockImage({ day, block, name }: BlockImageProps) {
  const { notebook, focus } = useControls();
  const [size, setSize] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const { id } = block;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    const mod = event.ctrlKey || event.metaKey;
    const plain = !mod && !event.altKey && !event.shiftKey;
    const take = () => event.preventDefault();

    if (plain && (event.key === 'ArrowUp' || event.key === 'ArrowLeft')) {
      take();
      const target = neighbour(element, -1);
      if (target) focusText(target, 'end');
    } else if (plain && (event.key === 'ArrowDown' || event.key === 'ArrowRight')) {
      take();
      const target = neighbour(element, 1);
      if (target) focusText(target, 0);
    } else if (plain && event.key === 'Enter') {
      take();
      focus(notebook.enter(day, id, block.text.length, block.text.length));
    } else if (plain && (event.key === 'Backspace' || event.key === 'Delete')) {
      take();
      focus(notebook.remove(day, id));
    } else if (!mod && !event.altKey && event.key === 'Tab') {
      take();
      focus(event.shiftKey ? notebook.outdent(day, id, 0) : notebook.indent(day, id, 0));
    } else if (event.altKey && event.shiftKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      take();
      focus(notebook.move(day, id, event.key === 'ArrowUp' ? 'up' : 'down', 0));
    } else if (mod && !event.altKey && event.key === '.') {
      take();
      notebook.toggleFold(day, id);
    }
  };

  const attach = (files: File[]) =>
    void readImages(files)
      .then((images) => notebook.attach(day, id, images))
      .then(focus);
  const allowDrop = (event: DragEvent) => {
    if (event.dataTransfer.types.includes('Files')) event.preventDefault();
  };

  const type = name.slice(name.lastIndexOf('.') + 1).toUpperCase();
  return (
    <figure
      className="n-content n-image"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: an image Block is a stop for the outliner keys
      tabIndex={0}
      aria-label="Image Block"
      data-block-text=""
      data-block-id={id}
      data-image=""
      onKeyDown={onKeyDown}
      onPaste={(event) => {
        const images = imageFiles(event.clipboardData);
        if (!images.length) return;
        event.preventDefault();
        attach(images);
      }}
      onDragOver={allowDrop}
      onDrop={(event) => {
        event.preventDefault();
        const images = imageFiles(event.dataTransfer);
        if (images.length) attach(images);
      }}
      onBlur={() => void notebook.flush()}
    >
      {missing ? (
        <div className="n-img-missing">Image not found · {name.slice(0, 8)}</div>
      ) : (
        <img
          src={attachmentUrl(name)}
          alt="Pasted"
          draggable={false}
          onLoad={(event) =>
            setSize(`${event.currentTarget.naturalWidth}×${event.currentTarget.naturalHeight}`)
          }
          onError={() => setMissing(true)}
        />
      )}
      <figcaption className="n-img-cap">
        <span>Img</span>
        <span>{name.slice(0, 8)}</span>
        <span>{type}</span>
        {size && <span>{size}</span>}
      </figcaption>
    </figure>
  );
});
