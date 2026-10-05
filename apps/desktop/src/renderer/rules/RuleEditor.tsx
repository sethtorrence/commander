import {
  type Bucket,
  type Item,
  type Project,
  RULE_FIELDS,
  RULE_SOURCES,
  type Rule,
  type RuleDraft,
  type RulePreview,
  type RuleTarget,
  type RuleValues,
  type RuleWhen,
} from '@commander/domain';
import {
  Badge,
  Button,
  cn,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
} from '@commander/ui';
import { type ReactNode, useEffect, useId, useMemo, useState } from 'react';
import { useProjects } from '../projects/context';
import {
  type ConditionDraft,
  draftFor,
  fieldChoices,
  firstField,
  isGroupDraft,
  newCondition,
  newGroup,
  type Placement,
  placements,
  type RulesClient,
  ruleText,
  type TermDraft,
  type WhenDraft,
  whenDraftOf,
  whenOf,
} from './rules';

const selectClass =
  'h-7.5 min-w-0 border border-line bg-sheet px-2 font-sans text-note text-ink outline-none focus-visible:border-ink';
const labelClass =
  'mb-1.5 block font-mono text-label leading-none font-semibold uppercase tracking-label text-muted';
const OPERATOR_NAMES = { is: 'is', 'is-not': 'is not', contains: 'contains' } as const;
const JOIN_NAMES = { and: 'all of', or: 'any of' } as const;

/**
 * The editor's state for a Rule being made (rule null) or edited. A new one may start from a draft
 * (a Rule Ares suggested) and have a place to go when it overlaps no other Rule (`position`: 0 is the
 * top); `onSaved` hears when it was saved.
 */
export type Editing = {
  rule: Rule | null;
  projectId?: string;
  // A new Rule sorting into this Bucket to start with (#137).
  bucketId?: string;
  draft?: RuleDraft;
  // A new Rule starting from these conditions, with its Project for the User to choose (Settings →
  // GitHub's Map to Project…, #118).
  when?: RuleWhen;
  position?: number;
  onSaved?: () => void;
};

/**
 * The Rule editor, in a dialog: which Project the Rule files into, or which Bucket it sorts email into
 * (#137), and its conditions (AND or OR, with one level of grouping; a Bucket Rule's read email only),
 * with a live count and sample of the Items they match. Saving a Rule that matches Items another Rule
 * of its kind matches too asks where it goes (above or below that Rule) first.
 */
export function RuleEditor({
  editing,
  rules,
  client,
  accountNames,
  onClose,
  onSave,
}: {
  editing: Editing | null;
  rules: readonly Rule[];
  client: RulesClient;
  /** Workspace names by Account, for the workspace field's choices. */
  accountNames?: ReadonlyMap<string, string>;
  onClose: () => void;
  /** Saves the Rule; `position` is where it goes, when the User placed it. Resolves with why it was refused, or null. */
  onSave: (rule: RuleDraft, position: number | undefined) => Promise<string | null>;
}) {
  return (
    <Dialog open={editing !== null} onOpenChange={(open) => !open && onClose()}>
      {editing && (
        <DialogContent aria-describedby={undefined} className="w-[min(760px,calc(100vw-48px))]">
          <EditorBody
            key={editing.rule?.id ?? 'new'}
            editing={editing}
            rules={rules}
            client={client}
            accountNames={accountNames}
            onClose={onClose}
            onSave={onSave}
          />
        </DialogContent>
      )}
    </Dialog>
  );
}

