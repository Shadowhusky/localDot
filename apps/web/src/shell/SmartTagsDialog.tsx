import { DEFAULT_SMART_TAGS, type SmartTagOptions } from "@localdot/protocol";
import { type RefObject, useEffect, useRef, useState } from "react";
import {
  readSmartTagOptions,
  saveSmartTagOptions,
  sortConversations,
  undoSort,
  useRecentConversations,
} from "../agent/conversation-list.ts";
import { t, tr } from "../i18n/index.ts";
import { type ApiClient, ApiError } from "../lib/api.ts";
import { Button } from "../ui/Button.tsx";
import { Checkbox } from "../ui/Checkbox.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import { Progress } from "../ui/Progress.tsx";
import { RadioCards } from "../ui/RadioCards.tsx";
import { Switch } from "../ui/Switch.tsx";
import { showToast } from "../ui/Toast.tsx";
import "../ui/conversations-layout.css";

const PROBLEMS: Partial<Record<string, string>> = {
  "no-model": tr("Choose a model in Settings first."),
  busy: tr("dot is already sorting your conversations."),
  "no-answer": tr("Your model didn't answer. Try again."),
};

const SORT_TOAST = "sort-tags";

// "Tagged 16 of 42 conversations", or that the model is reading them, until its first answer.
const sortingWords = ({ done, total }: { done: number; total: number }) =>
  total
    ? t`Sorting ${done.toLocaleString()} of ${total.toLocaleString()} conversations…`
    : t`Your model is reading your conversations…`;

// Sorts the conversations into tags with the user's model, at once: how finely, whether it may make
// tags of its own, and which conversations; and whether each new one is tagged as it finishes.
// A sort only adds tags, and its toast takes it back.
export function SmartTagsDialog({
  api,
  open,
  onClose,
  anchor,
  model,
  unavailable,
}: {
  api: ApiClient;
  open: boolean;
  onClose(): void;
  anchor?: RefObject<HTMLElement | null>;
  // The model that answers, by name.
  model: string;
  // Why the user's model can't sort now.
  unavailable?: string;
}) {
  const { tags: library } = useRecentConversations(api, open);
  const [options, setOptions] = useState<SmartTagOptions>(DEFAULT_SMART_TAGS);
  const [untagged, setUntagged] = useState(true);
  // Under way: how far, once the first batch is answered.
  const [sorting, setSorting] = useState<{ done: number; total: number } | null>(null);
  const shown = useRef(open);
  shown.current = open;
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setProblem(null);
    const reading = new AbortController();
    readSmartTagOptions(api, reading.signal).then(setOptions, () => {});
    return () => reading.abort();
  }, [api, open]);
  // dot makes its own tags while the user has none.
  const create = options.create || !library.length;
  const sort = async () => {
    setSorting({ done: 0, total: 0 });
    setProblem(null);
    try {
      const result = await sortConversations(
        api,
        { scope: untagged ? "untagged" : "all", granularity: options.granularity, create },
        (progress) => {
          setSorting(progress);
          // Hidden, it goes on in a toast.
          if (!shown.current) showToast({ id: SORT_TOAST, title: sortingWords(progress) });
        },
      );
      if (shown.current) onClose();
      const made = result.created.map((tag) => tag.name).join(", ");
      showToast({
        id: SORT_TOAST,
        title:
          result.tagged === 0
            ? t`No conversations needed a tag`
            : result.tagged === 1
              ? t`Tagged 1 conversation`
              : t`Tagged ${result.tagged.toLocaleString()} conversations`,
        ...(made || result.incomplete
          ? {
              description: [
                made && t`New tags: ${made}`,
                result.incomplete && t`Your model stopped answering before the rest.`,
              ]
                .filter(Boolean)
                .join(" "),
            }
          : {}),
        ...(result.tagged > 0
          ? {
              action: {
                label: t`Undo`,
                onAction: () => {
                  undoSort(api, result.run).catch(() =>
                    showToast({ title: t`That sort can't be taken back now`, tone: "danger" }),
                  );
                },
              },
            }
          : {}),
      });
    } catch (error) {
      const why =
        (error instanceof ApiError && PROBLEMS[error.message.split("\n")[0] ?? ""]) ||
        t`The conversations couldn't be sorted. Try again.`;
      if (shown.current) setProblem(why);
      else showToast({ id: SORT_TOAST, title: why, tone: "danger" });
    } finally {
      setSorting(null);
    }
  };
  const remember = (next: SmartTagOptions) => {
    setOptions(next);
    saveSmartTagOptions(api, next).catch(() =>
      showToast({ title: t`That change couldn't be saved`, tone: "danger" }),
    );
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      {...(anchor ? { anchor } : {})}
      title={t`Sort into tags`}
      description={
        unavailable ?? t`${model} reads each conversation and gives it the one tag that fits.`
      }
      body={
        <div className="smart-tags">
          <RadioCards
            aria-label={t`How finely`}
            value={options.granularity}
            onValueChange={(granularity) =>
              setOptions({ ...options, granularity: granularity as SmartTagOptions["granularity"] })
            }
            options={[
              { value: "broad", label: t`Broad`, description: t`A few tags, each holding many` },
              {
                value: "balanced",
                label: t`Balanced`,
                description: t`A tag for each clear topic or project`,
              },
              {
                value: "detailed",
                label: t`Detailed`,
                description: t`Narrow tags, up to three on each`,
              },
            ]}
          />
          <Checkbox
            label={t`Make new tags`}
            description={t`Off, dot uses only the tags you made.`}
            checked={create}
            disabledReason={
              library.length ? undefined : t`You have no tags yet, so dot makes them.`
            }
            onCheckedChange={(checked) => setOptions({ ...options, create: checked })}
          />
          <Checkbox
            label={t`Only conversations without a tag`}
            description={t`Off, a conversation's tag may change to one that fits better.`}
            checked={untagged}
            onCheckedChange={setUntagged}
          />
          <Switch
            label={t`Tag new conversations as they finish`}
            description={t`Uses your model each time a task is done.`}
            checked={options.auto}
            onCheckedChange={(auto) => remember({ ...options, auto })}
          />
          {sorting && (
            <Progress
              label={t`Sorting`}
              {...(sorting.total ? { value: sorting.done, max: sorting.total } : {})}
              valueText={sortingWords(sorting)}
            />
          )}
          {sorting && <p className="smart-tags-progress num">{sortingWords(sorting)}</p>}
          {problem && (
            <p className="smart-tags-problem" role="alert">
              {problem}
            </p>
          )}
        </div>
      }
    >
      <Button
        variant="quiet"
        onClick={() => {
          onClose();
          if (sorting) showToast({ id: SORT_TOAST, title: sortingWords(sorting) });
        }}
      >
        {sorting ? t`Hide` : t`Cancel`}
      </Button>
      <Button
        variant="primary"
        disabledReason={unavailable ?? (sorting ? t`Sorting…` : undefined)}
        onClick={() => void sort()}
      >
        {sorting ? t`Sorting…` : t`Sort`}
      </Button>
    </Dialog>
  );
}
