import { type EmailAddress, formatAddress, parseAddresses } from '@commander/domain';
import { cn } from '@commander/ui';
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';

/*
  To, Cc and Bcc (#138): each address a chip, with suggestions from the User's own mail as they type
  (those they have written to first). Enter, Tab, a comma or leaving the field takes what was typed;
  Backspace in an empty field takes the last address off.
*/

export function AddressField({
  label,
  addresses,
  onChange,
  suggest,
  autoFocus = false,
}: {
  label: string;
  addresses: EmailAddress[];
  onChange: (addresses: EmailAddress[]) => void;
  suggest: (text: string) => Promise<EmailAddress[]>;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState('');
  const [found, setFound] = useState<EmailAddress[]>([]);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const asked = useRef(0);

  useEffect(() => {
    const wanted = text.trim();
    if (!wanted) {
      setFound([]);
      return;
    }
    const ask = ++asked.current;
    const timer = setTimeout(() => {
      suggest(wanted).then(
        (answer) => {
          if (ask !== asked.current) return;
          const taken = new Set(addresses.map((each) => each.address.toLowerCase()));
          setFound(answer.filter((each) => !taken.has(each.address.toLowerCase())));
          setActive(0);
        },
        () => setFound([]),
      );
    }, 120);
    return () => clearTimeout(timer);
  }, [text, suggest, addresses]);

  const add = (more: EmailAddress[]) => {
    const taken = new Set(addresses.map((each) => each.address.toLowerCase()));
    const fresh = more.filter((each) => !taken.has(each.address.toLowerCase()));
    if (fresh.length) onChange([...addresses, ...fresh]);
    setText('');
    setFound([]);
  };

  const take = () => {
    const parsed = parseAddresses(text);
    if (parsed.length) add(parsed);
    return parsed.length > 0;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' && found.length) {
      event.preventDefault();
      setActive((at) => (at + 1) % found.length);
    } else if (event.key === 'ArrowUp' && found.length) {
      event.preventDefault();
      setActive((at) => (at - 1 + found.length) % found.length);
    } else if (event.key === 'Enter' || event.key === 'Tab' || event.key === ',' || event.key === ';') {
      const pick = found[active];
      if (pick && (event.key !== 'Tab' || text.trim())) {
        event.preventDefault();
        add([pick]);
      } else if (text.trim() && take()) event.preventDefault();
      else if (event.key === ',' || event.key === ';') event.preventDefault();
    } else if (event.key === 'Backspace' && !text && addresses.length) {
      onChange(addresses.slice(0, -1));
    } else if (event.key === 'Escape' && found.length) {
      event.preventDefault();
      event.stopPropagation();
      setFound([]);
    }
  };

  return (
    <div className="relative flex min-h-9 items-start border-b border-line2">
      <label
        htmlFor={`${listId}-input`}
        className="w-[52px] flex-none py-2.5 pl-4 font-mono text-label leading-4 font-semibold uppercase tracking-caps text-muted"
      >
        {label}
      </label>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 py-1.5 pr-3">
        {addresses.map((address) => (
          <span
            key={address.address.toLowerCase()}
            data-testid="compose-recipient"
            title={address.address}
            className="inline-flex h-6 max-w-full items-center gap-1 border border-line bg-raise px-2 text-note text-ink"
          >
            <span className="truncate">{address.name ?? address.address}</span>
            <button
              type="button"
              aria-label={`Remove ${address.address}`}
              onClick={() => onChange(addresses.filter((each) => each !== address))}
              className="cursor-pointer border-0 bg-transparent p-0 text-muted hover:text-ink"
            >
              ×
            </button>
          </span>
        ))}
        <input
          ref={input}
          id={`${listId}-input`}
          // biome-ignore lint/a11y/noAutofocus: new mail starts at To
          autoFocus={autoFocus}
          aria-label={label}
          aria-autocomplete="list"
          aria-controls={found.length ? listId : undefined}
          aria-expanded={found.length > 0}
          role="combobox"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => {
            take();
            setFound([]);
          }}
          className="h-6 min-w-[120px] flex-1 border-0 bg-transparent text-note text-ink outline-none"
        />
      </div>
      {found.length > 0 && (
        <div
          id={listId}
          role="listbox"
          aria-label={`Suggestions for ${label}`}
          className="absolute top-full left-[52px] z-20 m-0 max-h-60 w-[min(420px,90%)] overflow-y-auto border border-ink bg-sheet p-0 shadow-lg"
        >
          {found.map((address, index) => (
            <div
              key={address.address}
              role="option"
              aria-selected={index === active}
              tabIndex={-1}
              onMouseDown={(event) => {
                event.preventDefault();
                add([address]);
              }}
              className={cn(
                'cursor-pointer truncate px-3 py-1.5 text-note text-ink',
                index === active ? 'bg-signal-focus' : 'hover:bg-raise',
              )}
            >
              {formatAddress(address)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