function EditorBody({
  editing,
  rules,
  client,
  accountNames,
  onClose,
  onSave,
}: {
  editing: Editing;
  rules: readonly Rule[];
  client: RulesClient;
  accountNames?: ReadonlyMap<string, string>;
  onClose: () => void;
  onSave: (rule: RuleDraft, position: number | undefined) => Promise<string | null>;
}) {
  const { projects, archived } = useProjects();
  const everyProject = useMemo(() => [...projects, ...archived], [projects, archived]);
  const { rule } = editing;
  const started: RuleTarget | undefined = rule?.target ?? editing.draft?.target;
  const [kind, setKind] = useState<RuleTarget['kind']>(
    started?.kind ?? (editing.bucketId && !editing.projectId ? 'bucket' : 'project'),
  );
  const [projectId, setProjectId] = useState(
    (started?.kind === 'project' ? started.projectId : undefined) ??
      editing.projectId ??
      (editing.when ? '' : projects[0]?.id) ??
      '',
  );
  const [bucketId, setBucketId] = useState(
    (started?.kind === 'bucket' ? started.bucketId : undefined) ?? editing.bucketId ?? '',
  );
  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [when, setWhen] = useState<WhenDraft>(() =>
    whenDraftOf(rule?.when ?? editing.draft?.when ?? editing.when, kind),
  );
  const [items, setItems] = useState<Item[]>([]);
  const [values, setValues] = useState<RuleValues>({});
  const [preview, setPreview] = useState<RulePreview | null>(null);
  const [placing, setPlacing] = useState<Placement[] | null>(null);
  const [position, setPosition] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const ids = {
    kind: useId(),
    project: useId(),
    bucket: useId(),
    join: useId(),
    error: useId(),
    place: useId(),
  };

  useEffect(() => {
    let current = true;
    client.items().then(
      (found) => current && setItems(found),
      () => {},
    );
    client.values().then(
      (found) => current && setValues(found),
      () => {},
    );
    client.buckets().then(
      (found) => {
        if (!current) return;
        setBuckets(found);
        setBucketId((chosen) => chosen || (found[0]?.id ?? ''));
      },
      () => {},
    );
    return () => {
      current = false;
    };
  }, [client]);

  const chooseKind = (next: RuleTarget['kind']) => {
    setKind(next);
    setWhen((drafted) => draftFor(drafted, next));
  };

  const finished = whenOf(when);
  const target: RuleTarget | null =
    kind === 'bucket'
      ? bucketId
        ? { kind: 'bucket', bucketId }
        : null
      : projectId
        ? { kind: 'project', projectId }
        : null;
  const draft: RuleDraft | null = finished && target ? { target, when: finished } : null;
  const draftKey = draft ? JSON.stringify(draft) : null;

  // The live count and sample, a moment after the conditions stop changing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `draftKey` stands for the draft
  useEffect(() => {
    if (!draft) {
      setPreview(null);
      return;
    }
    let current = true;
    const timer = setTimeout(() => {
      client.preview(draft, rule?.id).then(
        (found) => current && setPreview(found),
        (reason: unknown) => current && setError(reason instanceof Error ? reason.message : String(reason)),
      );
    }, 120);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [client, draftKey, rule?.id]);

  const save = async (at: number | undefined) => {
    if (!draft) return;
    setSaving(true);
    const refused = await onSave(draft, at);
    setSaving(false);
    if (refused) setError(refused);
  };

  const submit = async () => {
    if (!draft) return;
    setError(null);
    // Asked afresh, so the overlaps are those of the Rule exactly as saved.
    const latest = await client.preview(draft, rule?.id).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason));
      return null;
    });
    if (!latest) return;
    setPreview(latest);
    if (latest.overlaps.length) {
      const offered = placements(rules, latest.overlaps, everyProject, rule?.id, buckets);
      setPlacing(offered);
      setPosition(
        offered.some((each) => each.position === editing.position) ? (editing.position ?? null) : null,
      );
      return;
    }
    await save(editing.position);
  };

  const project = everyProject.find((p) => p.id === projectId);

  if (placing) {
    return (
      <>
        <DialogHeader partNumber="RUL">
          <DialogTitle>Where does this Rule go?</DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3.5">
          <p className="m-0 text-row leading-[1.55] text-text">
            <b className="text-ink">{draft && ruleText(draft, everyProject, buckets)}</b> matches{' '}
            {kind === 'bucket' ? 'emails' : 'Items'} that{' '}
            {preview?.overlaps.length === 1 ? 'another Rule matches' : 'other Rules match'} too. The first
            match from the top wins, so choose its place.
          </p>
          <div role="radiogroup" aria-labelledby={ids.place} className="flex flex-col gap-1.5">
            <span id={ids.place} className={labelClass}>
              Where the Rule goes
            </span>
            {placing.map((placement) => (
              <label
                key={placement.position}
                className="flex cursor-pointer items-center gap-2 text-note leading-[19px] text-ink"
              >
                <input
                  type="radio"
                  name={ids.place}
                  checked={position === placement.position}
                  onChange={() => setPosition(placement.position)}
                  className="m-0 accent-(--ink)"
                />
                {placement.label}
              </label>
            ))}
          </div>
          {error && <ErrorLine id={ids.error}>{error}</ErrorLine>}
        </DialogBody>
        <DialogFooter>
          <Button onClick={() => setPlacing(null)}>Back</Button>
          <Button
            variant="primary"
            disabled={position === null || saving}
            onClick={() => position !== null && save(position)}
          >
            Save here
          </Button>
        </DialogFooter>
      </>
    );
  }

  return (
    <>
      <DialogHeader partNumber="RUL">
        <DialogTitle>{rule ? 'Edit Rule' : 'New Rule'}</DialogTitle>
      </DialogHeader>
      <DialogBody className="flex max-h-[min(70vh,640px)] flex-col gap-4 overflow-auto">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor={ids.kind} className={labelClass}>
              Target
            </label>
            <select
              id={ids.kind}
              value={kind}
              onChange={(event) => chooseKind(event.target.value as RuleTarget['kind'])}
              className={cn(selectClass, 'w-40')}
            >
              <option value="project">A Project</option>
              <option value="bucket">A Bucket (email)</option>
            </select>
          </div>
          {kind === 'project' ? (
            <>
              <div>
                <label htmlFor={ids.project} className={labelClass}>
                  Files into
                </label>
                <select
                  id={ids.project}
                  value={projectId}
                  onChange={(event) => setProjectId(event.target.value)}
                  className={cn(selectClass, 'w-56')}
                >
                  {!project && <option value="">Choose a Project…</option>}
                  {(project?.archived ? [...projects, project] : projects).map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.code} · {option.name}
                      {option.archived ? ' (archived)' : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex h-7.5 items-center" aria-hidden="true">
                {project ? <Badge code={project.code} accent={project.accent} /> : <Badge kind="unfiled" />}
              </div>
            </>
          ) : (
            <div>
              <label htmlFor={ids.bucket} className={labelClass}>
                Sorts into
              </label>
              <select
                id={ids.bucket}
                value={bucketId}
                onChange={(event) => setBucketId(event.target.value)}
                className={cn(selectClass, 'w-56')}
              >
                {!buckets.some((each) => each.id === bucketId) && <option value="">Choose a Bucket…</option>}
                {buckets.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div>
            <label htmlFor={ids.join} className={labelClass}>
              {kind === 'bucket' ? 'When an email matches' : 'When an Item matches'}
            </label>
            <select
              id={ids.join}
              value={when.join}
              onChange={(event) => setWhen({ ...when, join: event.target.value as WhenDraft['join'] })}
              className={selectClass}
            >
              <option value="and">all of these (AND)</option>
              <option value="or">any of these (OR)</option>
            </select>
          </div>
        </div>
        <Terms
          when={when}
          onChange={setWhen}
          items={items}
          values={values}
          accountNames={accountNames}
          kind={kind}
        />
        <MatchPreview preview={draft ? preview : null} projects={everyProject} buckets={buckets} />
        {error && <ErrorLine id={ids.error}>{error}</ErrorLine>}
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!draft || saving} onClick={submit}>
          Save Rule
        </Button>
      </DialogFooter>
    </>
  );
}

function ErrorLine({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} role="alert" className="m-0 text-note leading-[19px] font-semibold text-signal-ink">
      {children}
    </p>
  );
}

function Terms({
  when,
  onChange,
  items,
  values,
  accountNames,
  kind,
}: {
  when: WhenDraft;
  onChange: (when: WhenDraft) => void;
  items: readonly Item[];
  values: RuleValues;
  accountNames?: ReadonlyMap<string, string>;
  kind: RuleTarget['kind'];
}) {
  const setTerm = (index: number, term: TermDraft | null) => {
    const terms = when.terms.flatMap((each, i) => (i !== index ? [each] : term ? [term] : []));
    onChange({ ...when, terms });
  };
  const joinWord = when.join === 'and' ? 'AND' : 'OR';
  return (
    <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
      <legend className={labelClass}>Conditions · {JOIN_NAMES[when.join]} these</legend>
      <ol aria-label="Conditions" className="m-0 flex list-none flex-col gap-2 p-0">
        {when.terms.map((term, index) => {
          const no = String(index + 1);
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: conditions have no ids; their place is who they are
            <li key={index} className="flex flex-col gap-2">
              {index > 0 && (
                <span className="font-mono text-label font-semibold tracking-label text-muted">
                  {joinWord}
                </span>
              )}
              {isGroupDraft(term) ? (
                <fieldset
                  aria-label={`Group ${no}`}
                  className="m-0 flex min-w-0 flex-col gap-2 border border-line2 p-2.5"
                >
                  <div className="flex items-center gap-2">
                    <select
                      aria-label={`Group ${no} matches`}
                      value={term.join}
                      onChange={(event) =>
                        setTerm(index, { ...term, join: event.target.value as WhenDraft['join'] })
                      }
                      className={selectClass}
                    >
                      <option value="or">any of these (OR)</option>
                      <option value="and">all of these (AND)</option>
                    </select>
                    <span className="flex-1" />
                    <Button size="sm" variant="ghost" onClick={() => setTerm(index, null)}>
                      Remove group {no}
                    </Button>
                  </div>
                  {term.conditions.map((condition, inner) => {
                    const innerNo = `${no}.${inner + 1}`;
                    const setInner = (next: ConditionDraft | null) => {
                      const conditions = term.conditions.flatMap((each, i) =>
                        i !== inner ? [each] : next ? [next] : [],
                      );
                      setTerm(index, conditions.length ? { ...term, conditions } : null);
                    };
                    return (
                      <ConditionRow
                        // biome-ignore lint/suspicious/noArrayIndexKey: as above
                        key={inner}
                        no={innerNo}
                        condition={condition}
                        onChange={setInner}
                        items={items}
                        values={values}
                        accountNames={accountNames}
                        kind={kind}
                      />
                    );
                  })}
                  <div>
                    <Button
                      size="sm"
                      onClick={() =>
                        setTerm(index, {
                          ...term,
                          conditions: [
                            ...term.conditions,
                            newCondition(kind === 'bucket' ? 'gmail.domain' : 'linear.label'),
                          ],
                        })
                      }
                    >
                      Add condition to group {no}
                    </Button>
                  </div>
                </fieldset>
              ) : (
                <ConditionRow
                  no={no}
                  condition={term}
                  onChange={(next) => setTerm(index, next)}
                  items={items}
                  values={values}
                  accountNames={accountNames}
                  kind={kind}
                />
              )}
            </li>
          );
        })}
      </ol>
      <div className="flex gap-2">
        <Button
          size="sm"
          onClick={() => onChange({ ...when, terms: [...when.terms, newCondition(firstField(kind))] })}
        >
          Add condition
        </Button>
        <Button size="sm" onClick={() => onChange({ ...when, terms: [...when.terms, newGroup(kind)] })}>
          Add group
        </Button>
      </div>
    </fieldset>
  );
}

