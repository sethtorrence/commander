import {
  Button,
  ButtonGroup,
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogHeading,
  DialogTitle,
  DialogTrigger,
  Input,
  Kbd,
  Led,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
  Switch,
  type Theme,
  ToastView,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  toast,
} from '@commander/ui';
import { type ReactNode, useState } from 'react';
import { Caption } from './Plate';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[88px_minmax(0,1fr)] items-center gap-3 border-b border-line2 px-3.5 py-2.5 last:border-b-0">
      <Caption>{label}</Caption>
      <div className="flex min-w-0 flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

export function ButtonsSpecimen() {
  return (
    <div>
      <Row label="Variants">
        <Button>Clear</Button>
        <Button variant="primary">Open in Calendar</Button>
        <Button variant="signal">Accept</Button>
        <Button variant="ghost">Dismiss</Button>
      </Row>
      <Row label="Sizes">
        <Button size="sm">Change</Button>
        <Button>Clear</Button>
        <Button size="lg">Open the Daily Note</Button>
      </Row>
      <Row label="With keys">
        <ButtonGroup>
          <Button variant="primary">
            <Kbd>↵</Kbd>Open in Calendar
          </Button>
          <Button>
            <Kbd>E</Kbd>Clear
          </Button>
        </ButtonGroup>
        <Button variant="signal">
          Ask for an update <Kbd>U</Kbd>
        </Button>
      </Row>
      <Row label="Disabled">
        <Button disabled>Clear</Button>
        <Button variant="primary" disabled>
          Open
        </Button>
      </Row>
    </div>
  );
}

export function FieldsSpecimen({ theme }: { theme: Theme }) {
  return (
    <div>
      <Row label="Input">
        <Input placeholder="Add a Todo…" aria-label={`Add a Todo (${theme})`} className="max-w-64" />
      </Row>
      <Row label="Mono">
        <Input font="mono" defaultValue="ENG-412" aria-label={`Linear ID (${theme})`} className="max-w-32" />
        <Input
          font="mono"
          defaultValue="ENG-41"
          aria-invalid
          aria-label={`Invalid ID (${theme})`}
          className="max-w-32"
        />
      </Row>
      <Row label="Select">
        <Select defaultValue="lt">
          <SelectTrigger className="max-w-52" aria-label={`Project (${theme})`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectLabel>Project</SelectLabel>
              <SelectItem value="all">Everything</SelectItem>
              <SelectItem value="lt">Longtail</SelectItem>
              <SelectItem value="tl">Titanlink</SelectItem>
              <SelectItem value="tx">Tactics</SelectItem>
            </SelectGroup>
            <SelectSeparator />
            <SelectItem value="none">Unfiled</SelectItem>
          </SelectContent>
        </Select>
      </Row>
      <Row label="Switch">
        <SwitchSpecimen theme={theme} />
      </Row>
    </div>
  );
}

function SwitchSpecimen({ theme }: { theme: Theme }) {
  const [on, setOn] = useState(true);
  return (
    <>
      <Switch checked={on} onCheckedChange={setOn} aria-label={`Start at login (${theme})`} />
      <Switch checked={false} disabled aria-label={`Unavailable (${theme})`} />
    </>
  );
}

export function OverlaysSpecimen({ theme }: { theme: Theme }) {
  return (
    <div>
      <Row label="Dialog">
        <Dialog>
          <DialogTrigger asChild>
            <Button data-testid={`open-dialog-${theme}`}>Open dialog</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader partNumber="PRJ-03">
              <DialogTitle>Change Project</DialogTitle>
            </DialogHeader>
            <DialogBody>
              <DialogHeading>Move to Titanlink?</DialogHeading>
              <DialogDescription>
                ENG-412 and its 3 Linked Items move with it. A Rule can file the rest of this Linear project.
              </DialogDescription>
            </DialogBody>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="ghost">Cancel</Button>
              </DialogClose>
              <DialogClose asChild>
                <Button variant="primary">
                  Move <Kbd>↵</Kbd>
                </Button>
              </DialogClose>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </Row>
      <Row label="Tooltip">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost">Hover me</Button>
          </TooltipTrigger>
          <TooltipContent side="right">Switch to light</TooltipContent>
        </Tooltip>
      </Row>
      <Row label="Toast">
        <Button
          onClick={() =>
            toast('Todo ticked: Review Priya’s backoff design doc', {
              action: { label: 'Undo', onClick: () => {} },
            })
          }
        >
          Raise a toast
        </Button>
      </Row>
      <div className="px-3.5 pt-1 pb-3.5">
        <ToastView action="Undo">
          <b>Accepted.</b> Give Priya Acme sandbox access is now a Todo.
        </ToastView>
      </div>
    </div>
  );
}

export function MarksSpecimen() {
  return (
    <div>
      <Row label="Keys">
        <Kbd>↵</Kbd>
        <Kbd>Tab</Kbd>
        <Kbd>Ctrl ↵</Kbd>
        <Kbd>[[</Kbd>
        <Kbd tone="signal">U</Kbd>
      </Row>
      <Row label="Lamps">
        <span className="flex items-center gap-2 font-mono text-label uppercase tracking-caps text-signal-ink">
          <Led size="sm" />
          Live
        </span>
        <span className="flex items-center gap-2 font-mono text-label uppercase tracking-caps text-muted">
          <Led size="sm" state="off" />
          Away
        </span>
        <span className="flex items-center gap-2 font-mono text-label uppercase tracking-caps text-muted">
          <Led state="muted" />
          Has a note
        </span>
      </Row>
    </div>
  );
}