function ConditionRow({
  no,
  condition,
  onChange,
  items,
  values,
  accountNames,
  kind,
}: {
  no: string;
  condition: ConditionDraft;
  onChange: (condition: ConditionDraft | null) => void;
  items: readonly Item[];
  values: RuleValues;
  accountNames?: ReadonlyMap<string, string>;
  kind: RuleTarget['kind'];
}) {
  // A Bucket sorts email only, so its Rules offer only email's fields.
  const sources =
    kind === 'bucket' ? RULE_SOURCES.filter((source) => source.source === 'email') : RULE_SOURCES;
  const field = RULE_FIELDS.get(condition.field);
  const choices = useMemo(
    () => fieldChoices(items, condition.field, accountNames, values[condition.field]),
    [items, condition.field, accountNames, values],
  );
  // A value no held Item has any more (from an older Rule) is still offered, as the Rule has it.
  const offered =
    condition.value && !choices.some((choice) => choice.value === condition.value)
      ? [...choices, { value: condition.value, label: condition.label || condition.value }]
      : choices;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        aria-label={`Field ${no}`}
        value={condition.field}
        onChange={(event) => onChange(newCondition(event.target.value))}
        className={cn(selectClass, 'w-40')}
      >
        {sources.map((source) => (
          <optgroup key={source.source} label={source.name}>
            {source.fields.map((each) => (
              <option key={each.id} value={each.id}>
                {each.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <select
        aria-label={`Comparison ${no}`}
        value={condition.op}
        onChange={(event) => onChange({ ...condition, op: event.target.value as ConditionDraft['op'] })}
        className={cn(selectClass, 'w-28')}
      >
        {(field?.ops ?? ['is']).map((op) => (
          <option key={op} value={op}>
            {OPERATOR_NAMES[op]}
          </option>
        ))}
      </select>
      {condition.op === 'contains' ? (
        <Input
          aria-label={`Value ${no}`}
          value={condition.value}
          placeholder="Some text"
          autoComplete="off"
          onChange={(event) =>
            onChange({ ...condition, value: event.target.value, label: event.target.value })
          }
          className="w-56"
        />
      ) : (
        <select
          aria-label={`Value ${no}`}
          value={condition.value}
          onChange={(event) => {
            const choice = offered.find((each) => each.value === event.target.value);
            onChange({ ...condition, value: event.target.value, label: choice?.label ?? '' });
          }}
          className={cn(selectClass, 'w-56')}
        >
          <option value="">{offered.length ? 'Choose…' : 'No values yet'}</option>
          {offered.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </select>
      )}
      <Button size="sm" variant="ghost" onClick={() => onChange(null)} aria-label={`Remove condition ${no}`}>
        ×
      </Button>
    </div>
  );
}

function MatchPreview({
  preview,
  projects,
  buckets,
}: {
  preview: RulePreview | null;
  projects: readonly Project[];
  buckets: readonly Bucket[];
}) {
  return (
    <section aria-label="Matching Items" className="border border-line">
      <h3 className="m-0 flex h-7 items-center justify-between border-b border-line2 px-2.5 font-mono text-label leading-none font-semibold uppercase tracking-label text-ink">
        <span>
          {preview
            ? `Matches ${preview.count} Item${preview.count === 1 ? '' : 's'}`
            : 'Finish the conditions to see what they match'}
        </span>
      </h3>
      {preview && preview.sample.length > 0 && (
        <ul className="m-0 list-none p-0">
          {preview.sample.map((item) => (
            <li
              key={item.id}
              className="truncate border-b border-line2 px-2.5 py-1.5 text-note leading-[18px] text-text last:border-b-0"
            >
              {item.title}
            </li>
          ))}
        </ul>
      )}
      {preview && preview.overlaps.length > 0 && (
        <p className="m-0 border-t border-line2 px-2.5 py-1.5 text-note leading-[18px] text-muted">
          Also matched by {preview.overlaps.map((other) => ruleText(other, projects, buckets)).join('; ')}:
          you’ll choose its place when you save.
        </p>
      )}
    </section>
  );
}
